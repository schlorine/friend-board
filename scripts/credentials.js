const DATABASE = 'a-little-board-credentials';
const STORE = 'github-tokens';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function credentialId(scope, repository) {
  if (typeof scope !== 'string' || !scope.trim()
    || typeof repository !== 'string' || !repository.trim()) {
    throw new Error('请先选择 GitHub 仓库。');
  }
  return JSON.stringify([scope, repository.trim().toLowerCase()]);
}

function browserStorage() {
  try {
    const { indexedDB, crypto } = globalThis;
    if (typeof indexedDB?.open === 'function' && crypto?.subtle
      && typeof crypto.getRandomValues === 'function') {
      return { indexedDB, crypto };
    }
  } catch {
    // Browser settings can deny access to IndexedDB.
  }
  throw new Error('当前浏览器无法记住令牌，请手动输入。');
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('令牌存储正在被另一个页面占用。'));
    };
    request.onerror = () => reject(new Error('无法打开令牌存储。'));
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function accessStore(indexedDB, mode, operation) {
  const database = await openDatabase(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      transaction.onabort = () => reject(new Error('令牌存储操作未完成。'));
      transaction.onerror = () => reject(new Error('令牌存储操作失败。'));
      const request = operation(transaction.objectStore(STORE));
      // The request can succeed before the transaction fails to commit.
      transaction.oncomplete = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

function algorithm(id, iv) {
  // Bind the encrypted token to the site scope and repository that own it.
  return { name: 'AES-GCM', iv, additionalData: encoder.encode(id) };
}

export async function hasRememberedToken(scope, repository) {
  const id = credentialId(scope, repository);
  const { indexedDB } = browserStorage();
  try {
    return (await accessStore(indexedDB, 'readonly', store => store.count(id))) > 0;
  } catch {
    throw new Error('无法检查已保存的令牌，请手动输入。');
  }
}

export async function loadRememberedToken(scope, repository) {
  const id = credentialId(scope, repository);
  const { indexedDB, crypto } = browserStorage();
  try {
    const record = await accessStore(indexedDB, 'readonly', store => store.get(id));
    if (record === undefined) return null;
    const { key, iv, ciphertext } = record;
    if (key?.extractable !== false || key.algorithm?.name !== 'AES-GCM'
      || !(iv instanceof Uint8Array) || iv.byteLength !== 12
      || !(ciphertext instanceof ArrayBuffer) || ciphertext.byteLength < 16) {
      throw new Error('保存的令牌格式无效。');
    }
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(algorithm(id, iv), key, ciphertext));
    try {
      return decoder.decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error('无法读取保存的令牌，请重新输入。');
  }
}

export async function saveRememberedToken(scope, repository, token) {
  const id = credentialId(scope, repository);
  if (typeof token !== 'string' || !token.trim()) throw new Error('请输入 GitHub 访问令牌。');
  const { indexedDB, crypto } = browserStorage();
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(token);
    let ciphertext;
    try {
      ciphertext = await crypto.subtle.encrypt(algorithm(id, iv), key, plaintext);
    } finally {
      plaintext.fill(0);
    }
    await accessStore(indexedDB, 'readwrite', store => store.put({ key, iv, ciphertext }, id));
  } catch {
    throw new Error('无法在此浏览器保存令牌，可以继续使用当前会话。');
  }
}

export async function clearRememberedToken(scope, repository) {
  const id = credentialId(scope, repository);
  const { indexedDB } = browserStorage();
  try {
    await accessStore(indexedDB, 'readwrite', store => store.delete(id));
  } catch {
    throw new Error('无法清除已保存的令牌，请重试。');
  }
}
