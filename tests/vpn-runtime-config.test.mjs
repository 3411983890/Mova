/**
 * `buildRuntimeConfig` 的纯函数单测。
 *
 * 断言的是「可观察结果」：生成的 YAML 文本（解析回对象后看关键字段）、
 * 每条线路拿到哪个端口、哪些目标因为没节点/没端口被踢出。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import { buildRuntimeConfig } from '../electron/vpn/runtime-config.mjs';

function node(id, name, extra = {}) {
  return {
    id,
    name,
    type: 'vless',
    server: '203.0.113.9',
    port: 443,
    raw: { name, type: 'vless', server: '203.0.113.9', port: 443, uuid: 'SECRET-UUID', ...extra },
  };
}

const NODES = [
  node('node_jp', '[GPT]日本Cs9'),
  node('node_jp2', '[GPT]美国cc2'),
  node('node_tw', '[Gemini][家宽]台湾5'),
];

const POOLS = [
  {
    id: 'gpt_auto', name: 'GPT 自动优选池', strategy: 'url-test',
    nodeIds: ['node_jp', 'node_jp2'], testUrl: 'https://chatgpt.com/favicon.ico',
    intervalSec: 180, toleranceMs: 50, selectedNodeId: '',
  },
  {
    id: 'gemini_auto', name: 'Gemini 家宽池', strategy: 'fallback',
    nodeIds: ['node_tw'], testUrl: 'https://www.gstatic.com/generate_204',
    intervalSec: 180, toleranceMs: 150, selectedNodeId: '',
  },
];

function baseInput(overrides = {}) {
  return {
    core: { controllerPort: 17900, baseListenerPort: 17901, secret: 'test-secret' },
    pools: POOLS,
    routes: { 'subscription:chatgpt': { mode: 'pool', poolId: 'gpt_auto' } },
    modelOverrides: { 'subscription:gemini/model-a': { mode: 'pool', poolId: 'gemini_auto' } },
    nodes: NODES,
    ...overrides,
  };
}

test('每条线路一个独立端口，且同一线路被多个模型共用时只起一个入站', () => {
  const result = buildRuntimeConfig(baseInput({
    // ChatGPT 的默认路由 + 一个单模型覆盖指向同一个池：仍然只能有一个 listener。
    modelOverrides: {
      'subscription:chatgpt/gpt-6-astra': { mode: 'pool', poolId: 'gpt_auto' },
      'subscription:gemini/model-a': { mode: 'pool', poolId: 'gemini_auto' },
    },
  }));

  assert.equal(result.listeners.length, 2, '两条线路 → 两个入站，共用线路不重复开');
  const ports = result.listeners.map(item => item.port);
  assert.deepEqual(ports, [17901, 17902], '端口从 baseListenerPort 顺延');
  assert.equal(new Set(ports).size, ports.length, '端口互不相同');
  assert.equal(result.ports['pool:gpt_auto'], 17901);
  assert.equal(result.ports['pool:gemini_auto'], 17902);
  assert.equal(result.targets.find(item => item.key === 'pool:gpt_auto').usedBy.length, 2, '记录共用该线路的两个模型');
  assert.deepEqual(result.unassigned, []);
});

test('listener 钉死到策略池组，组内节点来自已导入节点', () => {
  const result = buildRuntimeConfig(baseInput());
  const gptListener = result.listeners.find(item => item.port === 17901);
  assert.equal(gptListener.proxy, 'mova-pool:gpt_auto');
  assert.equal(gptListener.listen, '127.0.0.1');
  assert.equal(gptListener.type, 'mixed');

  const gptGroup = result.groups.find(item => item.name === 'mova-pool:gpt_auto');
  assert.deepEqual(gptGroup.proxies, ['[GPT]日本Cs9', '[GPT]美国cc2']);
  assert.equal(gptGroup.type, 'url-test');
  assert.equal(gptGroup.url, 'https://chatgpt.com/favicon.ico');
  assert.equal(gptGroup.interval, 180);
  assert.equal(gptGroup.tolerance, 50);
});

test('生成的 YAML 关闭全局入口与 TUN，只开 loopback listeners', () => {
  const { yaml } = buildRuntimeConfig(baseInput());
  const doc = YAML.parse(yaml);
  assert.equal(doc['mixed-port'], 0, '不开全局混合端口，避免污染整机网络');
  assert.equal(doc['allow-lan'], false);
  assert.equal(doc['tun'].enable, false, 'TUN 必须关闭');
  assert.equal(doc['external-controller'], '127.0.0.1:17900');
  assert.equal(doc.secret, 'test-secret');
  assert.equal(doc.listeners.length, 2);
  assert.deepEqual(doc.rules, ['MATCH,DIRECT']);
  assert.equal(doc.proxies.length, 3);
  // 关键片段必须在文本里（防止 YAML 序列化成别的形状后 UI/内核都读不到）。
  assert.match(yaml, /mixed-port: 0/);
  assert.match(yaml, /tun:\n {2}enable: false/);
  assert.match(yaml, /listeners:/);
});

test('端口被占用时顺延，并把真实占用写进 listener', () => {
  const result = buildRuntimeConfig(baseInput({ occupiedPorts: [17901, 17902] }));
  assert.deepEqual(result.listeners.map(item => item.port), [17903, 17904]);
  assert.equal(result.ports['pool:gpt_auto'], 17903);
  assert.equal(result.ports['pool:gemini_auto'], 17904);
  assert.deepEqual(result.unassigned, []);
});

test('Controller 自己的端口永远不会被分配给 listener', () => {
  const result = buildRuntimeConfig(baseInput({
    core: { controllerPort: 17901, baseListenerPort: 17901, secret: 's' },
  }));
  assert.deepEqual(result.listeners.map(item => item.port), [17902, 17903]);
});

test('端口顺延有上限，超出上限的目标报 port_exhausted 而不是无限扫描', () => {
  const result = buildRuntimeConfig(baseInput({
    // 65000 是允许的最末端口：base 就从最后一个可用口开始，第二条线路必然拿不到。
    core: { controllerPort: 64998, baseListenerPort: 65000, secret: 's' },
  }));
  assert.equal(result.listeners.length, 1);
  const exhausted = result.unassigned.filter(item => item.code === 'port_exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].key, 'pool:gemini_auto');
});

test('没有节点时生成空配置：零 listener、零 proxy，但 YAML 仍然合法可启动', () => {
  const result = buildRuntimeConfig(baseInput({ nodes: [] }));
  assert.deepEqual(result.listeners, []);
  assert.deepEqual(result.proxies, []);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.ports, {});
  assert.equal(result.unassigned.length, 2);
  assert.ok(result.unassigned.every(item => item.code === 'node_unavailable'));

  const doc = YAML.parse(result.yaml);
  assert.deepEqual(doc.listeners, []);
  assert.deepEqual(doc.proxies, []);
  assert.equal(doc['mixed-port'], 0);
});

test('完全没有路由和策略池时是纯直连配置', () => {
  const result = buildRuntimeConfig({ core: { secret: 's' } });
  assert.deepEqual(result.listeners, []);
  assert.deepEqual(result.targets, []);
  assert.equal(result.core.baseListenerPort, 17901);
  assert.equal(result.core.controllerPort, 17900);
});

test('固定节点路由只引用该节点自己，不建策略池组', () => {
  const result = buildRuntimeConfig(baseInput({
    pools: [],
    routes: { 'provider:custom': { mode: 'node', nodeId: 'node_tw' } },
    modelOverrides: {},
  }));
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].proxy, '[Gemini][家宽]台湾5');
  assert.deepEqual(result.groups, []);
  assert.equal(result.proxies.length, 1);
});

test('策略池里手动指定的首选节点排在最前（Mihomo 按列表顺序取第一个可用）', () => {
  const result = buildRuntimeConfig(baseInput({
    pools: [{ ...POOLS[0], selectedNodeId: 'node_jp2' }, POOLS[1]],
  }));
  const group = result.groups.find(item => item.name === 'mova-pool:gpt_auto');
  assert.deepEqual(group.proxies, ['[GPT]美国cc2', '[GPT]日本Cs9']);
});

test('节点被删除后指向它的路由进入 node_unavailable，不会生成半截配置', () => {
  const result = buildRuntimeConfig(baseInput({
    pools: [],
    routes: { 'provider:custom': { mode: 'node', nodeId: 'node_deleted' } },
    modelOverrides: {},
  }));
  assert.deepEqual(result.listeners, []);
  assert.equal(result.unassigned[0].code, 'node_unavailable');
  assert.equal(result.unassigned[0].key, 'node:node_deleted');
});

/** 端口跳跃节点（hysteria2）与 anytls 节点：字段必须原样进 YAML。 */
const JUMP_NODE = {
  id: 'node_jump',
  name: '[GPT]日本hy15',
  type: 'hysteria2',
  server: '2001:db8::1',
  port: 28443,
  raw: {
    name: '[GPT]日本hy15',
    type: 'hysteria2',
    server: '2001:db8::1',
    port: 28443,
    password: '00000000-0000-0000-0000-000000000000',
    ports: '50000-60000',
    sni: 'example.com',
    'skip-cert-verify': true,
  },
};

const ANYTLS_NODE = {
  id: 'node_anytls',
  name: '🇺🇸[Gemini]美国2',
  type: 'anytls',
  server: '203.0.113.9',
  port: 11443,
  raw: {
    name: '🇺🇸[Gemini]美国2',
    type: 'anytls',
    server: '203.0.113.9',
    port: 11443,
    password: '11111111-1111-1111-1111-111111111111',
    sni: 'example.com',
    'skip-cert-verify': true,
    'client-fingerprint': 'chrome',
  },
};

test('hysteria2 的 ports 与 anytls proxy 原样出现在生成的 YAML 里', () => {
  const result = buildRuntimeConfig({
    core: { controllerPort: 17900, baseListenerPort: 17901, secret: 'test-secret' },
    pools: [{
      id: 'jump_pool', name: '跳跃池', strategy: 'url-test',
      nodeIds: ['node_jump', 'node_anytls'], testUrl: 'https://www.gstatic.com/generate_204',
      intervalSec: 180, toleranceMs: 150, selectedNodeId: '',
    }],
    routes: { 'provider:custom': { mode: 'pool', poolId: 'jump_pool' } },
    modelOverrides: {},
    nodes: [JUMP_NODE, ANYTLS_NODE],
  });

  const doc = YAML.parse(result.yaml);
  const jump = doc.proxies.find(proxy => proxy.name === '[GPT]日本hy15');
  const anytls = doc.proxies.find(proxy => proxy.name === '🇺🇸[Gemini]美国2');

  assert.ok(jump, 'hysteria2 节点必须在 proxies 里');
  assert.equal(jump.type, 'hysteria2');
  assert.equal(jump.ports, '50000-60000', 'ports 必须是字符串，且与解析结果一致');
  assert.equal(jump.port, 28443, 'port 作为兜底必须同时存在');
  assert.equal(typeof jump.ports, 'string');

  assert.ok(anytls, 'anytls 节点必须在 proxies 里');
  assert.equal(anytls.type, 'anytls');
  assert.equal(anytls.server, '203.0.113.9');
  assert.equal(anytls.port, 11443);
  assert.equal(anytls.password, '11111111-1111-1111-1111-111111111111');
  assert.equal(anytls['skip-cert-verify'], true);
  assert.equal(anytls['client-fingerprint'], 'chrome');

  // 文本层面也要原样出现：Mihomo 认的就是 `ports:` 这个字段名。
  assert.match(result.yaml, /ports: 50000-60000/);
  assert.match(result.yaml, /type: anytls/);
  assert.deepEqual(result.proxyFieldIssues, [], '没有关键字段被透传层吞掉');
});

test('非字符串的 ports 不会被写进 YAML（宁可回落单端口，也不产生非法配置）', () => {
  const broken = {
    ...JUMP_NODE,
    raw: { ...JUMP_NODE.raw, ports: 50000 },
  };
  const result = buildRuntimeConfig({
    core: { secret: 's' },
    pools: [],
    routes: { 'provider:custom': { mode: 'node', nodeId: 'node_jump' } },
    modelOverrides: {},
    nodes: [broken],
  });
  const doc = YAML.parse(result.yaml);
  assert.equal(doc.proxies[0].ports, undefined);
  assert.equal(doc.proxies[0].port, 28443);
  assert.deepEqual(result.proxyFieldIssues, []);
});

test('vless reality 字段（reality-opts / flow / client-fingerprint）原样进 YAML', () => {
  const realityNode = {
    id: 'node_reality',
    name: '日本cc1',
    type: 'vless',
    server: '203.0.113.7',
    port: 443,
    raw: {
      name: '日本cc1',
      type: 'vless',
      server: '203.0.113.7',
      port: 443,
      uuid: '00000000-0000-0000-0000-000000000000',
      flow: 'xtls-rprx-vision',
      'client-fingerprint': 'chrome',
      servername: 'www.example.com',
      tls: true,
      'reality-opts': { 'public-key': 'PUBLIC-KEY-PLACEHOLDER', 'short-id': 'ab12' },
    },
  };
  const result = buildRuntimeConfig({
    core: { secret: 's' },
    pools: [],
    routes: { 'provider:custom': { mode: 'node', nodeId: 'node_reality' } },
    modelOverrides: {},
    nodes: [realityNode],
  });
  const doc = YAML.parse(result.yaml);
  const proxy = doc.proxies[0];
  assert.equal(proxy.flow, 'xtls-rprx-vision');
  assert.equal(proxy['client-fingerprint'], 'chrome');
  assert.deepEqual(proxy['reality-opts'], { 'public-key': 'PUBLIC-KEY-PLACEHOLDER', 'short-id': 'ab12' });
  assert.match(result.yaml, /reality-opts:/);
  assert.deepEqual(result.proxyFieldIssues, []);
});

test('线路健康检查：分组 interval 默认 300 秒、mova-meta 带每池地区与探测目标', () => {
  const nodes = [
    { id: 'n-jp1', name: '🇯🇵[GPT]日本cc1', raw: { name: '🇯🇵[GPT]日本cc1', type: 'vless', server: '203.0.113.1', port: 443, uuid: 'u1' } },
    { id: 'n-jp2', name: '🇯🇵[GPT]日本cc31', raw: { name: '🇯🇵[GPT]日本cc31', type: 'vless', server: '203.0.113.2', port: 443, uuid: 'u2' } },
    { id: 'n-us1', name: '🇺🇸[GPT]美国cc2', raw: { name: '🇺🇸[GPT]美国cc2', type: 'vless', server: '203.0.113.3', port: 443, uuid: 'u3' } },
  ];
  // 不传 intervalSec：必须回落到 300（用户要求 5 分钟一次）。
  const config = buildRuntimeConfig({
    core: { controllerPort: 17900, baseListenerPort: 17901, secret: 's', logLevel: 'warning' },
    pools: [
      { id: 'jp', name: 'jp', strategy: 'fallback', nodeIds: ['n-jp1', 'n-jp2'], selectedNodeId: '' },
      { id: 'mix', name: 'mix', strategy: 'fallback', nodeIds: ['n-jp1', 'n-us1'], selectedNodeId: '' },
    ],
    routes: {},
    modelOverrides: {},
    nodes,
    occupiedPorts: [],
  });

  const jpGroup = config.groups.find(group => group.name === 'mova-pool:jp');
  assert.equal(jpGroup.interval, 300, '同一地区的池默认 5 分钟巡检一次');

  // mova-meta：池地区一致 → 两位码；混地区 → mixed。
  assert.equal(config.meta.pools.jp.region, 'JP');
  assert.equal(config.meta.pools.jp.regionLabel, '日本');
  assert.deepEqual(config.meta.pools.jp.memberRegions, { 'n-jp1': 'JP', 'n-jp2': 'JP' });
  assert.equal(config.meta.pools.mix.region, 'mixed');

  // 每池都带探测目标，且默认目标是 google 204（不是 gstatic）。
  assert.ok(Array.isArray(config.meta.pools.jp.healthCheck.targets));
  assert.ok(config.meta.pools.jp.healthCheck.targets.includes('https://www.google.com/generate_204'));
  assert.equal(config.meta.pools.jp.healthCheck.intervalMs, 300_000);
});
