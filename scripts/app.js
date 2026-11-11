import { safeUrl, validateBoard, cloneBoard, cardFingerprint, swapCards, inferConfig, checkBaseline } from './model.js';
import { fetchBoard, verifyRepository, publishBoard, waitForLive } from './github.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const storePrefix = `a-little-board:v1:${location.origin}${new URL('./', location.href).pathname}`;
const DRAFT_KEY = `${storePrefix}:draft`;
const CONFIG_KEY = `${storePrefix}:config`;
let config, published, working, baseRevision = '', baseSha;
let baseFingerprint = '', isAdmin = false, token = '', connected = false, busy = false;
let storageOK = true, editingId = null, isNewCard = false, currentId = null, quill, editorLoading = false;
let savedLinkRange = null, pendingDeployment = null, deploymentController = null, conflict = false;
let toastTimer, dragState = null, clickSuppressedUntil = 0, undoDeletion = null;
let storageConflict = false;

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); storageOK = true; return true; }
  catch { storageOK = false; return false; }
}
function isDirty() { return Boolean(working && cardFingerprint(working) !== baseFingerprint); }
function persist() {
  if (!working) return;
  if (storageConflict) { updateStatus(); return; }
  const ok = writeStorage(DRAFT_KEY, {
    version: 1, board: working, baseRevision, baseSha, baseFingerprint,
    pendingDeployment, conflict, savedAt: new Date().toISOString(),
  });
  if (!ok) toast('浏览器暂时无法保存草稿，请勿关闭页面；可在发布窗口下载备份。');
  updateStatus();
}
function toast(message, actionLabel = '', action = null) {
  clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  $('toast-action').hidden = !actionLabel;
  $('toast-action').textContent = actionLabel;
  $('toast-action').onclick = action;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, actionLabel ? 11000 : 5500);
}
function setError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function closeDialog(id) { if ($(id).open) $(id).close(); }

// A small allowlist keeps stored rich text inert, even when content is changed outside the editor.
function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const allowed = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
  const drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'LINK', 'META']);
  function clean(parent) {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (drop.has(node.tagName)) { node.remove(); continue; }
      clean(node);
      if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
      const href = node.tagName === 'A' ? safeUrl(node.getAttribute('href')) : '';
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if (node.tagName === 'A') {
        if (!href) { node.replaceWith(...node.childNodes); continue; }
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  clean(doc.body);
  return doc.body.innerHTML;
}
function plainText(html) {
  const doc = new DOMParser().parseFromString(sanitizeHTML(html), 'text/html');
  for (const node of doc.querySelectorAll('p,li,br')) node.append(doc.createTextNode('\n'));
  return doc.body.textContent.trim();
}
function contentful(card) { return Boolean(card.title.trim() || plainText(card.body) || (card.kind === 'link' && card.url.trim())); }
function displayTitle(card) { return card.title.trim() || '无标题'; }
function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderBoard() {
  const board = isAdmin ? working : published;
  if (!board) return;
  const grid = $('board-grid');
  grid.replaceChildren();
  board.cards.forEach((card, index) => {
    const article = makeElement('article', `card card-${card.kind}`);
    article.dataset.id = card.id;
    article.tabIndex = 0;
    article.setAttribute('aria-label', `${card.kind === 'link' ? '链接' : '文字'}卡片：${displayTitle(card)}，展开阅读`);
    article.setAttribute('aria-haspopup', 'dialog');
    const top = makeElement('div', 'card-top');
    top.append(makeElement('span', 'card-type', card.kind === 'link' ? '链接 ↗' : '文字'));
    if (isAdmin) {
      const handle = makeElement('button', 'drag-handle', '⠿');
      handle.type = 'button';
      handle.setAttribute('aria-label', `移动卡片：${displayTitle(card)}。按空格选取，再用方向键交换位置`);
      handle.title = '拖动交换位置；也可按空格后使用方向键';
      handle.addEventListener('pointerdown', event => startDrag(event, card.id, article));
      handle.addEventListener('click', event => event.stopPropagation());
      handle.addEventListener('keydown', event => keyboardMove(event, card.id, handle));
      top.append(handle);
    }
    article.append(top, makeElement('h2', 'card-title', displayTitle(card)), makeElement('p', 'card-preview', plainText(card.body)));
    const bottom = makeElement('div', 'card-bottom');
    bottom.append(makeElement('span', 'card-index', String(index + 1).padStart(2, '0')));
    const url = card.kind === 'link' ? safeUrl(card.url) : '';
    if (url) {
      const link = makeElement('a', 'card-link-action', `${card.linkLabel.trim() || '访问网站'} ↗`);
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${card.linkLabel.trim() || '访问网站'}：${displayTitle(card)}（新标签页）`);
      link.addEventListener('click', event => event.stopPropagation());
      bottom.append(link);
    } else bottom.append(makeElement('span', 'card-open', '展开阅读 +'));
    article.append(bottom);
    article.addEventListener('click', () => { if (Date.now() > clickSuppressedUntil && !busy) openReader(card.id); });
    article.addEventListener('keydown', event => {
      if (event.target === article && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openReader(card.id); }
    });
    grid.append(article);
  });
  if (isAdmin) {
    const add = makeElement('button', 'add-card');
    add.type = 'button'; add.setAttribute('aria-label', '新建卡片');
    add.append(makeElement('span', 'plus-mark', '+'), makeElement('span', 'add-label', '留一格新的'), makeElement('span', 'add-hint', '写点文字，或分享一个链接'));
    add.addEventListener('click', () => { if (!busy) openEditor(null); });
    grid.append(add);
  } else if (!board.cards.length) {
    const empty = makeElement('div', 'empty-state');
    empty.append(makeElement('h3', '', '好东西，慢慢收集。'), makeElement('p', '', '这里暂时还没有卡片，过一阵再来看看。'));
    grid.append(empty);
  }
  grid.setAttribute('aria-busy', 'false');
}
function updateStatus(message) {
  const dirty = isDirty();
  const confirmedLive = published.revision === baseRevision && cardFingerprint(published) === baseFingerprint;
  const state = message || (busy ? '正在提交' : conflict ? '有版本差异' : dirty ? '有未发布修改' : pendingDeployment ? '等待上线' : connected ? (confirmedLive ? '已上线' : '已连接') : '本地编辑');
  $('publish-status').textContent = state;
  $('publish-status').dataset.state = dirty || conflict ? 'dirty' : busy || pendingDeployment ? 'pending' : 'ready';
  $('publish-button').disabled = busy || Boolean(deploymentController) || (!dirty && !pendingDeployment && !conflict);
  $('publish-button').textContent = pendingDeployment ? '检查上线 ↗' : conflict ? '处理版本差异 ↗' : '发布更改 ↗';
  $('publish-status').hidden = !isAdmin;
  $('board-notice').hidden = !isAdmin || (!conflict && storageOK && !storageConflict);
  $('board-notice').textContent = storageConflict ? '另一个窗口更新了草稿。本窗口的后续修改暂不覆盖保存，请下载备份后重新载入。' : !storageOK ? '本地保存暂不可用，请保留此页面并备份草稿。' : '云端已有更新，本地草稿已保留。发布前请在发布窗口备份并读取新版。';
}
function setAdmin(enabled) {
  isAdmin = enabled;
  document.body.classList.toggle('is-admin', enabled);
  for (const id of ['publish-status', 'settings-button', 'publish-button', 'leave-admin']) $(id).hidden = !enabled;
  $('admin-trigger').textContent = enabled ? '发布设置 ↗' : '管理看板 ↗';
  renderBoard(); updateStatus();
}
function openReader(id) {
  const card = (isAdmin ? working : published).cards.find(card => card.id === id);
  if (!card) return;
  currentId = id;
  $('reader-dialog').dataset.kind = card.kind;
  $('reader-kind').textContent = card.kind === 'link' ? 'LINK / 链接' : 'NOTE / 文字';
  $('reader-title').textContent = displayTitle(card);
  $('reader-body').innerHTML = sanitizeHTML(card.body);
  const url = card.kind === 'link' ? safeUrl(card.url) : '';
  $('reader-link').hidden = !url;
  if (url) { $('reader-link').href = url; $('reader-link').textContent = `${card.linkLabel.trim() || '访问网站'} ↗`; }
  else $('reader-link').removeAttribute('href');
  $('reader-admin-actions').hidden = !isAdmin;
  openDialog('reader-dialog');
}
function initEditor() {
  if (quill) return;
  if (!window.Quill) throw new Error('文字编辑器未能载入，请刷新页面重试。');
  quill = new window.Quill('#rich-editor', {
    theme: 'snow', placeholder: '这一格，想写点什么？',
    formats: ['bold', 'italic', 'underline', 'link'],
    modules: { toolbar: { container: '#editor-toolbar', handlers: { link: openInlineLink } }, history: { userOnly: true } },
  });
  quill.root.setAttribute('aria-labelledby', 'body-label');
  quill.root.setAttribute('role', 'textbox');
  quill.root.setAttribute('aria-multiline', 'true');
  quill.on('text-change', () => { if (!editorLoading) saveEditorInput(); });
}
function openEditor(id) {
  if (!isAdmin || busy) return;
  try { initEditor(); } catch (error) { toast(error.message); return; }
  closeDialog('reader-dialog');
  isNewCard = !id;
  editingId = id || crypto.randomUUID();
  const card = working.cards.find(card => card.id === id) || { id: editingId, kind: 'text', title: '', body: '', url: '', linkLabel: '' };
  editorLoading = true;
  $('editor-heading').textContent = isNewCard ? '新建卡片' : '编辑卡片';
  $('card-title').value = card.title;
  $('card-kind').checked = card.kind === 'link';
  $('card-url').value = card.url;
  $('card-link-label').value = card.linkLabel;
  $('link-fields').hidden = card.kind !== 'link';
  $('editor-dialog').dataset.kind = card.kind;
  quill.setContents(quill.clipboard.convert({ html: sanitizeHTML(card.body) }), 'silent');
  quill.history.clear();
  editorLoading = false;
  setError('editor-error');
  $('draft-save-note').textContent = '修改会自动留在本地';
  openDialog('editor-dialog');
  $('card-title').focus();
}
function getEditorCard() {
  return { id: editingId, kind: $('card-kind').checked ? 'link' : 'text', title: $('card-title').value,
    body: sanitizeHTML(quill.getSemanticHTML()), url: $('card-url').value.trim(), linkLabel: $('card-link-label').value.trim() };
}
function saveEditorInput() {
  if (editorLoading || !editingId || !isAdmin || busy) return;
  const card = getEditorCard();
  const index = working.cards.findIndex(item => item.id === editingId);
  if (index >= 0) working.cards[index] = card;
  else if (contentful(card)) working.cards.push(card);
  persist();
  $('draft-save-note').textContent = storageConflict ? '其他窗口有修改，请先备份本窗口草稿' : storageOK ? '草稿已保存在本地 · 尚未发布' : '本地保存不可用，请勿关闭页面';
}
function finishEditor(event) {
  event?.preventDefault();
  const card = getEditorCard();
  if (!contentful(card)) { setError('editor-error', '先写一点标题或正文，再保存这一格。'); return; }
  if (card.kind === 'link' && !safeUrl(card.url)) { setError('editor-error', '请填写以 https:// 或 http:// 开头的主链接网址。'); $('card-url').focus(); return; }
  saveEditorInput(); closeEditor();
}
function closeEditor() {
  if (quill && editingId) {
    saveEditorInput();
    const index = working.cards.findIndex(card => card.id === editingId);
    if (isNewCard && index >= 0 && !contentful(working.cards[index])) working.cards.splice(index, 1);
    editingId = null;
    persist(); renderBoard();
  }
  closeDialog('link-dialog'); closeDialog('editor-dialog');
}
function openInlineLink() {
  savedLinkRange = quill.getSelection(true) || { index: quill.getLength() - 1, length: 0 };
  const format = quill.getFormat(savedLinkRange);
  $('inline-link-url').value = format.link || '';
  $('inline-link-text').value = quill.getText(savedLinkRange.index, savedLinkRange.length);
  $('unlink-button').hidden = !format.link;
  setError('link-error'); openDialog('link-dialog'); $('inline-link-url').focus();
}
function applyInlineLink(event) {
  event.preventDefault();
  const url = safeUrl($('inline-link-url').value);
  if (!url) { setError('link-error', '请填写完整的 http:// 或 https:// 链接。'); return; }
  const range = savedLinkRange;
  const text = $('inline-link-text').value.trim() || url;
  closeDialog('link-dialog'); quill.focus();
  if (range.length) {
    if (text === quill.getText(range.index, range.length)) quill.formatText(range.index, range.length, 'link', url, 'user');
    else quill.updateContents([{ retain: range.index }, { delete: range.length }, { insert: text, attributes: { link: url } }], 'user');
  } else quill.insertText(range.index, text, { link: url }, 'user');
  quill.setSelection(range.index + text.length, 0, 'silent');
  saveEditorInput();
}

function openSettings() {
  $('repo-name').value = config.owner && config.repo ? `${config.owner}/${config.repo}` : '';
  $('github-token').value = '';
  $('settings-intro').textContent = connected ? '仓库已连接。令牌仅在当前页面会话中使用。' : '在这里整理卡片，写好后再发布给朋友。';
  setError('settings-error'); openDialog('settings-dialog');
}
async function connectRepository(event) {
  event.preventDefault();
  const fullName = $('repo-name').value.trim();
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) { setError('settings-error', '请填写“用户名/仓库名”。'); return; }
  const newToken = $('github-token').value.trim() || token;
  if (!newToken) { setError('settings-error', '请输入只授予此仓库读写权限的访问令牌。'); return; }
  const [owner, repo] = fullName.split('/');
  if ((isDirty() || pendingDeployment) && config.owner && `${config.owner}/${config.repo}` !== fullName) {
    setError('settings-error', '当前有未发布草稿或等待上线的内容，请先完成发布，再切换仓库。'); return;
  }
  const nextConfig = { ...config, owner, repo };
  if (['localhost', '127.0.0.1', '::1'].includes(new URL(nextConfig.siteUrl).hostname)) {
    nextConfig.siteUrl = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`
      ? `https://${owner}.github.io/` : `https://${owner}.github.io/${encodeURIComponent(repo)}/`;
  }
  $('connect-button').disabled = true; $('connect-button').textContent = '正在连接…';
  setError('settings-error');
  try {
    const repoInfo = await verifyRepository(nextConfig, newToken);
    nextConfig.branch = repoInfo.default_branch || nextConfig.branch;
    const remote = await fetchBoard(nextConfig, newToken);
    if (remote.board) remote.board = validateBoard(remote.board);
    token = newToken; config = nextConfig; connected = true;
    writeStorage(CONFIG_KEY, { owner: config.owner, repo: config.repo, branch: config.branch, siteUrl: config.siteUrl });
    $('github-token').value = '';
    if (pendingDeployment && remote.board?.revision !== pendingDeployment.revision) {
      deploymentController?.abort(); pendingDeployment = null;
    }
    if (remote.board) {
      if (!isDirty()) {
        working = cloneBoard(remote.board); baseFingerprint = cardFingerprint(remote.board);
        baseRevision = remote.board.revision; baseSha = remote.sha; conflict = false;
      } else {
        const baseline = checkBaseline({ baseSha, baseRevision, baseFingerprint }, remote);
        baseSha = baseline.sha; conflict = baseline.conflict;
      }
    } else {
      const baseline = checkBaseline({ baseSha, baseRevision, baseFingerprint }, remote);
      baseSha = baseline.sha; conflict = baseline.conflict;
    }
    closeDialog('settings-dialog'); setAdmin(true); persist();
    toast(conflict ? '已连接。云端有新版，本地草稿仍保留。' : '已连接，可以整理和发布卡片了。');
  } catch (error) { setError('settings-error', error.message); }
  finally { $('connect-button').disabled = false; $('connect-button').textContent = '连接并管理 ↗'; }
}
function enterLocalMode() {
  closeDialog('settings-dialog'); setAdmin(true);
  toast('已进入本地编辑。发布时再连接 GitHub。');
}
function ensurePublishable() {
  for (const card of working.cards) {
    if (!contentful(card)) throw new Error(`“${displayTitle(card)}”还是空白，请补充内容或删除。`);
    if (card.kind === 'link' && !safeUrl(card.url)) throw new Error(`“${displayTitle(card)}”的主链接尚未填写完整。`);
  }
}
function openPublish() {
  if (!isAdmin || busy) return;
  if (storageConflict) { toast('请先备份本窗口草稿，再刷新读取最新本地版本。', '下载草稿', exportDraft); return; }
  if (pendingDeployment) { checkDeployment(); return; }
  if (!isDirty() && !conflict) { toast('当前没有需要发布的修改。'); return; }
  if (!connected) { openSettings(); return; }
  try { ensurePublishable(); } catch (error) { toast(error.message); return; }
  $('publish-summary').textContent = `将当前 ${working.cards.length} 张卡片及排列顺序一起发布。朋友会在站点更新后看到这一版。`;
  $('publish-detail').textContent = conflict ? '云端已有更新，先处理版本冲突。' : '本地草稿已保留。发布会更新公开看板。';
  $('confirm-publish').disabled = conflict;
  $('confirm-publish').textContent = '确认发布 ↗';
  setError('publish-error');
  $('conflict-actions').hidden = !conflict;
  $('load-remote').disabled = true;
  openDialog('publish-dialog');
}
async function submitPublish() {
  if (busy || conflict) return;
  try { ensurePublishable(); } catch (error) { setError('publish-error', error.message); return; }
  const snapshot = validateBoard({ ...working, revision: crypto.randomUUID(), publishedAt: new Date().toISOString() });
  snapshot.cards = snapshot.cards.map(card => ({ ...card, body: sanitizeHTML(card.body), url: card.kind === 'link' ? safeUrl(card.url) : card.url }));
  busy = true; updateStatus(); $('confirm-publish').disabled = true;
  $('confirm-publish').textContent = '正在提交…'; $('publish-detail').textContent = '正在提交到 GitHub，请保留此页面。';
  setError('publish-error');
  try {
    const result = await publishBoard(config, token, snapshot, baseSha);
    baseSha = result.contentSha; baseRevision = snapshot.revision; baseFingerprint = cardFingerprint(snapshot);
    working = cloneBoard(snapshot); conflict = false;
    pendingDeployment = { revision: snapshot.revision, commitSha: result.commitSha, board: snapshot, repository: `${config.owner}/${config.repo}` };
    busy = false; persist(); renderBoard();
    $('publish-detail').textContent = '已提交到 GitHub，正在等待公开站点更新。此时朋友可能仍看到上一版。';
    $('confirm-publish').textContent = '等待上线';
    await checkDeployment();
  } catch (error) {
    busy = false;
    if (error.kind === 'conflict' || error.status === 409) {
      conflict = true; $('conflict-actions').hidden = false;
      $('load-remote').disabled = true;
    }
    setError('publish-error', error.message); $('publish-detail').textContent = '尚未完成发布，本地草稿已保留。';
    $('confirm-publish').disabled = conflict; $('confirm-publish').textContent = '重试发布 ↗';
    persist();
  }
}
async function checkDeployment() {
  if (!pendingDeployment || deploymentController) return;
  deploymentController = new AbortController(); updateStatus();
  try {
    const result = await waitForLive(config, pendingDeployment.revision, { signal: deploymentController.signal, intervalMs: 10000, timeoutMs: 180000 });
    published = validateBoard(result.board);
    pendingDeployment = null;
    $('publish-detail').textContent = '已上线。朋友刷新看板后即可看到更新。';
    $('confirm-publish').textContent = '已上线 ✓'; $('confirm-publish').disabled = true;
    toast('已上线，新的这一版可以分享给朋友了。');
  } catch (error) {
    if (error.name !== 'AbortError' && error.kind !== 'aborted') {
      let superseded = false;
      try {
        const remote = await fetchBoard(config, token);
        if (pendingDeployment && remote.board?.revision !== pendingDeployment.revision) {
          superseded = true; pendingDeployment = null;
          if (remote.board && !isDirty()) {
            working = validateBoard(remote.board); baseRevision = working.revision; baseSha = remote.sha;
            baseFingerprint = cardFingerprint(working); conflict = false; renderBoard();
          } else conflict = true;
        }
      } catch { /* A failed status read does not discard an already-submitted deployment. */ }
      $('publish-detail').textContent = superseded ? '云端已有更新版本，已停止等待旧版。本地修改仍然保留，请检查版本差异。' : '已提交，公开站点仍在更新。可稍后点击“检查上线”，不会重复提交。';
      toast(superseded ? '云端已有更新版本，已停止等待旧版。' : '内容已提交，仍在等待上线。可以稍后再检查。');
    }
  } finally { deploymentController = null; persist(); if (!isAdmin) renderBoard(); }
}
function exportDraft() {
  const blob = new Blob([JSON.stringify(working, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = makeElement('a'); a.href = url; a.download = `little-board-draft-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('load-remote').disabled = false;
}
async function loadRemoteAfterBackup() {
  if ($('load-remote').disabled || busy) return;
  try {
    const remote = await fetchBoard(config, token);
    if (!remote.board) throw new Error('云端内容暂不可用，本地草稿未改动。');
    working = validateBoard(remote.board); baseRevision = working.revision; baseSha = remote.sha;
    baseFingerprint = cardFingerprint(working); conflict = false; pendingDeployment = null;
    persist(); renderBoard(); closeDialog('publish-dialog'); toast('已读取云端新版，可以对照备份整理修改。');
  } catch (error) { setError('publish-error', error.message); }
}

function deleteCurrentCard() {
  const index = working.cards.findIndex(card => card.id === currentId);
  if (index < 0 || !isAdmin || busy) return;
  undoDeletion = { card: working.cards[index], index };
  working.cards.splice(index, 1); persist(); renderBoard();
  closeDialog('delete-dialog'); closeDialog('reader-dialog');
  toast('卡片已从本地移除，发布后才会公开更新。', '撤销', () => {
    if (!undoDeletion || working.cards.some(card => card.id === undoDeletion.card.id)) return;
    working.cards.splice(Math.min(undoDeletion.index, working.cards.length), 0, undoDeletion.card);
    undoDeletion = null; persist(); renderBoard(); $('toast').hidden = true;
  });
}
function animatePositions(before, exceptId = '') {
  if (reducedMotion) return;
  for (const card of $('board-grid').querySelectorAll('.card')) {
    if (card.dataset.id === exceptId || !before.has(card.dataset.id)) continue;
    const prev = before.get(card.dataset.id), next = card.getBoundingClientRect();
    const x = prev.left - next.left, y = prev.top - next.top;
    if (x || y) card.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function cardPositions() { return new Map([...$('board-grid').querySelectorAll('.card')].map(node => [node.dataset.id, node.getBoundingClientRect()])); }
function startDrag(event, id, article) {
  if (event.button !== 0 || busy || !isAdmin) return;
  event.preventDefault(); event.stopPropagation();
  const rect = article.getBoundingClientRect();
  dragState = { id, article, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, rect, targetId: null, ghost: null, active: false };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}
function moveDrag(event) {
  const d = dragState; if (!d) return;
  if (!d.active && Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < 6) return;
  event.preventDefault();
  if (!d.active) {
    d.active = true; d.ghost = d.article.cloneNode(true); d.ghost.classList.add('drag-ghost');
    d.ghost.removeAttribute('tabindex'); d.ghost.setAttribute('aria-hidden', 'true');
    Object.assign(d.ghost.style, { position: 'fixed', width: `${d.rect.width}px`, height: `${d.rect.height}px`, left: '0', top: '0', margin: '0', pointerEvents: 'none', zIndex: '1000' });
    document.body.append(d.ghost); d.article.classList.add('ghost'); document.body.classList.add('is-dragging');
  }
  d.ghost.style.transform = `translate3d(${event.clientX - d.offsetX}px,${event.clientY - d.offsetY}px,0) rotate(-1.5deg)`;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.card');
  const targetId = target && target.dataset.id !== d.id ? target.dataset.id : null;
  if (targetId !== d.targetId) {
    document.querySelector('.drop-target')?.classList.remove('drop-target');
    target?.classList.toggle('drop-target', Boolean(targetId)); d.targetId = targetId;
  }
  if (event.clientY > innerHeight - 80) window.scrollBy(0, 12);
  else if (event.clientY < 80) window.scrollBy(0, -12);
}
async function endDrag(event) {
  const d = dragState; if (!d) return;
  dragState = null;
  document.body.classList.remove('is-dragging');
  if (!d.active) return;
  clickSuppressedUntil = Date.now() + 350;
  const before = cardPositions();
  if (event.type !== 'pointercancel' && d.targetId) {
    working.cards = swapCards(working.cards, d.id, d.targetId); persist();
  }
  renderBoard(); animatePositions(before, d.id);
  const destination = [...$('board-grid').querySelectorAll('.card')].find(node => node.dataset.id === d.id);
  if (destination && d.ghost && !reducedMotion) {
    destination.classList.add('ghost'); const rect = destination.getBoundingClientRect();
    const animation = d.ghost.animate([{ transform: d.ghost.style.transform }, { transform: `translate3d(${rect.left}px,${rect.top}px,0) rotate(0deg)` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    await animation.finished.catch(() => {}); destination.classList.remove('ghost');
  }
  d.ghost?.remove();
}
function keyboardMove(event, id, handle) {
  if ([' ', 'Enter'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    handle.dataset.grabbed = handle.dataset.grabbed === 'true' ? 'false' : 'true';
    handle.setAttribute('aria-pressed', handle.dataset.grabbed);
    toast(handle.dataset.grabbed === 'true' ? '已选取卡片，按方向键交换位置，再按空格完成。' : '位置已保存到本地。'); return;
  }
  if (handle.dataset.grabbed !== 'true') return;
  if (event.key === 'Escape') { handle.dataset.grabbed = 'false'; handle.setAttribute('aria-pressed', 'false'); return; }
  const columns = getComputedStyle($('board-grid')).gridTemplateColumns.split(' ').length;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
  if (!delta) return;
  event.preventDefault(); event.stopPropagation();
  const index = working.cards.findIndex(card => card.id === id), target = working.cards[index + delta];
  if (!target) return;
  const before = cardPositions(); working.cards = swapCards(working.cards, id, target.id); persist(); renderBoard(); animatePositions(before);
  const newHandle = [...$('board-grid').querySelectorAll('.card')].find(node => node.dataset.id === id)?.querySelector('.drag-handle');
  if (newHandle) { newHandle.dataset.grabbed = 'true'; newHandle.setAttribute('aria-pressed', 'true'); newHandle.focus(); }
}

async function boot() {
  $('board-error').hidden = true;
  try {
    const [configResponse, boardResponse] = await Promise.all([fetch('./config.json', { cache: 'no-store' }), fetch('./data/board.json', { cache: 'no-store' })]);
    if (!configResponse.ok || !boardResponse.ok) throw new Error('无法载入看板');
    const shippedConfig = await configResponse.json();
    const savedConfig = readStorage(CONFIG_KEY) || {};
    config = inferConfig(location, { ...savedConfig, ...Object.fromEntries(Object.entries(shippedConfig).filter(([, value]) => value !== '')) });
    published = validateBoard(await boardResponse.json());
    working = cloneBoard(published); baseRevision = published.revision; baseFingerprint = cardFingerprint(published); baseSha = undefined;
    const draft = readStorage(DRAFT_KEY);
    if (draft?.version === 1 && draft.board) {
      try {
        const restored = validateBoard(draft.board);
        const draftDirty = cardFingerprint(restored) !== draft.baseFingerprint;
        if (draftDirty || draft.pendingDeployment) {
          working = restored; baseRevision = draft.baseRevision; baseSha = draft.baseSha; baseFingerprint = draft.baseFingerprint || cardFingerprint(published);
          pendingDeployment = draft.pendingDeployment; conflict = Boolean(draft.conflict);
          if (pendingDeployment?.revision === published.revision) pendingDeployment = null;
        }
      } catch { toast('旧草稿格式无法读取，已保留原记录，请先备份。'); }
    }
    renderBoard(); updateStatus();
    if (pendingDeployment) checkDeployment();
  } catch (error) { $('board-error').hidden = false; $('board-grid').setAttribute('aria-busy', 'false'); }
}

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  if (busy && button.dataset.close === 'publish-dialog') return;
  if (button.dataset.close === 'editor-dialog') closeEditor(); else closeDialog(button.dataset.close);
}));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => {
    if (busy && dialog.id === 'publish-dialog') { event.preventDefault(); return; }
    if (dialog.id === 'editor-dialog') { event.preventDefault(); closeEditor(); }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || busy) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
    if (dialog.id === 'editor-dialog') closeEditor(); else closeDialog(dialog.id);
  });
});
$('editor-form').addEventListener('submit', finishEditor);
for (const id of ['card-title', 'card-url', 'card-link-label']) $(id).addEventListener('input', saveEditorInput);
$('card-kind').addEventListener('change', () => { $('link-fields').hidden = !$('card-kind').checked; $('editor-dialog').dataset.kind = $('card-kind').checked ? 'link' : 'text'; saveEditorInput(); });
$('link-form').addEventListener('submit', applyInlineLink);
$('unlink-button').addEventListener('click', () => { closeDialog('link-dialog'); quill.formatText(savedLinkRange.index, savedLinkRange.length || 1, 'link', false, 'user'); saveEditorInput(); });
$('edit-card').addEventListener('click', () => openEditor(currentId));
$('delete-card').addEventListener('click', () => openDialog('delete-dialog'));
$('confirm-delete').addEventListener('click', deleteCurrentCard);
$('admin-trigger').addEventListener('click', openSettings);
$('settings-button').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', connectRepository);
$('settings-dialog').addEventListener('close', () => { $('github-token').value = ''; });
$('local-mode-button').addEventListener('click', enterLocalMode);
$('leave-admin').addEventListener('click', () => { token = ''; connected = false; setAdmin(false); toast('已退出管理，当前显示公众看到的版本。'); });
$('publish-button').addEventListener('click', openPublish);
$('confirm-publish').addEventListener('click', submitPublish);
$('export-draft').addEventListener('click', exportDraft);
$('load-remote').addEventListener('click', loadRemoteAfterBackup);
$('retry-load').addEventListener('click', boot);
window.addEventListener('pointermove', moveDrag, { passive: false });
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('pagehide', () => { token = ''; deploymentController?.abort(); });
window.addEventListener('storage', event => {
  if (event.key === DRAFT_KEY && isAdmin) {
    storageConflict = true; conflict = true; updateStatus('另一窗口有修改');
    toast('另一个窗口修改了本地草稿，本窗口后续修改暂不覆盖保存。', '下载本窗口草稿', exportDraft);
  }
});
boot();
