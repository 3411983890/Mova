import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 在 Electron 之外 require('electron') 只会拿到一个路径字符串，没有 ipcMain：
// 这类环境下 IPC 主流程跳过，纯逻辑（配置读写、快照、深度映射）照常验证。
let ipcMain = null;
let installModelIpc = null;
let searchOptionsFor = null;
try {
  ({ ipcMain } = require('electron'));
  ({ installModelIpc, searchOptionsFor } = require('../electron/model-ipc.cjs'));
} catch {
  ipcMain = null;
}
const electronReady = Boolean(ipcMain && typeof ipcMain.handle === 'function');
const SKIP_IPC = electronReady ? false : '需要 Electron 主进程（node --test 下跳过）';

const {
  PROVIDERS, DEFAULT_LIMITS, normalizeConfig, createSearchConfigStore, configSnapshot,
} = require('../electron/search-config.cjs');

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mova-search-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'search-config.json');
  return { dir, file, store: createSearchConfigStore({ filePath: file }) };
}

test('search-config: 首次读取得到契约默认值，保存后原子落盘且可回读', async t => {
  const { dir, file, store } = await tempStore(t);
  const initial = await store.read();
  assert.deepEqual(initial, normalizeConfig(null));
  assert.equal(initial.depth, 'standard');
  assert.equal(initial.zone, 'auto');
  assert.equal(initial.language, 'auto');
  assert.deepEqual(initial.limits, DEFAULT_LIMITS);
  assert.equal(initial.providers.anysearch.enabled, true, 'anysearch 默认启用');
  assert.equal(initial.providers.tavily.enabled, false, 'tavily 默认关闭');
  assert.equal(initial.providers.searxng.baseUrl, '');

  const saved = await store.save({
    depth: 'deep',
    providers: { tavily: { enabled: true } },
    limits: { reads: 99, chars: 10 },
  });
  assert.equal(saved.depth, 'deep');
  assert.equal(saved.providers.tavily.enabled, true);
  assert.equal(saved.providers.anysearch.enabled, true, '按源合并，不会清掉其它源');
  assert.equal(saved.limits.reads, 12, '超范围收敛到上限');
  assert.equal(saved.limits.chars, 1000, '低于下限收敛到下限');
  assert.deepEqual(saved.limits.ms, DEFAULT_LIMITS.ms);

  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  assert.deepEqual(await store.read(), saved, '规范化是幂等的');
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [], '临时文件已清理');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('search-config: 非法 SearXNG 地址报错，坏文件回退默认值', async t => {
  const { file, store } = await tempStore(t);
  await assert.rejects(
    store.save({ providers: { searxng: { baseUrl: 'javascript:alert(1)' } } }),
    error => /SearXNG/.test(error.message),
  );
  await assert.rejects(
    store.save({ providers: { searxng: { baseUrl: 'https://user:pass@searx.example.com' } } }),
    error => /SearXNG/.test(error.message),
  );
  const saved = await store.save({ providers: { searxng: { baseUrl: 'https://searx.example.com/' } } });
  assert.equal(saved.providers.searxng.baseUrl, 'https://searx.example.com');

  await writeFile(file, '{ not json');
  assert.deepEqual(await store.read(), normalizeConfig(null), '坏文件不能让搜索整体不可用');

  const ignored = await store.save({ depth: 'turbo', zone: 'mars' });
  assert.equal(ignored.depth, 'standard');
  assert.equal(ignored.zone, 'auto');
});

test('search-config: 快照形状与渲染层一致，且永远不含密钥', () => {
  const snapshot = configSnapshot(
    normalizeConfig({ depth: 'fast', providers: { searxng: { enabled: true, baseUrl: 'https://s.example.com' } } }),
    { anysearch: true, tavily: false, searxng: true },
  );
  assert.equal(snapshot.depth, 'fast');
  assert.deepEqual(snapshot.providers.map(provider => provider.id), PROVIDERS.map(provider => provider.id));
  assert.deepEqual(snapshot.providers[0], {
    id: 'anysearch', label: 'AnySearch', configured: true, enabled: true, hasExtract: true,
  });
  const searxng = snapshot.providers.find(provider => provider.id === 'searxng');
  assert.equal(searxng.configured, true);
  assert.equal(searxng.enabled, true);
  assert.equal(searxng.hasExtract, false);
  assert.equal(searxng.baseUrl, 'https://s.example.com');
  assert.equal(snapshot.providers.find(provider => provider.id === 'tavily').configured, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /key|secret|token/i);
});

test('model-ipc: searchDepth 映射到 readCount / maxResults / maxQueries', { skip: searchOptionsFor ? false : SKIP_IPC }, () => {
  const config = normalizeConfig({ depth: 'standard', zone: 'cn', language: 'zh-CN' });
  const fast = searchOptionsFor({ searchDepth: 'fast' }, config);
  assert.deepEqual([fast.readCount, fast.maxResults, fast.maxQueries], [0, 5, 1]);
  const standard = searchOptionsFor({ searchDepth: 'standard' }, config);
  assert.deepEqual([standard.readCount, standard.maxResults, standard.maxQueries], [3, 10, 3]);
  const deep = searchOptionsFor({ searchDepth: 'deep' }, config);
  assert.deepEqual([deep.readCount, deep.maxResults, deep.maxQueries], [6, 10, 5]);
  // 非法深度回落到配置里的档位；zone/language 跟随配置，auto 不下发。
  const fallback = searchOptionsFor({ searchDepth: 'turbo' }, config);
  assert.equal(fallback.depth, 'standard');
  assert.equal(fallback.zone, 'cn');
  assert.equal(fallback.lang, 'zh-CN');
  assert.deepEqual(fallback.limits, DEFAULT_LIMITS);
  const auto = searchOptionsFor({ searchZone: 'auto', searchLanguage: 'auto' }, normalizeConfig(null));
  assert.equal(auto.zone, undefined);
  assert.equal(auto.lang, undefined);
  assert.equal(auto.recency, 'any');
});

test('search:config-get 经 IPC 返回配置，且不泄漏密钥', { skip: SKIP_IPC }, async () => {
  const registry = new Map();
  const original = ipcMain.handle;
  ipcMain.handle = (channel, fn) => { registry.set(channel, fn); };
  try {
    installModelIpc(() => ({}), null, {});
    for (const channel of ['search:config-get', 'search:config-save', 'search:provider-save', 'search:provider-test']) {
      assert.ok(registry.has(channel), `${channel} 已注册`);
    }
    const result = await registry.get('search:config-get')({ sender: { id: 'test' } });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.value.providers));
    assert.ok(result.value.providers.every(provider => typeof provider.configured === 'boolean'));
    assert.doesNotMatch(JSON.stringify(result.value), /"key"|"apiKey"|"token"/i);
  } finally {
    ipcMain.handle = original;
  }
});
