import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError, fetchBoard, verifyRepository, publishBoard, waitForLive } from '../scripts/github.js';

const config = { owner: 'a-friend', repo: 'friend-board', branch: 'main', path: 'data/board.json', siteUrl: '' };
const makeBoard = revision => ({
  schemaVersion: 1,
  revision,
  publishedAt: '2026-11-10T08:00:00.000Z',
  cards: [{ id: 'card-1', kind: 'link', title: '朋友的收藏 ✨', body: '<p>中文、🧡、<b>有用</b></p>', url: 'https://example.com/资源', linkLabel: '去看看', color: '#ffe37a' }],
});
const file = (board, sha = 'old-sha') => ({
  type: 'file', encoding: 'base64', sha,
  content: Buffer.from(JSON.stringify(board), 'utf8').toString('base64').match(/.{1,60}/g).join('\n'),
});
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

test('fetchBoard decodes Unicode and preserves card metadata', async () => {
  const board = makeBoard('中文-1');
  const result = await fetchBoard(config, 'session-token', { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/a-friend/friend-board/contents/data/board.json?ref=main');
    assert.equal(init.headers.Authorization, 'Bearer session-token');
    assert.equal(init.cache, 'no-store');
    return json(file(board));
  } });
  assert.deepEqual(result, { board, sha: 'old-sha' });
});

test('fetchBoard supports a missing initial file and does not require a visitor token', async () => {
  const result = await fetchBoard(config, '', { fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return json({ message: 'Not Found' }, 404);
  } });
  assert.deepEqual(result, { board: null, sha: null });
});

test('HTTP failures and network failures do not expose response or transport secrets', async () => {
  await assert.rejects(fetchBoard(config, 'very-secret-token', {
    fetchImpl: async () => json({ message: 'very-secret-token' }, 401),
  }), error => error instanceof GitHubError && error.status === 401 && error.kind === 'auth'
    && !String(error).includes('very-secret-token'));
  await assert.rejects(fetchBoard(config, 'very-secret-token', {
    fetchImpl: async () => { throw new Error('Bearer very-secret-token'); },
  }), error => error.kind === 'network' && !String(error).includes('very-secret-token'));
  await assert.rejects(fetchBoard(config, '', {
    fetchImpl: async () => json({}, 403, { 'x-ratelimit-remaining': '0' }),
  }), error => error.kind === 'rate_limit');
});

test('fetchBoard rejects malformed cloud data', async () => {
  await assert.rejects(fetchBoard(config, '', { fetchImpl: async () => json({ encoding: 'base64', sha: 'a', content: '%%%invalid%%%' }) }),
    error => error.kind === 'invalid_data');
});

test('verifyRepository requires a public repository and push permission', async () => {
  const info = { private: false, visibility: 'public', permissions: { push: true } };
  assert.deepEqual(await verifyRepository({ ...config, fetchImpl: async () => json(info) }, 'token'), info);
  await assert.rejects(verifyRepository({ ...config, fetchImpl: async () => json({ ...info, private: true }) }, 'token'),
    error => error.kind === 'private_repository');
  await assert.rejects(verifyRepository({ ...config, fetchImpl: async () => json({ ...info, permissions: { push: false } }) }, 'token'),
    error => error.kind === 'permission');
});

test('stale expected SHA prevents any PUT and preserves the submitted board', async () => {
  const board = makeBoard('draft');
  const original = structuredClone(board);
  const calls = [];
  await assert.rejects(publishBoard({ ...config, fetchImpl: async (_, init) => {
    calls.push(init.method);
    return json(file(makeBoard('new-remote'), 'changed-sha'));
  } }, 'token', board, 'old-sha'), error => error.kind === 'conflict' && error.status === 409);
  assert.deepEqual(calls, ['GET']);
  assert.deepEqual(board, original);
});

test('a deleted cloud file cannot be recreated using an existing-file SHA', async () => {
  const calls = [];
  await assert.rejects(publishBoard({ ...config, fetchImpl: async (_, init) => {
    calls.push(init.method);
    return json({}, 404);
  } }, 'token', makeBoard('draft'), 'old-sha'), error => error.kind === 'conflict');
  assert.deepEqual(calls, ['GET']);
});

test('publishing a new file requires explicit null baseline and still checks for a conflict', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json(file(makeBoard('remote'))); };
  await assert.rejects(publishBoard({ ...config, fetchImpl }, 'token', makeBoard('draft'), undefined),
    error => error.kind === 'conflict');
  assert.equal(calls, 0);
  await assert.rejects(publishBoard({ ...config, fetchImpl }, 'token', makeBoard('draft'), null),
    error => error.kind === 'conflict');
  assert.equal(calls, 1);
});

test('successful publish writes Unicode JSON with the exact expected SHA and branch', async () => {
  const board = makeBoard('发布-2');
  const calls = [];
  const result = await publishBoard({ ...config, fetchImpl: async (url, init) => {
    calls.push(init.method);
    if (init.method === 'GET') return json(file(makeBoard('old')));
    assert.equal(url, 'https://api.github.com/repos/a-friend/friend-board/contents/data/board.json');
    const payload = JSON.parse(init.body);
    assert.equal(payload.sha, 'old-sha');
    assert.equal(payload.branch, 'main');
    assert.deepEqual(JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')), board);
    return json({ commit: { sha: 'commit-2' }, content: { sha: 'new-content-sha' } }, 200);
  } }, 'token', board, 'old-sha');
  assert.deepEqual(calls, ['GET', 'PUT']);
  assert.deepEqual(result, { commitSha: 'commit-2', contentSha: 'new-content-sha', board });
});

test('publish snapshots the board before awaiting the network', async () => {
  const board = makeBoard('before');
  const result = await publishBoard({ ...config, fetchImpl: async (_, init) => {
    if (init.method === 'GET') {
      board.cards[0].title = 'edited during publication';
      return json(file(makeBoard('old')));
    }
    return json({ commit: { sha: 'commit' }, content: { sha: 'content' } });
  } }, 'token', board, 'old-sha');
  assert.equal(result.board.cards[0].title, '朋友的收藏 ✨');
  assert.equal(board.cards[0].title, 'edited during publication');
});

test('new files omit SHA and a server-side race remains a conflict', async () => {
  let put = false;
  const fetchImpl = async (_, init) => {
    if (init.method === 'GET') return json({}, 404);
    put = true;
    assert.equal(Object.hasOwn(JSON.parse(init.body), 'sha'), false);
    return json({ message: 'conflict' }, 409);
  };
  await assert.rejects(publishBoard({ ...config, fetchImpl }, 'token', makeBoard('new'), null),
    error => error.kind === 'conflict');
  assert.equal(put, true);
});

test('invalid link schemes never reach GitHub', async () => {
  const board = makeBoard('new');
  board.cards[0].url = 'javascript:alert(1)';
  let called = false;
  await assert.rejects(publishBoard({ ...config, fetchImpl: async () => { called = true; } }, 'token', board, null),
    error => error.kind === 'invalid_data');
  assert.equal(called, false);
});

test('waitForLive waits for the revision and resolves inside the project subdirectory', async () => {
  let calls = 0;
  const pending = [];
  const board = makeBoard('live/rev?中文');
  const result = await waitForLive({ ...config, siteUrl: 'https://example.com/some/board' }, board.revision, {
    intervalMs: 0, timeoutMs: 1000,
    onPending: value => pending.push(value),
    fetchImpl: async (url, init) => {
      calls += 1;
      const requestUrl = new URL(url);
      assert.equal(requestUrl.pathname, '/some/board/data/board.json');
      assert.equal(requestUrl.searchParams.get('rev'), board.revision);
      assert.equal(init.cache, 'no-store');
      assert.equal(init.headers.Authorization, undefined);
      return json(calls === 1 ? makeBoard('stale') : board);
    },
  });
  assert.equal(calls, 2);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'waiting');
  assert.deepEqual(result.board, board);
});

test('waitForLive defaults to GitHub Pages, including account root sites', async () => {
  for (const [repo, pathname] of [['friend-board', '/friend-board/data/board.json'], ['a-friend.github.io', '/data/board.json']]) {
    await waitForLive({ ...config, repo }, 'live', { fetchImpl: async url => {
      assert.equal(new URL(url).hostname, 'a-friend.github.io');
      assert.equal(new URL(url).pathname, pathname);
      return json(makeBoard('live'));
    } });
  }
});

test('waitForLive accepts an index.html site URL and rejects unsafe protocols', async () => {
  await waitForLive({ ...config, siteUrl: 'https://example.com/board/index.html?old=1#card' }, 'live', {
    fetchImpl: async url => {
      assert.equal(new URL(url).pathname, '/board/data/board.json');
      assert.equal(new URL(url).searchParams.has('old'), false);
      return json(makeBoard('live'));
    },
  });
  for (const siteUrl of ['javascript:alert(1)', 'data:application/json,{}', 'file:///board', 'https://user:pass@example.com/']) {
    await assert.rejects(waitForLive({ ...config, siteUrl }, 'live', { fetchImpl: async () => assert.fail('must not fetch') }),
      error => error.kind === 'config');
  }
});

test('waitForLive retries 404 and network failures until the deployment arrives', async () => {
  let calls = 0;
  await waitForLive(config, 'ready', {
    intervalMs: 0, timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return json({}, 404);
      if (calls === 2) throw new Error('offline');
      return json(makeBoard('ready'));
    },
  });
  assert.equal(calls, 3);
});

test('waitForLive times out without treating a stale board as published', async () => {
  await assert.rejects(waitForLive(config, 'future', {
    intervalMs: 1, timeoutMs: 15, fetchImpl: async () => json(makeBoard('old')),
  }), error => error instanceof GitHubError && error.kind === 'timeout' && error.message.includes('无需重复发布'));
});

test('a slow live response cannot succeed after the waiting deadline', async () => {
  await assert.rejects(waitForLive(config, 'live', {
    timeoutMs: 5,
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return json(makeBoard('live'));
    },
  }), error => error.kind === 'timeout');
});

test('waitForLive can be cancelled before or during polling', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(waitForLive(config, 'future', { signal: before.signal }), error => error.kind === 'aborted');
  const controller = new AbortController();
  await assert.rejects(waitForLive(config, 'future', {
    intervalMs: 1000, timeoutMs: 1000, signal: controller.signal,
    fetchImpl: async () => json(makeBoard('old')),
    onPending: () => controller.abort(),
  }), error => error.kind === 'aborted');
});
