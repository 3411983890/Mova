const { app, safeStorage } = require('electron');
const { mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModelError } = require('./local-model.cjs');

function validateKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[!-~]{1,512}$/.test(key)) throw new ModelError('invalid_key');
  return key;
}

function credentialStore(name) {
const filename = () => join(app.getPath('userData'), name);

async function hasKey() {
  try { return (await stat(filename())).isFile(); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new ModelError('credential');
  }
}

async function storeKey(value) {
  const key = validateKey(value);
  const path = filename();
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new ModelError('credential');
    const encrypted = await safeStorage.encryptStringAsync(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    throw new ModelError('credential');
  }
}

async function loadKey() {
  try {
    const encrypted = await readFile(filename());
    return validateKey((await safeStorage.decryptStringAsync(encrypted)).result);
  } catch (error) {
    throw new ModelError(error.code === 'ENOENT' ? 'not_configured' : 'credential');
  }
}

async function clearKey() {
  try { await rm(filename(), { force: true }); }
  catch { throw new ModelError('credential'); }
}

return { hasKey, storeKey, loadKey, clearKey };
}

// 每个搜索源一个独立加密文件，文件名固定为 `<providerId>-key.enc`；
// anysearch 与旧版共用 anysearch-key.enc，所以 `searchCredentials` 的行为完全不变。
const SEARCH_PROVIDERS = ['anysearch', 'tavily', 'searxng'];
const searchStores = new Map();

function searchCredentialStore(providerId) {
  const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  // id 会拼进文件名：只接受白名单里的值，避免任何路径穿越。
  if (!SEARCH_PROVIDERS.includes(id)) throw new ModelError('request');
  if (!searchStores.has(id)) searchStores.set(id, credentialStore(`${id}-key.enc`));
  return searchStores.get(id);
}

const localModel = credentialStore('local-model-key.enc');
const searchCredentials = searchCredentialStore('anysearch');

module.exports = {
  validateKey,
  createCredentialStore: credentialStore,
  ...localModel,
  searchCredentials,
  searchCredentialStore,
};
