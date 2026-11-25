/**
 * VPN 线路与按模型路由的共享契约（IPC 通道、错误码、数据结构与脱敏投影）。
 *
 * 负责：主进程 `electron/vpn/*`、preload、渲染进程之间共享的常量与最小校验。
 * 不负责：具体解析、磁盘加密存储、Mihomo 进程管理与 UI 渲染。
 * 地区识别统一走 `region.mjs`（本文件的 `inferNodeRegion` 只是它的中文标签投影）。
 */
import { regionOfNode } from './region.mjs';

export const CHANNELS = Object.freeze({
  status: 'vpn:status',
  importClipboard: 'vpn:import-clipboard',
  importSubscription: 'vpn:import-subscription',
  refreshSubscription: 'vpn:refresh-subscription',
  removeSubscription: 'vpn:remove-subscription',
  scanFxy: 'vpn:scan-fxy',
  importFxy: 'vpn:import-fxy',
  testDelays: 'vpn:test-delays',
  poolSave: 'vpn:pool:save',
  poolDelete: 'vpn:pool:delete',
  poolSelectNode: 'vpn:pool:select-node',
  routesGet: 'vpn:routes:get',
  routesSet: 'vpn:routes:set',
  probeModel: 'vpn:probe-model',
  coreAction: 'vpn:core:action',
  pickCorePath: 'vpn:core:pick-path',
  downloadCore: 'vpn:core:download',
  /** 手动做一轮线路巡检（设置页「立即检查」按钮）。 */
  healthCheck: 'vpn:health:check',
  /** 读/写「允许跨地区切换」开关（默认关：同地区没有备选就不动）。 */
  healthSettings: 'vpn:health:settings',
  event: 'vpn:event',
});

export const SUPPORTED_PROTOCOLS = Object.freeze([
  'vless',
  'mieru',
  'vmess',
  'trojan',
  'ss',
  'hy2',
  'hysteria2',
  'tuic',
  // Mihomo v1.19+ 支持 anytls；URI 的 username 部分就是 password，字段与 trojan 近似。
  'anytls',
]);

export const CORE_MODES = Object.freeze(['managed', 'fallback', 'direct']);

export const POOL_STRATEGIES = Object.freeze(['url-test', 'fallback', 'select']);

export const ROUTE_MODES = Object.freeze(['direct', 'pool', 'node', 'fallback']);

export const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

/**
 * 上游 Provider 的「直连」路由：没有代理、没有端口、也没有失败切线。
 */
export const DIRECT_ROUTE = Object.freeze({ mode: 'direct', failover: true });

/**
 * 监听端口顺延上限：从 `core.baseListenerPort` 起最多向后找这么多个端口。
 * 取 100 是因为一台机器上同时分配给模型的线路是「个位数」量级，100 已经远超真实需求，
 * 又能在被人为占用一大段端口时立刻报 `port_exhausted` 而不是无限扫到 65000。
 */
export const MAX_LISTENER_SPAN = 100;

/**
 * ACP 子进程的 `NO_PROXY`。
 * 必须放行回环：`chat-agent` 会在本机随机端口起 HTTP 型 MCP server 供 `agy` 回调，
 * 少了这一段，CLI 会试图经台湾/日本节点回连本机，工具调用全部超时（方案 §2.3）。
 */
export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

/**
 * 内核缺失时给用户看的安装指引（主进程返回值与设置页共用同一份文案）。
 * 本仓库的构建/测试环境没有网络，因此**不提供**自动下载，只说明手把手怎么做。
 */
export const KERNEL_INSTALL_HINT = [
  '本版本不会自动下载内核（离线构建）。请按以下任一方式提供 mihomo 可执行文件：',
  '1. 从 MetaCubeX/mihomo 的 Release 手动下载 mihomo-windows-amd64-compatible-*.zip，解压得到 mihomo.exe，',
  '   放到 %APPDATA%\\Mova\\bin\\mihomo.exe（Mova 的 userData/bin 目录）；',
  '2. 或在设置 → 网络与线路里点「选择内核」，指向任意位置已有的 mihomo.exe。',
  '在此之前所有模型都保持直连，行为与未安装本功能时完全一致。',
].join('\n');

export const ERROR_TEXT = Object.freeze({
  request: '请求参数不正确',
  credential: '系统安全存储不可用，无法加密保存线路凭据',
  empty_input: '未识别到有效线路配置或订阅链接',
  parse_failed: '线路格式解析失败，请确认内容为 Clash YAML、节点链接或订阅链接',
  network: '网络请求失败，请检查当前网络后重试',
  subscription_fetch: '订阅链接拉取失败',
  fxy_not_found: '未在本机发现 Fxy 配置目录',
  core_missing: '尚未安装 Mihomo 内核，请先选择本地可执行文件',
  // 与 core_missing 分开：core_missing 是 UI 历史文案，kernel_missing 是运行态
  // 探测的真实结论（本机找不到内核文件），IPC 返回值与测试都断言后者。
  kernel_missing: '未在本机找到 Mihomo 内核可执行文件，按安装指引放置后即可启用多线路分流',
  core_start_failed: 'Mihomo 内核启动失败，请检查配置或端口占用',
  core_download_failed: 'Mihomo 内核下载或校验失败',
  port_exhausted: '本地空闲端口不足，无法为该线路分配监听端口',
  node_unavailable: '所选线路节点不可用或已超时',
  probe_failed: '连通性检测未通过',
  not_found: '找不到指定的线路、订阅或策略池',
  internal: '内部错误，请查看运行日志',
});

/**
 * 导入诊断码 → 用户看得懂的一句短语。
 *
 * 为什么不放进 `ERROR_TEXT`：那里是 IPC 的**错误码**（失败即中断），而这里的码只是
 * 「这次导入里有几条没能完整导入」的说明，导入本身是成功的。混在一起会让
 * `vpn-contract.test.mjs` 的错误码清单变质，也会让日志把 warning 当 error。
 */
export const IMPORT_DIAGNOSTIC_TEXT = Object.freeze({
  unsupported_scheme: '不支持的协议',
  invalid_port_range: '端口范围无效，已回落单端口',
  missing_required_fields: '缺少必需字段',
  parse_failed: '链接无法解析',
});

/** `[{ scheme, count }]` → `anytls ×2、ssr ×1`（导出结果与报错文案共用）。 */
export function formatImportSkipped(skipped) {
  const rows = (Array.isArray(skipped) ? skipped : [])
    .filter(item => item && typeof item === 'object')
    .map(item => `${String(item.scheme || '未知')} ×${Math.max(1, Math.floor(Number(item.count) || 1))}`);
  return rows.join('、');
}

function countByWarning(warnings, codes) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter(item => item && codes.includes(item.code))
    .reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item.count) || 1)), 0);
}

/** 统计 `skipped` 里的条目总数（按 `count` 聚合后的真实条数，不是数组长度）。 */
export function countSkippedNodes(skipped) {
  return (Array.isArray(skipped) ? skipped : [])
    .reduce((sum, item) => sum + Math.max(1, Math.floor(Number(item?.count) || 1)), 0);
}

/**
 * 一行可读的导入结果文案：
 * `共 9 条，导入 7 条，跳过 2 条（不支持的协议：anytls ×2）`。
 * 端口范围无效、链接无法解析这类「导入了但降级/失败」的情况追加在句尾。
 */
export function formatImportSummary(input = {}) {
  const imported = Math.max(0, Math.floor(Number(
    input?.imported ?? input?.nodesAdded ?? input?.nodeCount ?? input?.nodes?.length,
  ) || 0));
  const skipped = Array.isArray(input?.skipped) ? input.skipped : [];
  const warnings = Array.isArray(input?.warnings) ? input.warnings : [];
  const skippedCount = countSkippedNodes(skipped);
  const total = Math.max(
    Math.max(0, Math.floor(Number(input?.total) || 0)),
    imported + skippedCount,
  );
  const parts = [`共 ${total} 条`, `导入 ${imported} 条`, `跳过 ${skippedCount} 条`];
  let text = parts.join('，');
  const schemeText = formatImportSkipped(skipped);
  if (schemeText) text += `（${IMPORT_DIAGNOSTIC_TEXT.unsupported_scheme}：${schemeText}）`;
  const failed = countByWarning(warnings, ['missing_required_fields', 'parse_failed']);
  if (failed) text += `，另有 ${failed} 条无法解析`;
  const badRange = countByWarning(warnings, ['invalid_port_range']);
  if (badRange) text += `，${badRange} 条${IMPORT_DIAGNOSTIC_TEXT.invalid_port_range}`;
  return text;
}

/**
 * 把 IPC 返回的导入结果归纳成 `{ total, imported, skipped, warnings, text, partial }`。
 *
 * 兼容三种来源：`parseImportPayload` 的原始形状、IPC 目前只回传的 `{ nodeCount }`
 * 形状（此时 `skipped`/`warnings` 为空，`text` 仍然可读），以及未来补上
 * `total`/`warnings`/`skipped` 字段后的形状——渲染层不需要跟着改第二遍。
 */
export function summarizeImportResult(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const imported = Math.max(
    0,
    Math.floor(Number(payload.imported ?? payload.nodesAdded ?? payload.nodeCount ?? payload.nodes?.length) || 0),
  );
  const total = Math.max(
    Math.max(0, Math.floor(Number(payload.total) || 0)),
    imported + countSkippedNodes(skipped),
  );
  if (!imported && !skipped.length && !warnings.length) {
    return { total, imported, skipped, warnings, text: '', partial: false };
  }
  return {
    total,
    imported,
    skipped,
    warnings,
    text: formatImportSummary({ total, imported, skipped, warnings }),
    partial: skipped.length > 0 || warnings.length > 0,
  };
}

export class VpnError extends Error {
  constructor(code, { message, detail } = {}) {
    super(message || ERROR_TEXT[code] || ERROR_TEXT.internal);
    this.name = 'VpnError';
    this.code = ERROR_TEXT[code] ? code : 'internal';
    if (detail !== undefined) this.detail = String(detail).slice(0, 240);
  }
}

export function toErrorCode(error) {
  if (error instanceof VpnError) return error.code;
  if (typeof error?.code === 'string' && ERROR_TEXT[error.code]) return error.code;
  return 'internal';
}

export function ok(value) {
  return { ok: true, value };
}

export function fail(error) {
  const code = toErrorCode(error);
  const message = error instanceof VpnError && error.message
    ? error.message
    : ERROR_TEXT[code] || ERROR_TEXT.internal;
  return { ok: false, error: code, message };
}

/** 从节点名称推断标签（仅用于界面分组和自动池筛选，不作为路由安全边界）。 */
export function inferNodeTags(name) {
  const text = String(name || '');
  const tags = new Set();
  if (/\bgpt\b|chatgpt|openai/i.test(text)) tags.add('gpt');
  if (/gemini|google|bard/i.test(text)) tags.add('gemini');
  if (/家宽|住宅|residential|\bisp\b/i.test(text)) tags.add('residential');
  if (/ipv6|\bv6\b/i.test(text)) tags.add('ipv6');
  return [...tags];
}

/** 根据节点名称提取地区或国旗提示，用于展示。 */
export function inferNodeRegion(name) {
  const text = String(name || '');
  const rules = [
    [/台湾|台北|新北|\btaiwan\b|\btw\b|🇹🇼/i, '台湾'],
    [/日本|东京|大阪|\bjapan\b|\bjp\b|🇯🇵/i, '日本'],
    [/美国|洛杉矶|硅谷|圣何塞|纽约|\busa\b|\bus\b|🇺🇸/i, '美国'],
    [/新加坡|狮城|\bsingapore\b|\bsg\b|🇸🇬/i, '新加坡'],
    [/香港|\bhong\s?kong\b|\bhk\b|🇭🇰/i, '香港'],
    [/韩国|首尔|\bkorea\b|\bkr\b|🇰🇷/i, '韩国'],
    [/英国|伦敦|\buk\b|\bgb\b|🇬🇧/i, '英国'],
    [/德国|法兰克福|\bgermany\b|\bde\b|🇩🇪/i, '德国'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) return label;
  }
  return '';
}

/** 对远程订阅链接脱敏，仅保留域名和路径尾部提示，不回传 token。 */
export function maskSubscriptionUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments.length ? `/${segments[0]}/…` : '';
    return `${parsed.protocol}//${parsed.host}${tail}`;
  } catch {
    return '已保存订阅';
  }
}

/** 给设置页显示的脱敏节点视图，绝不含 uuid / password / tls secret。 */
export function sanitizeNodeView(node, runtime = {}) {
  const id = String(node?.id || '');
  const name = String(node?.name || '未命名节点');
  const type = String(node?.type || node?.raw?.type || 'unknown').toLowerCase();
  const port = Number(node?.port || node?.raw?.port || 0);
  const server = String(node?.server || node?.raw?.server || '');
  const maskedServer = server.length > 8 ? `${server.slice(0, 4)}…${server.slice(-3)}` : server;
  const tags = Array.isArray(node?.tags) ? node.tags : inferNodeTags(name);
  const delayInfo = runtime.delays && typeof runtime.delays === 'object' ? runtime.delays[id] : null;
  const cooldownUntil = runtime.cooldowns && Number.isFinite(runtime.cooldowns[id]) ? runtime.cooldowns[id] : 0;
  return {
    id,
    name,
    type,
    transport: String(node?.transport || node?.raw?.transport || node?.raw?.network || ''),
    tags,
    region: String(node?.region || inferNodeRegion(name)),
    sourceId: String(node?.sourceId || ''),
    sourceLabel: String(node?.sourceLabel || ''),
    serverHint: maskedServer && port ? `${maskedServer}:${port}` : maskedServer,
    delayMs: typeof delayInfo?.delayMs === 'number' ? delayInfo.delayMs : null,
    delayStatus: delayInfo?.status || 'untested',
    delayAt: typeof delayInfo?.at === 'number' ? delayInfo.at : 0,
    cooldownUntil,
  };
}

/** 给设置页显示的脱敏订阅/导入源视图。 */
export function sanitizeSubscriptionView(sub) {
  return {
    id: String(sub?.id || ''),
    kind: String(sub?.kind || 'clipboard'),
    name: String(sub?.name || '导入线路'),
    urlHint: sub?.url ? maskSubscriptionUrl(sub.url) : '',
    updatedAt: Number(sub?.updatedAt || 0),
    nodeCount: Number(sub?.nodeCount || 0),
    usage: sub?.usage && typeof sub.usage === 'object' ? { ...sub.usage } : null,
    lastError: typeof sub?.lastError === 'string' ? sub.lastError : '',
  };
}

/**
 * 归一化一条「模型 → 线路」指向（Provider 默认路由与单模型覆盖共用同一形状）。
 *
 * 为什么放在 contract：`store.mjs` 用它做输入校验，`router.mjs` 用它做解析，
 * 两处必须完全一致——分成两份实现时，一边放宽的非法值另一边会直接当直连处理，
 * 用户就会看到「明明分配了线路却没走代理」。
 *
 * @param {unknown} raw
 * @returns {{ mode: string, failover: boolean, poolId?: string, nodeId?: string }}
 */
export function normalizeRouteTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mode: 'direct', failover: true };
  const mode = ROUTE_MODES.includes(raw.mode) ? raw.mode : 'direct';
  const out = {
    mode,
    failover: raw.failover !== false,
  };
  if (mode === 'pool' && typeof raw.poolId === 'string' && raw.poolId.trim()) {
    out.poolId = raw.poolId.trim().slice(0, 80);
  }
  if (mode === 'node' && typeof raw.nodeId === 'string' && raw.nodeId.trim()) {
    out.nodeId = raw.nodeId.trim().slice(0, 80);
  }
  return out;
}

/** 单模型覆盖的键：`providerId/modelId`（与 store 的归一化规则一致）。 */
export function modelOverrideKey(providerId, modelId) {
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!provider) return '';
  return model ? `${provider}/${model}` : '';
}

/** 线路目标的稳定键：策略池 `pool:<id>`、固定节点 `node:<id>`。 */
export function routeTargetKey(target) {
  if (!target || typeof target !== 'object') return '';
  if (target.mode === 'pool' && target.poolId) return `pool:${target.poolId}`;
  if (target.mode === 'node' && target.nodeId) return `node:${target.nodeId}`;
  return '';
}

/**
 * 开机自启的判定（纯函数）。
 *
 * 只有「用户开着 `core.autoStart` 且内核没在跑」才该启动。抽出来单独放这里是因为
 * 真正的启动要拉子进程、写配置、开监听端口，测试里跑不动，但「什么情况下该启动」
 * 恰恰是最容易写错的地方（例如把 autoStart 缺省当成关，或者已经在跑还重复启动）。
 *
 * @param {{ autoStart?: boolean, running?: boolean }} [input]
 * @returns {{ start: boolean, reason: 'disabled'|'already_running'|'start' }}
 */
export function shouldAutoStartCore({ autoStart = false, running = false } = {}) {
  if (autoStart !== true) return { start: false, reason: 'disabled' };
  if (running === true) return { start: false, reason: 'already_running' };
  return { start: true, reason: 'start' };
}

/** 构造默认空配置（未配置内核与路由时的合法基线）。 */export function createDefaultRoutesConfig() {
  return {
    version: 1,
    core: {
      mode: 'managed',
      binaryPath: '',
      fallbackProxyUrl: 'http://127.0.0.1:7890',
      controllerPort: 17900,
      baseListenerPort: 17901,
      testUrl: DEFAULT_TEST_URL,
      autoStart: true,
    },
    pools: [],
    routes: {},
    modelOverrides: {},
  };
}
