export function safeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function validateBoard(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.cards) || value.cards.length > 1000) {
    throw new Error('看板数据格式不正确，请先保留本地草稿。');
  }
  const seen = new Set();
  const cards = value.cards.map(card => {
    if (!card || typeof card.id !== 'string' || !/^[\w-]{1,100}$/.test(card.id) || seen.has(card.id)) throw new Error('卡片编号重复或无效。');
    if (!['text', 'link'].includes(card.kind)) throw new Error('卡片类型无效。');
    seen.add(card.id);
    const normalized = {
      id: card.id, kind: card.kind,
      title: String(card.title || '').slice(0, 120),
      body: String(card.body || '').slice(0, 200000),
      url: String(card.url || '').slice(0, 4000),
      linkLabel: String(card.linkLabel || '').slice(0, 40),
    };
    if (card.bodySize === 'large') normalized.bodySize = 'large';
    return normalized;
  });
  return { schemaVersion: 1, revision: String(value.revision || ''), publishedAt: value.publishedAt || null, cards };
}

export const cardFingerprint = board => JSON.stringify(board.cards);
export const cloneBoard = board => structuredClone(board);

// Reconnecting must not replace the version against which a local draft was edited.
export function checkBaseline({ baseSha, baseRevision, baseFingerprint }, remote) {
  const conflict = () => ({ sha: baseSha, conflict: true });
  const missing = remote?.board === null && remote?.sha === null;
  if (baseSha === null) return missing ? { sha: null, conflict: false } : conflict();
  if (baseSha !== undefined) {
    return typeof baseSha === 'string' && baseSha.length > 0
      && remote?.board && remote.sha === baseSha
      ? { sha: baseSha, conflict: false }
      : conflict();
  }
  if (!remote?.board || !Array.isArray(remote.board.cards)
      || typeof remote.sha !== 'string' || !remote.sha
      || typeof baseRevision !== 'string' || !baseRevision
      || typeof baseFingerprint !== 'string'
      || remote.board.revision !== baseRevision
      || cardFingerprint(remote.board) !== baseFingerprint) return conflict();
  return { sha: remote.sha, conflict: false };
}

export function swapCards(cards, fromId, toId) {
  const from = cards.findIndex(card => card.id === fromId);
  const to = cards.findIndex(card => card.id === toId);
  if (from < 0 || to < 0 || from === to) return [...cards];
  const result = [...cards];
  [result[from], result[to]] = [result[to], result[from]];
  return result;
}

export function inferConfig(locationLike, config = {}) {
  const result = { owner: '', repo: '', branch: 'main', path: 'data/board.json', siteUrl: '', ...config };
  const match = locationLike.hostname?.match(/^([\w-]+)\.github\.io$/i);
  if (!result.owner && match) result.owner = match[1];
  if (!result.repo && match) result.repo = locationLike.pathname.split('/').filter(Boolean)[0] || `${match[1]}.github.io`;
  if (!result.siteUrl) result.siteUrl = new URL('./', locationLike.href).href;
  return result;
}
