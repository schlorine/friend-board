import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, validateBoard, swapCards, inferConfig, cardFingerprint, checkBaseline } from '../scripts/model.js';

test('only credential-free http(s) URLs are allowed', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,boom', '//bad.example', 'https://secret:pw@example.com', 'file:///etc/passwd']) assert.equal(safeUrl(url), '');
  assert.equal(safeUrl('https://example.com/path?q=中文'), 'https://example.com/path?q=%E4%B8%AD%E6%96%87');
});
test('duplicate card ids and unsupported schemas cannot overwrite a board', () => {
  const card = { id: 'one', kind: 'text', title: '文字', body: '<p>正文</p>' };
  assert.throws(() => validateBoard({ schemaVersion: 1, cards: [card, card] }));
  assert.throws(() => validateBoard({ schemaVersion: 2, cards: [] }));
});
test('body size survives reload while older cards keep their draft baseline', () => {
  const card = { id: 'one', kind: 'text', title: '标题', body: '<p>正文</p>', url: '', linkLabel: '' };
  const older = { schemaVersion: 1, cards: [card] };
  assert.equal(cardFingerprint(validateBoard(older)), cardFingerprint(older));
  const larger = { schemaVersion: 1, cards: [{ ...card, bodySize: 'large' }] };
  assert.equal(validateBoard(larger).cards[0].bodySize, 'large');
});
test('swapping preserves every card and swaps only the two selected positions', () => {
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(swapCards(cards, 'a', 'c').map(card => card.id), ['c', 'b', 'a']);
  assert.deepEqual(cards.map(card => card.id), ['a', 'b', 'c']);
});
test('Pages repository subpaths are preserved and only content changes are dirty', () => {
  const config = inferConfig(new URL('https://someone.github.io/board/'), {});
  assert.equal(config.owner, 'someone');
  assert.equal(config.repo, 'board');
  assert.equal(config.siteUrl, 'https://someone.github.io/board/');
  assert.equal(cardFingerprint({ revision: 'one', cards: [] }), cardFingerprint({ revision: 'two', cards: [] }));
});

const boardAtBaseline = {
  schemaVersion: 1, revision: 'published-one', publishedAt: '2026-11-10T08:00:00.000Z',
  cards: [{ id: 'first', kind: 'text', title: '原来的标题', body: '<p>正文</p>', url: '', linkLabel: '' }],
};
const baseline = {
  baseSha: undefined,
  baseRevision: boardAtBaseline.revision,
  baseFingerprint: cardFingerprint(boardAtBaseline),
};

test('first SHA lookup accepts only the exact revision and content used for the draft', () => {
  const remote = { board: structuredClone(boardAtBaseline), sha: 'first-sha' };
  assert.deepEqual(checkBaseline(baseline, remote), { sha: 'first-sha', conflict: false });
  assert.deepEqual(baseline.baseSha, undefined);
  assert.deepEqual(remote.board, boardAtBaseline);
});

test('preserving revision while changing remote content cannot refresh the draft baseline', () => {
  const changed = structuredClone(boardAtBaseline);
  changed.cards[0].title = '其他设备改过的标题';
  assert.deepEqual(checkBaseline(baseline, { board: changed, sha: 'new-sha' }), { sha: undefined, conflict: true });
  assert.deepEqual(checkBaseline({ ...baseline, baseSha: 'old-sha' }, { board: changed, sha: 'new-sha' }),
    { sha: 'old-sha', conflict: true });
});

test('a known SHA must match exactly even when revision and cards look unchanged', () => {
  const known = { ...baseline, baseSha: 'known-sha' };
  assert.deepEqual(checkBaseline(known, { board: boardAtBaseline, sha: 'known-sha' }),
    { sha: 'known-sha', conflict: false });
  assert.deepEqual(checkBaseline(known, { board: boardAtBaseline, sha: 'different-sha' }),
    { sha: 'known-sha', conflict: true });
});

test('a deleted remote file never turns an existing draft into a first creation', () => {
  const missing = { board: null, sha: null };
  assert.deepEqual(checkBaseline({ ...baseline, baseSha: 'old-sha' }, missing), { sha: 'old-sha', conflict: true });
  assert.deepEqual(checkBaseline(baseline, missing), { sha: undefined, conflict: true });
  assert.deepEqual(checkBaseline({ baseSha: undefined, baseRevision: '', baseFingerprint: '' }, missing),
    { sha: undefined, conflict: true });
});

test('explicit null baseline allows creation only while the remote file remains absent', () => {
  const newFile = { baseSha: null, baseRevision: '', baseFingerprint: '' };
  assert.deepEqual(checkBaseline(newFile, { board: null, sha: null }), { sha: null, conflict: false });
  assert.deepEqual(checkBaseline(newFile, { board: boardAtBaseline, sha: 'created-elsewhere' }),
    { sha: null, conflict: true });
});

test('an unknown SHA cannot accept another revision or incomplete baseline metadata', () => {
  assert.deepEqual(checkBaseline(baseline, { board: { ...boardAtBaseline, revision: 'newer' }, sha: 'new-sha' }),
    { sha: undefined, conflict: true });
  assert.deepEqual(checkBaseline({ baseSha: undefined }, { board: boardAtBaseline, sha: 'new-sha' }),
    { sha: undefined, conflict: true });
});
