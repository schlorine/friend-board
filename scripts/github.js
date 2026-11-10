const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_PATH = 'data/board.json';

export class GitHubError extends Error {
  constructor(message, { status = 0, kind = 'http', retryAfter = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
    if (retryAfter !== null) this.retryAfter = retryAfter;
  }
}

function configuration(config) {
  if (!config || typeof config !== 'object') {
    throw new GitHubError('请先填写 GitHub 仓库信息。', { kind: 'config' });
  }
  const owner = typeof config.owner === 'string' ? config.owner.trim() : '';
  const repo = typeof config.repo === 'string' ? config.repo.trim() : '';
  const branch = config.branch ?? 'main';
  const path = config.path ?? DEFAULT_PATH;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)
      || owner === '.' || owner === '..' || repo === '.' || repo === '..'
      || typeof branch !== 'string' || !branch.trim()
      || typeof path !== 'string' || !path
      || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new GitHubError('GitHub 仓库、分支或数据路径格式不正确。', { kind: 'config' });
  }
  return { ...config, owner, repo, branch, path };
}

function fetcher(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new GitHubError('当前环境无法连接 GitHub。', { kind: 'config' });
  }
  return fetchImpl;
}

function authorization(token, required = false) {
  if (typeof token !== 'string' || /[\r\n]/.test(token) || (required && !token.trim())) {
    throw new GitHubError('请输入有效的 GitHub 访问令牌。', { kind: 'auth' });
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function repositoryUrl(config) {
  return `${API_ROOT}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function contentsUrl(config, includeRef = true) {
  const path = config.path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${repositoryUrl(config)}/contents/${path}`);
  if (includeRef) url.searchParams.set('ref', config.branch);
  return url.toString();
}

function aborted() {
  return new GitHubError('已取消等待。', { kind: 'aborted' });
}

function httpError(response) {
  const status = response.status;
  const retryAfter = response.headers?.get?.('retry-after') ?? null;
  const rateLimited = status === 429
    || (status === 403 && (retryAfter !== null || response.headers?.get?.('x-ratelimit-remaining') === '0'));
  if (rateLimited) {
    return new GitHubError('GitHub 请求过于频繁，请稍后重试；本地草稿仍然保留。', {
      status, kind: 'rate_limit', retryAfter,
    });
  }
  if (status === 409) {
    return new GitHubError('云端内容已有变化，请先重新读取，再决定如何发布；本地草稿仍然保留。', {
      status, kind: 'conflict',
    });
  }
  if (status === 401) return new GitHubError('GitHub 令牌无效或已过期，请重新输入。', { status, kind: 'auth' });
  if (status === 403) return new GitHubError('没有仓库写入权限，请检查令牌及仓库权限。', { status, kind: 'permission' });
  if (status === 404) return new GitHubError('未找到仓库或文件，请检查配置及令牌权限。', { status, kind: 'not_found' });
  return new GitHubError(`GitHub 请求失败（${status}）；本地草稿仍然保留。`, { status });
}

async function request(fetchImpl, url, init = {}) {
  try {
    return await fetchImpl(url, init);
  } catch {
    if (init.signal?.aborted) throw aborted();
    // Do not copy transport errors: they can contain request headers or credentials.
    throw new GitHubError('暂时无法连接 GitHub，请检查网络后重试；本地草稿仍然保留。', { kind: 'network' });
  }
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new GitHubError('GitHub 返回的数据无法读取。', { status: response.status, kind: 'invalid_data' });
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateBoard(board) {
  const valid = board && typeof board === 'object' && board.schemaVersion === 1
    && typeof board.revision === 'string' && board.revision.length > 0
    && typeof board.publishedAt === 'string' && Number.isFinite(Date.parse(board.publishedAt))
    && Array.isArray(board.cards)
    && board.cards.every(card => card && typeof card === 'object'
      && typeof card.id === 'string' && card.id.length > 0
      && (card.kind === 'text' || card.kind === 'link')
      && typeof card.title === 'string' && typeof card.body === 'string'
      && (card.url === undefined || typeof card.url === 'string')
      && (card.linkLabel === undefined || typeof card.linkLabel === 'string')
      && (card.kind !== 'link' || isHttpUrl(card.url)));
  if (!valid || new Set(board.cards.map(card => card.id)).size !== board.cards.length) {
    throw new GitHubError('卡片数据格式不正确，请检查内容后重试。', { kind: 'invalid_data' });
  }
  return board;
}

function encodeContent(board) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(board, null, 2)}\n`);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeContent(content) {
  try {
    const binary = atob(content.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return validateBoard(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError('云端卡片数据无法读取，请检查数据文件。', { kind: 'invalid_data' });
  }
}

/** Read the configured data file. A missing file is represented by a null SHA. */
export async function fetchBoard(config, token = '', options = {}) {
  const settings = configuration(config);
  const response = await request(fetcher(settings, options), contentsUrl(settings), {
    method: 'GET',
    headers: authorization(token),
    cache: 'no-store',
    signal: options.signal,
  });
  if (response.status === 404) return { board: null, sha: null };
  if (!response.ok) throw httpError(response);
  const file = await responseJson(response);
  if (file?.encoding !== 'base64' || typeof file.content !== 'string'
      || typeof file.sha !== 'string' || !file.sha) {
    throw new GitHubError('云端数据不是可读取的卡片文件。', { kind: 'invalid_data' });
  }
  return { board: decodeContent(file.content), sha: file.sha };
}

/** Confirm that this is a public repository and this token can push to it. */
export async function verifyRepository(config, token) {
  const settings = configuration(config);
  const response = await request(fetcher(settings), repositoryUrl(settings), {
    method: 'GET', headers: authorization(token, true), cache: 'no-store',
  });
  if (!response.ok) throw httpError(response);
  const repository = await responseJson(response);
  if (repository?.private !== false || (repository.visibility && repository.visibility !== 'public')) {
    throw new GitHubError('请使用公开仓库，方便所有访客阅读发布后的内容。', { kind: 'private_repository' });
  }
  if (repository.permissions?.push !== true) {
    throw new GitHubError('当前令牌没有仓库写入权限，请授予指定仓库 Contents 读写权限。', { kind: 'permission' });
  }
  return repository;
}

/** Publish only if the remote SHA still matches the version the author edited. */
export async function publishBoard(config, token, board, expectedSha) {
  const settings = configuration(config);
  const headers = authorization(token, true);
  if (expectedSha !== null && (typeof expectedSha !== 'string' || !expectedSha)) {
    throw new GitHubError('缺少发布基准，请先读取云端版本。', { kind: 'conflict' });
  }
  validateBoard(board);
  // Serialize before any await so edits during publishing cannot change this snapshot.
  const content = encodeContent(board);
  const snapshot = decodeContent(content);
  const remote = await fetchBoard(settings, token);
  if (remote.sha !== expectedSha) {
    throw new GitHubError('云端内容已有变化，请先重新读取，再决定如何发布；本地草稿仍然保留。', {
      status: 409, kind: 'conflict',
    });
  }
  const payload = {
    message: `Publish board ${snapshot.revision}`,
    content,
    branch: settings.branch,
  };
  if (expectedSha !== null) payload.sha = expectedSha;
  const response = await request(fetcher(settings), contentsUrl(settings, false), {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw httpError(response);
  const result = await responseJson(response);
  if (typeof result?.commit?.sha !== 'string' || !result.commit.sha
      || typeof result?.content?.sha !== 'string' || !result.content.sha) {
    throw new GitHubError('发布响应无法确认，请重新读取云端版本后检查发布结果。', { kind: 'invalid_data' });
  }
  return { commitSha: result.commit.sha, contentSha: result.content.sha, board: snapshot };
}

function liveDataUrl(settings, revision) {
  const defaultSite = settings.repo.toLowerCase() === `${settings.owner.toLowerCase()}.github.io`
    ? `https://${settings.owner}.github.io/`
    : `https://${settings.owner}.github.io/${encodeURIComponent(settings.repo)}/`;
  const siteUrl = settings.siteUrl || defaultSite;
  if (!isHttpUrl(siteUrl)) {
    throw new GitHubError('网站地址必须是完整的 http 或 https 地址。', { kind: 'config' });
  }
  const base = new URL(siteUrl);
  base.hash = '';
  base.search = '';
  if (/\/[^/]+\.html?$/i.test(base.pathname)) {
    base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  } else if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }
  const url = new URL(settings.path.split('/').map(encodeURIComponent).join('/'), base);
  url.searchParams.set('rev', revision);
  return url.toString();
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A commit is live only when the deployed JSON exposes this exact revision. */
export async function waitForLive(config, revision, {
  signal, onPending, fetchImpl, intervalMs = 1500, timeoutMs = 180000,
} = {}) {
  const settings = configuration(config);
  if (typeof revision !== 'string' || !revision
      || !Number.isFinite(intervalMs) || intervalMs < 0
      || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new GitHubError('上线检查参数不正确。', { kind: 'config' });
  }
  if (signal?.aborted) throw aborted();
  const url = liveDataUrl(settings, revision);
  const read = fetcher(settings, { fetchImpl });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const timeoutError = () => new GitHubError('内容已提交，网站尚未确认上线。可以稍后继续检查；无需重复发布。', { kind: 'timeout' });
  let attempt = 0;
  try {
    while (true) {
      if (signal?.aborted) throw aborted();
      if (timedOut || Date.now() - startedAt >= timeoutMs) throw timeoutError();
      attempt += 1;
      let status = 0;
      let reason = 'network';
      try {
        const response = await read(url, {
          method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        status = response.status;
        reason = 'unavailable';
        if (response.ok) {
          try {
            const board = validateBoard(await response.json());
            if (board.revision === revision && !signal?.aborted
                && !timedOut && Date.now() - startedAt < timeoutMs) return { board, url };
            reason = 'waiting';
          } catch {
            reason = 'invalid_data';
          }
        }
      } catch {
        reason = 'network';
      }
      if (signal?.aborted) throw aborted();
      if (timedOut || Date.now() - startedAt >= timeoutMs) throw timeoutError();
      onPending?.({ attempt, elapsedMs: Date.now() - startedAt, status, reason });
      try {
        await pause(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))), controller.signal);
      } catch {
        if (signal?.aborted) throw aborted();
        throw timeoutError();
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
