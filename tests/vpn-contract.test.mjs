/**
 * 契约层单测：错误码 → 中文文案映射全覆盖、IPC 返回形状、脱敏投影。
 *
 * 这些是渲染层唯一依赖的「字符串契约」：任何一个码漏了文案，用户看到的
 * 就是空白或 `undefined`，所以这里逐个码断言，而不是抽查。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHANNELS,
  DEFAULT_TEST_URL,
  ERROR_TEXT,
  KERNEL_INSTALL_HINT,
  LOOPBACK_NO_PROXY,
  VpnError,
  createDefaultRoutesConfig,
  fail,
  inferNodeRegion,
  inferNodeTags,
  maskSubscriptionUrl,
  modelOverrideKey,
  normalizeRouteTarget,
  ok,
  routeTargetKey,
  sanitizeNodeView,
  shouldAutoStartCore,
  sanitizeSubscriptionView,
  toErrorCode,
} from '../electron/vpn/contract.mjs';

/** 方案 §6.3 的完整错误码清单（新增码必须先加到这里，否则就是漏了文档同步）。 */
const DOCUMENTED_CODES = [
  'empty_input',
  'parse_failed',
  'subscription_fetch',
  'fxy_not_found',
  'credential',
  'core_missing',
  'kernel_missing',
  'core_start_failed',
  'core_download_failed',
  'port_exhausted',
  'node_unavailable',
  'probe_failed',
];

test('每个文档里的错误码都有非空中文文案', () => {
  for (const code of DOCUMENTED_CODES) {
    const text = ERROR_TEXT[code];
    assert.equal(typeof text, 'string', `${code} 缺少文案`);
    assert.ok(text.trim().length >= 4, `${code} 的文案太短，用户看不懂`);
    // 中文文案里不该混进英文错误码本身（那是给日志看的，不是给用户看的）。
    assert.doesNotMatch(text, /[a-z_]{6,}/, `${code} 的文案里混进了机器码`);
  }
});

test('VpnError 与 fail() 把同一个错误码映射成同一句文案', () => {
  for (const code of Object.keys(ERROR_TEXT)) {
    const error = new VpnError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, ERROR_TEXT[code]);
    const result = fail(error);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'message', 'ok']);
    assert.equal(result.ok, false);
    assert.equal(result.error, code);
    assert.equal(result.message, ERROR_TEXT[code]);
  }
});

test('自定义 message 保留，但 code 仍然是标准码', () => {
  const error = new VpnError('subscription_fetch', { message: '订阅链接拉取失败（HTTP 403）' });
  assert.equal(error.code, 'subscription_fetch');
  assert.equal(fail(error).message, '订阅链接拉取失败（HTTP 403）');
});

test('未知错误码统一降级成 internal，不透传上游错误名', () => {
  const unknown = new VpnError('some_unknown_code');
  assert.equal(unknown.code, 'internal');
  assert.equal(unknown.message, ERROR_TEXT.internal);
  const raw = Object.assign(new Error('boom'), { code: 'ENOENT' });
  assert.equal(toErrorCode(raw), 'internal');
  assert.equal(fail(raw).error, 'internal');
  assert.equal(fail('不是 Error 的抛出物').error, 'internal');
});

test('ok() 的形状与 preload 的约定一致', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.deepEqual(ok(null), { ok: true, value: null });
});

test('IPC 通道名与方案 §6.2 的清单一致（含 vpn:event 与健康检查两条）', () => {
  const expected = [
    'vpn:status', 'vpn:import-clipboard', 'vpn:import-subscription', 'vpn:refresh-subscription',
    'vpn:remove-subscription', 'vpn:scan-fxy', 'vpn:import-fxy', 'vpn:test-delays',
    'vpn:pool:save', 'vpn:pool:delete', 'vpn:pool:select-node', 'vpn:routes:get',
    'vpn:routes:set', 'vpn:probe-model', 'vpn:core:action', 'vpn:core:pick-path',
    'vpn:core:download', 'vpn:event',
    // 方案 §5「两级自动故障切换」落地时新增：手动巡检 + 跨地区开关。
    'vpn:health:check', 'vpn:health:settings',
  ];
  assert.deepEqual(Object.values(CHANNELS).sort(), [...expected].sort());
});

test('订阅链接脱敏只留域名与路径前缀，绝不回传 token', () => {
  const hint = maskSubscriptionUrl('https://sub.example.com/api/v1/client/subscribe?token=SECRET-TOKEN');
  assert.equal(hint, 'https://sub.example.com/api/…');
  assert.doesNotMatch(hint, /SECRET-TOKEN/);
  assert.equal(maskSubscriptionUrl('not a url'), '已保存订阅');
});

test('节点视图不含 uuid / password 等凭据原文', () => {
  const view = sanitizeNodeView({
    id: 'node_1',
    name: '[GPT]日本Cs9',
    type: 'vless',
    server: '203.0.113.42',
    port: 443,
    raw: { uuid: 'SECRET-UUID', 'reality-opts': { 'public-key': 'SECRET-PBK' } },
  });
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /SECRET-UUID|SECRET-PBK/);
  assert.equal(view.serverHint, '203.….42:443');
  assert.equal(view.region, '日本');
  assert.deepEqual(view.tags, ['gpt']);
  assert.equal(view.delayStatus, 'untested');
});

test('订阅视图不含完整订阅地址，只留摘要与用量', () => {
  const view = sanitizeSubscriptionView({
    id: 'sub_1',
    kind: 'subscription',
    name: '机场 A',
    url: 'https://sub.example.com/link/abcdef',
    nodeCount: 12,
    usage: { total: 100, upload: 1, download: 2 },
  });
  assert.equal(view.urlHint, 'https://sub.example.com/link/…');
  assert.equal(view.nodeCount, 12);
  assert.equal(view.usage.total, 100);
  assert.doesNotMatch(JSON.stringify(view), /abcdef/);
});

test('标签与地区推断只用于分组，不改变节点身份', () => {
  assert.deepEqual(inferNodeTags('[Gemini][家宽]台湾5'), ['gemini', 'residential']);
  assert.deepEqual(inferNodeTags('普通节点'), []);
  assert.equal(inferNodeRegion('[GPT][IPv6]日本Cs9'), '日本');
  assert.equal(inferNodeRegion('未知线路'), '');
});

test('路由指向归一化：非法值一律回落直连，模式缺失时不带 id', () => {
  assert.deepEqual(normalizeRouteTarget(null), { mode: 'direct', failover: true });
  assert.deepEqual(normalizeRouteTarget({ mode: 'nope', poolId: 'x' }), { mode: 'direct', failover: true });
  assert.deepEqual(normalizeRouteTarget({ mode: 'pool', poolId: ' ' }), { mode: 'pool', failover: true });
  assert.deepEqual(normalizeRouteTarget({ mode: 'pool', poolId: 'gpt_auto', failover: false }),
    { mode: 'pool', failover: false, poolId: 'gpt_auto' });
  assert.deepEqual(normalizeRouteTarget({ mode: 'node', nodeId: 'node_1' }),
    { mode: 'node', failover: true, nodeId: 'node_1' });
});

test('单模型覆盖键与线路目标键的形状稳定', () => {
  assert.equal(modelOverrideKey('subscription:chatgpt', 'gpt-6-sol'), 'subscription:chatgpt/gpt-6-sol');
  assert.equal(modelOverrideKey('subscription:chatgpt', ''), '');
  assert.equal(modelOverrideKey('', 'x'), '');
  assert.equal(routeTargetKey({ mode: 'pool', poolId: 'gpt_auto' }), 'pool:gpt_auto');
  assert.equal(routeTargetKey({ mode: 'node', nodeId: 'node_1' }), 'node:node_1');
  assert.equal(routeTargetKey({ mode: 'direct' }), '');
});

test('默认路由配置是一份合法的「什么都不启用」基线', () => {
  const config = createDefaultRoutesConfig();
  assert.equal(config.core.mode, 'managed');
  assert.equal(config.core.controllerPort, 17900);
  assert.equal(config.core.baseListenerPort, 17901);
  assert.equal(config.core.testUrl, DEFAULT_TEST_URL);
  assert.deepEqual(config.pools, []);
  assert.deepEqual(config.routes, {});
  assert.deepEqual(config.modelOverrides, {});
});

test('内核缺失的安装指引点名 mihomo.exe 与两条自救路径', () => {
  assert.match(KERNEL_INSTALL_HINT, /mihomo\.exe/);
  assert.match(KERNEL_INSTALL_HINT, /选择内核/);
  assert.match(KERNEL_INSTALL_HINT, /直连/);
  assert.equal(LOOPBACK_NO_PROXY, '127.0.0.1,localhost,::1');
});

// ── 开机自启的判定 ────────────────────────────────────────────────────────
// 这个设置以前只有字段没有消费者：内核不起 → 端口表为空 → envForModel() 返回 null →
// ACP 子进程与额度探针都直连。判定错误会直接表现成「模型没连 VPN，国内访问不了」。
test('开机自启只在「开着且没在跑」时启动', () => {
  assert.deepEqual(shouldAutoStartCore({ autoStart: true, running: false }), { start: true, reason: 'start' });
  // 用户在设置里关掉 → 绝不自动拉起。
  assert.deepEqual(shouldAutoStartCore({ autoStart: false, running: false }), { start: false, reason: 'disabled' });
  // 已经在跑（手动点过启动）→ 不重复启动第二个内核。
  assert.deepEqual(shouldAutoStartCore({ autoStart: true, running: true }), { start: false, reason: 'already_running' });
  // 缺省参数按「关」处理：拿不到配置时宁可不动，也不要凭空拉起一个内核。
  assert.deepEqual(shouldAutoStartCore(), { start: false, reason: 'disabled' });
  // 只有严格 true 才算开（旧配置里可能是字符串 / undefined）。
  assert.equal(shouldAutoStartCore({ autoStart: 'true', running: false }).start, false);
});
