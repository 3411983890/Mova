'use strict';
const path = require('node:path');
const { createMemoryRepository, MemoryError } = require('./memory-store.cjs');

// Only this adapter knows about Electron. Inject app/ipcMain/repository for tests.
function installMemoryIpc(authorize, options = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize is required');
  const electron = options.ipcMain ? null : require('electron');
  const ipcMain = options.ipcMain || electron.ipcMain;
  const app = options.app || electron?.app;
  let repository = options.repository || null;
  let loading = null;

  async function getRepository() {
    if (repository) return repository;
    if (loading) return loading;
    loading = Promise.resolve()
      .then(() => options.repositoryProvider
        ? options.repositoryProvider()
        : createMemoryRepository({ directory: path.join(app.getPath('userData'), 'memory') }))
      .then(value => { repository = value; return value; })
      .finally(() => { loading = null; });
    return loading;
  }

  function localHealth() {
    return {
      mode: 'local', database: 'down', redis: 'disabled', objectStorage: 'disabled',
      embedding: 'down', embeddingModel: '', embeddingDim: 0, queueLag: 0,
      message: '当前为本地 JSON 模式，未连接 PostgreSQL/Redis/对象存储。',
    };
  }

  async function localStats() {
    const data = await getRepository().then(repo => repo.read());
    return {
      databaseBytes: data.storage?.bytes ?? 0,
      attachmentBytes: 0,
      queueWaiting: 0,
      queueFailed: 0,
      memories: data.memories?.length ?? 0,
      conversations: data.sessions?.conversations?.length ?? 0,
      events: data.events?.length ?? 0,
      quotaBytes: null,
      indexPath: data.storage?.filePath ?? null,
    };
  }

  const unsupported = () => { throw new MemoryError('unsupported'); };
  const operations = {
    'memory:read': () => getRepository().then(repo => repo.read()),
    'memory:save-sessions': snapshot => getRepository().then(repo => repo.saveSessions(snapshot)),
    'memory:ingest': input => getRepository().then(repo => repo.ingest(input)),
    'memory:search': input => getRepository().then(repo => repo.query(input)),
    'memory:context': input => getRepository().then(repo => repo.context(input)),
    'memory:save': input => getRepository().then(repo => repo.saveMemory(input)),
    'memory:update': (id, patch) => getRepository().then(repo => repo.updateMemory(id, patch)),
    // 替代：memory_update 只改正文（保留原记录），memory_supersede 让旧条目退役并留下历史链。
    'memory:supersede': input => getRepository().then(repo => repo.supersedeMemory(input)),
    'memory:delete': id => getRepository().then(repo => repo.deleteMemory(id)),
    'memory:settings': patch => getRepository().then(repo => repo.settings(patch)),
    'memory:export': () => getRepository().then(repo => repo.exportData()),
    'memory:clear': input => getRepository().then(repo => repo.clear(input)),
    'memory:health': () => getRepository().then(repo => repo.health ? repo.health() : localHealth()),
    'memory:stats': () => getRepository().then(repo => repo.stats ? repo.stats() : localStats()),
    'memory:backup': input => getRepository().then(repo => repo.backup ? repo.backup(input) : unsupported()),
    'memory:backups': () => getRepository().then(repo => repo.listBackups ? repo.listBackups() : []),
    'memory:restore': input => getRepository().then(repo => repo.restore ? repo.restore(input) : unsupported()),
    'memory:reindex': () => getRepository().then(repo => repo.reindex ? repo.reindex() : unsupported()),
    'memory:jobs': () => getRepository().then(repo => repo.listJobs ? repo.listJobs() : []),
    'memory:maintenance': input => getRepository().then(repo => repo.maintenance ? repo.maintenance(input) : unsupported()),
    'vault:status': () => getRepository().then(repo => repo.vault ? repo.vault.status() : unsupported()),
    'vault:setup': passphrase => getRepository().then(repo => repo.vault ? repo.vault.setup(passphrase) : unsupported()),
    'vault:unlock': passphrase => getRepository().then(repo => repo.vault ? repo.vault.unlock(passphrase) : unsupported()),
    'vault:lock': () => getRepository().then(repo => repo.vault ? repo.vault.lock() : unsupported()),
    'vault:put': input => getRepository().then(repo => repo.vault ? repo.vault.put(input) : unsupported()),
    'vault:list': () => getRepository().then(repo => repo.vault ? repo.vault.list() : []),
    'vault:get': name => getRepository().then(repo => repo.vault ? repo.vault.get(name) : unsupported()),
    'vault:remove': name => getRepository().then(repo => repo.vault ? repo.vault.remove(name) : unsupported()),
    'vault:change-passphrase': input => getRepository().then(repo => repo.vault ? repo.vault.changePassphrase(input?.oldPassphrase, input?.nextPassphrase) : unsupported()),
  };
  for (const [channel, operation] of Object.entries(operations)) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (await authorize(event) === false) return { ok: false, error: 'unauthorized' };
      } catch { return { ok: false, error: 'unauthorized' }; }
      try {
        const sync = options.sessionSync;
        let value;
        if (sync && channel === 'memory:save-sessions') value = await sync.save(event.sender.id, await getRepository(), args[0], args[1]);
        else {
          value = await operation(...args);
          if (channel === 'memory:clear' || channel === 'memory:restore') sync?.changed();
        }
        return { ok: true, value };
      }
      catch (error) { return { ok: false, error: error instanceof MemoryError || error?.code ? error.code || 'storage-error' : 'storage-error' }; }
    });
  }
  if (options.sessionSync) {
    ipcMain.handle('memory:sync-sessions', async (event, revision) => {
      authorize(event);
      return { ok: true, value: await options.sessionSync.read(event.sender.id, await getRepository(), revision) };
    });
  }
  // Main uses this proxy for trusted model context lookup, not renderer text.
  const proxy = Object.fromEntries(Object.keys(operations).map(channel => {
    const method = channel.slice('memory:'.length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return [method, (...args) => operations[channel](...args)];
  }));
  // `delete` is a reserved word in some contexts; expose the explicit aliases used by callers.
  proxy.deleteMemory = id => operations['memory:delete'](id);
  // 技能包（memory_supersede）按名字找的是 `supersedeMemory`，通道名派生出的是 `supersede`：
  // 和 deleteMemory 一样显式补一个别名，别让 handler 依赖 string 派生的巧合。
  proxy.supersedeMemory = input => operations['memory:supersede'](input);
  proxy.listBackups = () => operations['memory:backups']();
  proxy.loadSessions = () => getRepository().then(repo => repo.loadSessions());
  proxy.readMemorySource = input => getRepository().then(repo => repo.readMemorySource(input));
  proxy.readHistorySource = input => getRepository().then(repo => repo.readHistorySource(input));
  return proxy;
}
module.exports = { installMemoryIpc };
