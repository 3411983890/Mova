/**
 * 线路配置与订阅格式解析器。
 *
 * 负责：解析 Clash/Mihomo YAML（含 `proxies:`）、Base64 订阅正文、多行分享链接
 * （vless / vmess / trojan / ss / hy2 / hysteria2 / tuic / mieru / anytls），并识别订阅 URL。
 * 不负责：网络请求与加密落盘（由 ipc / store 负责）。
 *
 * 重要约束（真实订阅实测教训）：**解析不出节点不能静默消失**。
 * `parseImportPayload` 因此返回 `{ nodes, warnings, skipped, total }`，把「不支持的协议」、
 * 「hysteria2 端口跳跃范围非法」这类事实交给 UI 与调用方，而不是只写一行 console。
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import {
  SUPPORTED_PROTOCOLS,
  VpnError,
  formatImportSummary,
  inferNodeRegion,
  inferNodeTags,
} from './contract.mjs';

const NODE_URI_RE = /^(vless|vmess|trojan|ss|hy2|hysteria2|tuic|mieru|anytls):\/\//i;
/** 任意 `scheme://`：用来把「不认识的协议」记进 `skipped`，而不是当普通文本忽略。 */
const ANY_URI_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const HTTP_URL_RE = /^https?:\/\/[^\s"'<>]+$/i;

function firstNonEmpty(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function decodeBase64Utf8(text) {
  const clean = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) return null;
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    // 排除把普通非 Base64 文本强行解码出大量替换字符的情况
    if (!decoded || decoded.includes('\uFFFD')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 为节点生成确定性短 ID（基于名称、协议、服务器与端口，不含密码原文）。
 *
 * 端口跳跃（`ports`）存在时，authority 里的端口只是服务端随机给的兜底值：
 * 每次拉订阅都可能变，把它算进哈希会让节点 ID 随刷新漂移、既有路由与策略池全部失效。
 */
export function buildNodeId(rawProxy, sourceId = '') {
  const ports = typeof rawProxy?.ports === 'string' ? rawProxy.ports.trim() : '';
  const hash = createHash('sha256')
    .update(JSON.stringify({
      sourceId: String(sourceId || ''),
      name: String(rawProxy?.name || ''),
      type: String(rawProxy?.type || ''),
      server: String(rawProxy?.server || ''),
      ...(ports
        ? { ports }
        : { port: Number(rawProxy?.port || 0) || String(rawProxy?.['port-range'] || '') }),
    }))
    .digest('hex')
    .slice(0, 16);
  return `node_${hash}`;
}

/** 把任意解析出来的 raw Mihomo proxy 规范化为内部节点对象。 */
export function normalizeProxyRecord(rawProxy, meta = {}) {
  if (!rawProxy || typeof rawProxy !== 'object' || Array.isArray(rawProxy)) return null;
  const typeRaw = String(rawProxy.type || '').trim().toLowerCase();
  const type = typeRaw === 'hy2' ? 'hysteria2' : typeRaw;
  if (!SUPPORTED_PROTOCOLS.includes(type) && type !== 'socks5' && type !== 'http') return null;

  const name = firstNonEmpty(rawProxy.name, rawProxy.remarks, `${type}-${rawProxy.server || 'node'}`);
  const server = firstNonEmpty(rawProxy.server, rawProxy.host);
  const port = asInt(rawProxy.port);
  const portRange = typeof rawProxy['port-range'] === 'string' ? rawProxy['port-range'].trim() : '';
  // hysteria2 的端口跳跃范围（Mihomo 字段名 `ports`）：有它就说明「地址可用」，
  // 即便 authority 端口缺失也不该把节点丢掉。
  const jumpPorts = typeof rawProxy.ports === 'string' ? rawProxy.ports.trim() : '';
  if (!server || (!port && !portRange && !jumpPorts)) return null;

  const raw = { ...rawProxy, type, name, server, ...(port ? { port } : {}) };
  const id = buildNodeId(raw, meta.sourceId);
  return {
    id,
    name,
    type,
    server,
    port: port || Number(portRange.split('-')[0]) || Number(jumpPorts.split(/[-,\s]/)[0]) || 0,
    transport: firstNonEmpty(raw.transport, raw.network),
    tags: inferNodeTags(name),
    region: inferNodeRegion(name),
    sourceId: String(meta.sourceId || ''),
    sourceLabel: String(meta.sourceLabel || ''),
    raw,
  };
}

/**
 * 解析单个 vless:// 分享链接。
 *
 * reality 三件套（`pbk` / `sid` / `flow`）必须保留：少了 `pbk` 的 reality 节点
 * 能导入但一定握手失败。只要 URI 里出现 `pbk`/`sid` 就写 `reality-opts`，
 * 不依赖 `security=reality` 是否拼对。
 */
function parseVlessUri(uri) {
  const parsed = new URL(uri);
  const params = parsed.searchParams;
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${parsed.hostname}:${parsed.port || 443}`;
  const network = firstNonEmpty(params.get('type'), 'tcp').toLowerCase();
  const security = firstNonEmpty(params.get('security'), 'none').toLowerCase();
  const sni = firstNonEmpty(params.get('sni'), params.get('peer'));
  const pbk = firstNonEmpty(params.get('pbk'), params.get('public-key'));
  const sid = firstNonEmpty(params.get('sid'), params.get('short-id'));
  const insecure = asBool(params.get('allowInsecure')) || asBool(params.get('insecure'));
  const raw = {
    name,
    type: 'vless',
    server: parsed.hostname,
    port: asInt(parsed.port, 443),
    uuid: decodeURIComponent(parsed.username),
    udp: true,
    tls: security === 'tls' || security === 'reality' || Boolean(pbk),
    ...(network !== 'tcp' ? { network } : {}),
    ...(params.get('flow') ? { flow: params.get('flow') } : {}),
    ...(sni ? { servername: sni } : {}),
    ...(params.get('fp') ? { 'client-fingerprint': params.get('fp') } : {}),
    ...(insecure ? { 'skip-cert-verify': true } : {}),
  };
  const alpn = params.get('alpn');
  if (alpn) raw.alpn = alpn.split(',').map(s => s.trim()).filter(Boolean);
  if (pbk || sid) {
    raw['reality-opts'] = {
      ...(pbk ? { 'public-key': pbk } : {}),
      ...(sid ? { 'short-id': sid } : {}),
    };
  }
  if (network === 'ws') {
    const path = params.get('path') || '/';
    const host = params.get('host');
    raw['ws-opts'] = { path, ...(host ? { headers: { Host: host } } : {}) };
  } else if (network === 'grpc') {
    const serviceName = params.get('serviceName');
    if (serviceName) raw['grpc-opts'] = { 'grpc-service-name': serviceName };
  }
  return raw;
}

/** 解析 vmess:// Base64 JSON 链接。 */
function parseVmessUri(uri) {
  const body = uri.slice('vmess://'.length).trim();
  const jsonText = decodeBase64Utf8(body);
  if (!jsonText) return null;
  const info = JSON.parse(jsonText);
  const name = firstNonEmpty(info.ps, `${info.add}:${info.port}`);
  const network = firstNonEmpty(info.net, 'tcp').toLowerCase();
  const raw = {
    name,
    type: 'vmess',
    server: String(info.add || '').trim(),
    port: asInt(info.port, 443),
    uuid: String(info.id || '').trim(),
    alterId: Number(info.aid || 0) || 0,
    cipher: firstNonEmpty(info.scy, 'auto'),
    udp: true,
    tls: String(info.tls || '').toLowerCase() === 'tls',
    ...(network !== 'tcp' ? { network } : {}),
    ...(info.sni ? { servername: String(info.sni).trim() } : {}),
  };
  if (network === 'ws') {
    raw['ws-opts'] = {
      path: firstNonEmpty(info.path, '/'),
      ...(info.host ? { headers: { Host: String(info.host).trim() } } : {}),
    };
  }
  return raw;
}

/** 解析 trojan:// 链接。 */
function parseTrojanUri(uri) {
  const parsed = new URL(uri);
  const params = parsed.searchParams;
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${parsed.hostname}:${parsed.port || 443}`;
  const network = firstNonEmpty(params.get('type'), 'tcp').toLowerCase();
  const sni = firstNonEmpty(params.get('sni'), params.get('peer'));
  const raw = {
    name,
    type: 'trojan',
    server: parsed.hostname,
    port: asInt(parsed.port, 443),
    password: decodeURIComponent(parsed.username),
    udp: true,
    ...(sni ? { sni } : {}),
    ...(asBool(params.get('allowInsecure')) ? { 'skip-cert-verify': true } : {}),
    ...(network !== 'tcp' ? { network } : {}),
  };
  if (network === 'ws') {
    raw['ws-opts'] = {
      path: params.get('path') || '/',
      ...(params.get('host') ? { headers: { Host: params.get('host') } } : {}),
    };
  }
  return raw;
}

/** 解析 ss:// (SIP002 或遗留 Base64) 链接。 */
function parseSsUri(uri) {
  const hashIndex = uri.indexOf('#');
  const name = hashIndex >= 0 ? decodeURIComponent(uri.slice(hashIndex + 1)).trim() : '';
  const main = (hashIndex >= 0 ? uri.slice(0, hashIndex) : uri).slice('ss://'.length);
  const atIndex = main.lastIndexOf('@');
  if (atIndex > 0) {
    const userPart = main.slice(0, atIndex);
    const hostPortRaw = main.slice(atIndex + 1).split('?')[0];
    const decodedUser = userPart.includes(':') ? decodeURIComponent(userPart) : decodeBase64Utf8(userPart);
    if (!decodedUser || !decodedUser.includes(':')) return null;
    const colon = decodedUser.indexOf(':');
    const cipher = decodedUser.slice(0, colon);
    const password = decodedUser.slice(colon + 1);
    const parsedHost = new URL(`http://${hostPortRaw}`);
    return {
      name: name || `${parsedHost.hostname}:${parsedHost.port}`,
      type: 'ss',
      server: parsedHost.hostname,
      port: asInt(parsedHost.port, 8388),
      cipher,
      password,
      udp: true,
    };
  }
  const decodedAll = decodeBase64Utf8(main);
  if (!decodedAll) return null;
  const fullAt = decodedAll.lastIndexOf('@');
  if (fullAt <= 0) return null;
  const creds = decodedAll.slice(0, fullAt);
  const hostPort = decodedAll.slice(fullAt + 1);
  const colon = creds.indexOf(':');
  if (colon <= 0) return null;
  const parsedHost = new URL(`http://${hostPort}`);
  return {
    name: name || `${parsedHost.hostname}:${parsedHost.port}`,
    type: 'ss',
    server: parsedHost.hostname,
    port: asInt(parsedHost.port, 8388),
    cipher: creds.slice(0, colon),
    password: creds.slice(colon + 1),
    udp: true,
  };
}

/**
 * 校验 hysteria2 的端口跳跃范围。
 *
 * 接受：`50000-60000`、`50000-60000,51000-52000`（多段，逗号分隔）、单端口 `443`。
 * 拒绝：非数字、缺一半（`50000-`）、越界（>65535）、逆序/相等（`60000-50000`）、
 * 段与段交叉重叠——Mihomo 遇到这种 `ports` 会直接拒绝整份配置，
 * 因此宁可只留 authority 端口并报警，也不把非法范围写进 YAML。
 *
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function validatePortRange(text) {
  const rawText = String(text ?? '').trim();
  if (!rawText) return { ok: false, reason: '空值' };
  const ranges = [];
  for (const segment of rawText.split(',').map(item => item.trim())) {
    if (!segment) return { ok: false, reason: '存在空段' };
    const parts = segment.split('-');
    if (parts.length > 2) return { ok: false, reason: `段 ${segment} 格式不正确` };
    if (!parts.every(part => /^\d{1,5}$/.test(part))) {
      return { ok: false, reason: `段 ${segment} 不是数字端口` };
    }
    const from = Number(parts[0]);
    const to = parts.length === 2 ? Number(parts[1]) : from;
    if (from < 1 || to > 65535) return { ok: false, reason: `段 ${segment} 超出 1-65535` };
    if (from > to) return { ok: false, reason: `段 ${segment} 起止端倒序` };
    ranges.push([from, to]);
  }
  const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index][0] <= ordered[index - 1][1]) {
      return { ok: false, reason: '多段范围相互交叉' };
    }
  }
  return { ok: true, value: rawText };
}

/**
 * 解析 hy2:// / hysteria2:// 链接。
 *
 * 端口跳跃：`mport`（也接受 `ports`）才是真正的跳跃范围，authority 里的端口是服务端
 * 每次随机给的兜底值。Mihomo 用 `ports: "50000-60000"` 表达跳跃，`port` 同时保留。
 */
function parseHysteria2Uri(uri) {
  const parsed = new URL(uri.replace(/^hy2:\/\//i, 'hysteria2://'));
  const params = parsed.searchParams;
  const warnings = [];
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${parsed.hostname}:${parsed.port || 443}`;
  const port = asInt(parsed.port, 443);
  const raw = {
    name,
    type: 'hysteria2',
    server: parsed.hostname,
    port,
    password: decodeURIComponent(parsed.username),
    ...(params.get('sni') ? { sni: params.get('sni') } : {}),
    ...(params.get('obfs') ? { obfs: params.get('obfs') } : {}),
    ...(params.get('obfs-password') ? { 'obfs-password': params.get('obfs-password') } : {}),
    ...(asBool(params.get('insecure')) ? { 'skip-cert-verify': true } : {}),
  };
  const jump = firstNonEmpty(params.get('mport'), params.get('ports'));
  if (jump) {
    const verdict = validatePortRange(jump);
    if (verdict.ok) raw.ports = verdict.value;
    else {
      warnings.push({
        code: 'invalid_port_range',
        detail: `hysteria2 的端口跳跃范围无效（${jump}）：${verdict.reason}；已回落单端口 ${port}`,
      });
    }
  }
  return { proxy: raw, warnings };
}

/**
 * 解析 anytls:// 链接（Mihomo v1.19+）。
 *
 * URI 的 username 部分就是密码（没有独立 password 字段），字段集与 trojan 近似：
 * `sni` / `skip-cert-verify` / `alpn` / `client-fingerprint`。
 * 缺服务器或密码时不生成半截 proxy（那一定连不上），改为上报 warning。
 */
function parseAnytlsUri(uri) {
  const parsed = new URL(uri);
  const params = parsed.searchParams;
  const server = String(parsed.hostname || '').trim();
  const port = asInt(parsed.port, 443);
  const password = decodeURIComponent(parsed.username || '');
  if (!server || !password) {
    return {
      proxy: null,
      warnings: [{
        code: 'missing_required_fields',
        detail: 'anytls 链接缺少服务器或密码（URI 的 username 部分即密码）',
      }],
    };
  }
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${server}:${port}`;
  const sni = firstNonEmpty(params.get('sni'), params.get('peer'));
  const insecure = asBool(params.get('insecure')) || asBool(params.get('allow_insecure'));
  const raw = {
    name,
    type: 'anytls',
    server,
    port,
    password,
    udp: true,
    ...(sni ? { sni } : {}),
    ...(insecure ? { 'skip-cert-verify': true } : {}),
    ...(params.get('fp') ? { 'client-fingerprint': params.get('fp') } : {}),
  };
  const alpn = params.get('alpn');
  if (alpn) {
    const list = alpn.split(',').map(item => item.trim()).filter(Boolean);
    if (list.length) raw.alpn = list;
  }
  return { proxy: raw, warnings: [] };
}

/** 解析 tuic:// 链接。 */
function parseTuicUri(uri) {
  const parsed = new URL(uri);
  const params = parsed.searchParams;
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${parsed.hostname}:${parsed.port || 443}`;
  const raw = {
    name,
    type: 'tuic',
    server: parsed.hostname,
    port: asInt(parsed.port, 443),
    uuid: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ...(params.get('sni') ? { sni: params.get('sni') } : {}),
    ...(params.get('congestion_control') ? { 'congestion-controller': params.get('congestion_control') } : {}),
    ...(params.get('udp_relay_mode') ? { 'udp-relay-mode': params.get('udp_relay_mode') } : {}),
    ...(asBool(params.get('allow_insecure')) ? { 'skip-cert-verify': true } : {}),
  };
  const alpn = params.get('alpn');
  if (alpn) raw.alpn = alpn.split(',').map(s => s.trim()).filter(Boolean);
  return raw;
}

/** 解析 mieru:// 链接（支持常见查询参数 transport / multiplexing / port-range）。 */
function parseMieruUri(uri) {
  const parsed = new URL(uri);
  const params = parsed.searchParams;
  const name = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim() || `${parsed.hostname}:${parsed.port || 443}`;
  const transport = firstNonEmpty(params.get('transport'), params.get('protocol'), 'TCP').toUpperCase();
  const multiplexing = firstNonEmpty(params.get('multiplexing'), params.get('mux'));
  const portRange = firstNonEmpty(params.get('port-range'), params.get('portRange'));
  return {
    name,
    type: 'mieru',
    server: parsed.hostname,
    ...(portRange ? { 'port-range': portRange } : { port: asInt(parsed.port, 443) }),
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    transport,
    ...(multiplexing ? { multiplexing } : {}),
  };
}

/**
 * 尝试把单条 URI 解析为原始 Mihomo proxy 对象，并带上解析期的 warning。
 *
 * @returns {{ proxy: object|null, warnings: { code: string, detail: string }[] } | null}
 *   `null` 表示这行压根不是节点链接（scheme 不认识）。
 */
function parseUriDetailed(line) {
  const trimmed = String(line || '').trim();
  if (!NODE_URI_RE.test(trimmed)) return null;
  const scheme = trimmed.slice(0, trimmed.indexOf('://')).toLowerCase();
  try {
    if (scheme === 'vless') return { proxy: parseVlessUri(trimmed), warnings: [] };
    if (scheme === 'vmess') return { proxy: parseVmessUri(trimmed), warnings: [] };
    if (scheme === 'trojan') return { proxy: parseTrojanUri(trimmed), warnings: [] };
    if (scheme === 'ss') return { proxy: parseSsUri(trimmed), warnings: [] };
    if (scheme === 'hy2' || scheme === 'hysteria2') return parseHysteria2Uri(trimmed);
    if (scheme === 'tuic') return { proxy: parseTuicUri(trimmed), warnings: [] };
    if (scheme === 'mieru') return { proxy: parseMieruUri(trimmed), warnings: [] };
    if (scheme === 'anytls') return parseAnytlsUri(trimmed);
    return { proxy: null, warnings: [] };
  } catch {
    return { proxy: null, warnings: [{ code: 'parse_failed', detail: `${scheme} 链接无法解析` }] };
  }
}

/** 尝试把单条 URI 解析为原始 Mihomo proxy 对象（失败返回 null）。 */
export function parseProxyUri(line) {
  return parseUriDetailed(line)?.proxy ?? null;
}

/**
 * 解析 Clash/Mihomo YAML 文本（完整配置文件或仅 proxies 列表片段）。
 * @returns {{ proxies: object[], groups: object[] }}
 */
export function parseClashYaml(text) {
  const doc = YAML.parse(String(text || ''));
  if (!doc) return { proxies: [], groups: [] };
  if (Array.isArray(doc)) {
    return { proxies: doc.filter(item => item && typeof item === 'object'), groups: [] };
  }
  if (typeof doc === 'object') {
    if (Array.isArray(doc.proxies)) {
      return {
        proxies: doc.proxies.filter(item => item && typeof item === 'object'),
        groups: Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [],
      };
    }
    if (doc.type && doc.server) {
      return { proxies: [doc], groups: [] };
    }
  }
  return { proxies: [], groups: [] };
}

/** 从不支持的链接里取一个可展示的样本名（只取 `#` 片段，绝不含凭据）。 */
function sampleNameOf(line) {
  const text = String(line || '');
  const hashIndex = text.indexOf('#');
  if (hashIndex < 0) return '';
  try {
    return decodeURIComponent(text.slice(hashIndex + 1)).trim().slice(0, 60);
  } catch {
    return '';
  }
}

/** 同类 warning 合并成一条（`count` 记真实条数），避免 UI 里刷一屏重复文案。 */
function mergeWarnings(list) {
  const out = [];
  const byCode = new Map();
  for (const item of list) {
    if (!item?.code) continue;
    const existing = byCode.get(item.code);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const record = { code: item.code, detail: String(item.detail || ''), count: 1 };
    byCode.set(item.code, record);
    out.push(record);
  }
  return out;
}

/**
 * 逐行分类节点链接：能解析的进 `nodes`，不认识的 scheme 进 `skipped`（按 scheme 聚合），
 * 解析失败/缺字段的进 `warnings`。`total` = 被当作「节点候选行」的条数。
 */
function collectUriLines(lines, meta) {
  const nodes = [];
  const warnings = [];
  const skipped = new Map();
  let total = 0;
  for (const line of lines) {
    const schemeMatch = ANY_URI_RE.exec(line);
    if (!schemeMatch) continue;
    const scheme = schemeMatch[1].toLowerCase();
    // http(s) 是订阅链接，不是节点；单行订阅 URL 已在上一步单独识别。
    if (scheme === 'http' || scheme === 'https') continue;
    total += 1;
    if (!NODE_URI_RE.test(line)) {
      const record = skipped.get(scheme) ?? { scheme, reason: 'unsupported_scheme', count: 0, sampleName: '' };
      record.count += 1;
      if (!record.sampleName) record.sampleName = sampleNameOf(line);
      skipped.set(scheme, record);
      continue;
    }
    const parsed = parseUriDetailed(line) ?? { proxy: null, warnings: [] };
    warnings.push(...parsed.warnings);
    if (!parsed.proxy) {
      if (!parsed.warnings.length) warnings.push({ code: 'parse_failed', detail: `${scheme} 链接无法解析` });
      continue;
    }
    const node = normalizeProxyRecord(parsed.proxy, meta);
    if (!node) {
      warnings.push({ code: 'missing_required_fields', detail: `${scheme} 链接缺少服务器或端口` });
      continue;
    }
    nodes.push(node);
  }
  return { nodes, warnings, skipped: [...skipped.values()], total };
}

/** 把一次收集结果打包成 `parseImportPayload` 的统一返回（新字段只增不改）。 */
function packNodes(collected, groups = []) {
  return {
    kind: 'nodes',
    nodes: dedupeNodes(collected.nodes),
    groups,
    warnings: mergeWarnings(collected.warnings),
    skipped: collected.skipped,
    total: collected.total,
  };
}

/** YAML 里的 proxies → 节点；`total` 按 YAML 里的条目数算。 */
function collectYamlProxies(proxies, meta, groups = []) {
  const nodes = [];
  const warnings = [];
  for (const raw of proxies) {
    const node = normalizeProxyRecord(raw, meta);
    if (node) nodes.push(node);
    else warnings.push({ code: 'missing_required_fields', detail: `YAML 条目「${String(raw?.name || raw?.type || '未命名')}」缺少服务器或端口` });
  }
  return { nodes, warnings, skipped: [], total: proxies.length, groups };
}

/**
 * 统一解析剪切板或订阅正文文本。
 * 支持四种形态：
 * 1. 单个订阅 URL（返回 `{ kind: 'subscription-url', url }`）
 * 2. Clash/Mihomo YAML（含 `proxies:` 或单个 proxy YAML）
 * 3. Base64 编码的节点列表
 * 4. 多行 `vless://` / `mieru://` / `vmess://` / `trojan://` / `ss://` / `hy2://` /
 *    `tuic://` / `anytls://`
 *
 * 返回结构（原有 `kind`/`nodes`/`groups`/`url` 全部保留，只新增诊断字段）：
 * `{ nodes, warnings: [{ code, detail, count }], skipped: [{ scheme, reason, count, sampleName }], total }`
 */
export function parseImportPayload(rawInput, meta = {}) {
  const text = String(rawInput || '').trim();
  if (!text) throw new VpnError('empty_input');

  // 1. 单个 http/https 订阅链接（仅在非节点链接且为单行合法 URL 时识别为订阅源）
  const nonEmptyLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (nonEmptyLines.length === 1 && HTTP_URL_RE.test(nonEmptyLines[0])) {
    return {
      kind: 'subscription-url',
      url: nonEmptyLines[0],
      nodes: [],
      warnings: [],
      skipped: [],
      total: 0,
    };
  }

  // 2. 先尝试识别多行 URI（支持混合空行与注释；不认识的 scheme 也记下来）
  const direct = collectUriLines(nonEmptyLines, meta);
  if (direct.nodes.length > 0) return packNodes(direct);

  // 3. 尝试 Base64 解码（Clash / V2Ray 订阅常见 Base64 节点清单）
  let decodedRun = null;
  if (!/\s/.test(text) || nonEmptyLines.every(line => /^[A-Za-z0-9+/=_-]+$/.test(line))) {
    const decoded = decodeBase64Utf8(nonEmptyLines.join(''));
    if (decoded && decoded !== text) {
      const lines = decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      decodedRun = collectUriLines(lines, meta);
      if (decodedRun.nodes.length > 0) return packNodes(decodedRun);
      // Base64 内容也可能是整个 Clash YAML
      try {
        const { proxies, groups } = parseClashYaml(decoded);
        if (proxies.length > 0) {
          const collected = collectYamlProxies(proxies, meta, groups);
          if (collected.nodes.length > 0) return packNodes(collected, groups);
        }
      } catch { /* 继续按 YAML 尝试 */ }
    }
  }

  // 4. 尝试 Clash/Mihomo YAML 解析
  try {
    const { proxies, groups } = parseClashYaml(text);
    if (proxies.length > 0) {
      const collected = collectYamlProxies(proxies, meta, groups);
      if (collected.nodes.length > 0) return packNodes(collected, groups);
    }
  } catch (error) {
    throw new VpnError('parse_failed', { detail: error?.message || 'yaml' });
  }

  // 5. 什么都没解析出来：把原因说出来（不支持的协议 / 缺字段），而不是笼统 empty_input。
  const diagnosis = decodedRun && (decodedRun.skipped.length || decodedRun.warnings.length) ? decodedRun : direct;
  if (diagnosis && (diagnosis.skipped.length || diagnosis.warnings.length)) {
    throw new VpnError('parse_failed', {
      message: `未识别到可导入的节点：${formatImportSummary({
        total: diagnosis.total,
        imported: 0,
        skipped: diagnosis.skipped,
        warnings: mergeWarnings(diagnosis.warnings),
      })}`,
    });
  }

  throw new VpnError('empty_input');
}

/** 节点去重：同名冲突时自动附带序号后缀，避免 Mihomo 重名报错。 */
export function dedupeNodes(nodes) {
  const seenIds = new Set();
  const usedNames = new Set();
  const out = [];
  for (const node of nodes) {
    if (!node || !node.id || seenIds.has(node.id)) continue;
    seenIds.add(node.id);
    let finalName = node.name;
    let suffix = 2;
    while (usedNames.has(finalName)) {
      finalName = `${node.name} (${suffix++})`;
    }
    usedNames.add(finalName);
    out.push(finalName === node.name ? node : { ...node, name: finalName, raw: { ...node.raw, name: finalName } });
  }
  return out;
}

/** 解析订阅响应头中的 `subscription-userinfo: upload=...; download=...; total=...; expire=...`。 */
export function parseSubscriptionUserinfo(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(';')) {
    const [k, v] = part.split('=').map(s => String(s || '').trim());
    if (!k || !v) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    if (k === 'upload' || k === 'download' || k === 'total' || k === 'expire') {
      out[k] = num;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 从响应头 `content-disposition` 提取订阅名称。 */
export function parseSubscriptionName(headers, url) {
  const cd = headers && typeof headers.get === 'function' ? headers.get('content-disposition') : headers?.['content-disposition'];
  if (typeof cd === 'string') {
    const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (star?.[1]) {
      try { return decodeURIComponent(star[1].trim()); } catch { /* ignore */ }
    }
    const quoted = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
    if (quoted?.[1]) return quoted[1].trim();
  }
  try {
    return new URL(String(url)).host;
  } catch {
    return '远程订阅';
  }
}
