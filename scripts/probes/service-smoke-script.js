const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bridge = window.movaDesktop?.memory;
if (!bridge) throw new Error('memory bridge missing');
const read = await bridge.read();
if (!read.ok) throw new Error('read failed: ' + read.error);
const health = await bridge.health();
const stats = await bridge.stats();
if (!health.ok || health.value.database !== 'ok') throw new Error('database not healthy: ' + JSON.stringify(health));
if (!(read.value.settings.semanticSearch === true && read.value.settings.hybridWeight === 0.5 && read.value.settings.extractorMode === 'rules')) throw new Error('service settings defaults missing');
const save = await bridge.save({ text: '服务版验收记忆：项目使用 PostgreSQL 与 pgvector', kind: 'decision', projectId: null, source: 'user' });
if (!save.ok) throw new Error('save failed: ' + save.error);
await sleep(1500);
const hits = await bridge.search({ query: '数据库怎么选型', projectId: null, includeGlobal: true });
if (!hits.ok || !hits.value.some(hit => hit.kind === 'memory' && hit.text.includes('pgvector'))) throw new Error('semantic/keyword search missing saved memory: ' + JSON.stringify(hits));
document.querySelector('#settings-button').click();
document.querySelector('[data-settings-item="memory"]').click();
await sleep(800);
const page = document.querySelector('#settings-page-memory');
if (!page || !page.textContent.includes('服务连接与健康状态')) throw new Error('service settings section missing');
if (!page.textContent.includes('PostgreSQL')) throw new Error('health status not rendered');
return {
  mode: health.value.mode,
  database: health.value.database,
  redis: health.value.redis,
  objectStorage: health.value.objectStorage,
  embedding: health.value.embedding,
  memories: stats.value.memories,
  settingsSections: ['服务连接与健康状态', '自动备份与恢复', 'Embedding 与索引', '语义检索与混合权重', '记忆提取模式', '存储配额与服务状态'].filter(text => page.textContent.includes(text)),
};
