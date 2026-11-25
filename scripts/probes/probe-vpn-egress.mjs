/**
 * 一次性诊断探针：逐节点实测出口是否可用（真实内核 + 真实订阅）。
 *
 * 为什么单独放 probes/ 而不是 tests/：它需要真实网络、真实 mihomo 内核与本机已导入的订阅，
 * 不适合进测试门禁。用法：
 *   node scripts/probes/probe-vpn-egress.mjs --subscription <url>
 *   node scripts/probes/probe-vpn-egress.mjs --subscription <url> --rounds 2 --gap 20
 *
 * 设计要点（都是实测踩出来的）：
 * - 同一出口短时间内连打多次会被限流 → 默认每节点只打 2 个目标，并支持 --gap 间隔与 --rounds 多轮。
 * - **不要用 www.gstatic.com 当唯一目标**：实测两条健康的 anytls 美国节点对 gstatic 全失败，
 *   但对 google.com/generate_204 与 chatgpt.com 都 200。所以默认目标是 google204 + chatgpt。
 * - 只按「每个节点一个独立 listener 端口」建运行态配置，避免线路池复用导致测的不是目标节点。
 * - 输出只给「协议 / 延迟 / 出口 IP」，**绝不打印密码、uuid、pbk、订阅链接**。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = relative => pathToFileURL(join(repoRoot, relative)).href;

const { parseImportPayload } = await import(mod('electron/vpn/parser.mjs'));
const { buildRuntimeConfig } = await import(mod('electron/vpn/runtime-config.mjs'));
const { createMihomoManager } = await import(mod('electron/vpn/mihomo-manager.mjs'));

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const subscription = argOf('subscription');
const rounds = Math.max(1, Number(argOf('rounds', '1')) || 1);
const gapSeconds = Math.max(0, Number(argOf('gap', '15')) || 0);
const perTimeout = Math.max(3, Number(argOf('timeout', '18')) || 18);

if (!subscription) {
  console.error('用法：node scripts/probes/probe-vpn-egress.mjs --subscription <url> [--rounds 2] [--gap 20]');
  process.exit(2);
}

const kernel = join(process.env.APPDATA ?? '', 'Mova', 'bin', 'mihomo.exe');

/** 订阅拉取带重试：探针常在网络抖动时被调用。 */
async function fetchText(url, attempts = 4) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mova/0.1 (probe)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 800 * i));
    }
  }
  throw lastError;
}

/** 默认目标：google204（普适）+ chatgpt（渠道相关，还能给出出口 IP/loc）。 */
const probeTargets = [
  ['google204', 'https://www.google.com/generate_204'],
  ['chatgpt', 'https://chatgpt.com/cdn-cgi/trace'],
];

/** 走指定本地端口发一个请求，返回 { code, seconds, ip, loc }；不打印任何响应正文。 */
function probeVia(port, url) {
  const out = spawnSync('curl.exe', [
    '-s', '-m', String(perTimeout), '-x', `http://127.0.0.1:${port}`, url,
    '-w', '\n__META__%{http_code} %{time_total}',
  ], { encoding: 'utf8', windowsHide: true });
  const text = String(out.stdout ?? '');
  const meta = /__META__(\d+) ([\d.]+)/.exec(text);
  const body = text.replace(/__META__[\s\S]*$/, '').trim();
  return {
    code: meta ? Number(meta[1]) : 0,
    seconds: meta ? Number(meta[2]) : null,
    ip: /(?:^|\n)ip=([^\n]+)/.exec(body)?.[1] ?? '',
    loc: /(?:^|\n)loc=([^\n]+)/.exec(body)?.[1] ?? '',
  };
}

const raw = await fetchText(subscription);
const parsed = parseImportPayload(raw, { sourceId: 'probe', sourceName: 'probe-subscription' });
const nodes = parsed?.nodes ?? [];
if (!nodes.length) {
  console.error('订阅里没有解析出任何节点；skipped =', JSON.stringify(parsed?.skipped ?? []));
  process.exit(3);
}
console.log(`解析：共 ${parsed.total ?? nodes.length} 条，节点 ${nodes.length} 条，跳过 ${(parsed.skipped ?? []).length} 组`);
for (const item of parsed.skipped ?? []) console.log(`  跳过 ${item.scheme} ×${item.count}`);

const keyOf = (node, index) => node.id ?? node.raw?.name ?? `n${index}`;
const pools = nodes.map((node, index) => ({
  id: `n${index}`, name: `n${index}`, strategy: 'fallback', nodeIds: [keyOf(node, index)],
}));
const config = buildRuntimeConfig({
  core: { controllerPort: 17900, baseListenerPort: 17901, secret: 'probe-secret-0123456789abcdef', logLevel: 'warning' },
  pools,
  routes: {},
  modelOverrides: {},
  nodes: nodes.map((node, index) => ({ id: keyOf(node, index), name: node.name ?? `n${index}`, raw: node.raw ?? node })),
  occupiedPorts: [],
});

const dir = await mkdtemp(join(tmpdir(), 'mova-vpn-egress-'));
const runtimeDir = join(dir, 'rt');
await mkdir(runtimeDir, { recursive: true });
const manager = createMihomoManager({ dir: runtimeDir, binaryPath: kernel, platform: process.platform });
const started = await manager.start({ config });
if (!started.ok) {
  console.error('内核启动失败：', JSON.stringify(started));
  process.exit(4);
}
console.log(`内核已启动 pid=${started.pid}，listener ${started.listeners} 个\n`);

try {
  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1 && gapSeconds) {
      console.log(`… 间隔 ${gapSeconds}s 后开始第 ${round} 轮（避免同一出口被限流）`);
      await new Promise(resolve => setTimeout(resolve, gapSeconds * 1000));
    }
    console.log(`—— 第 ${round}/${rounds} 轮 ——`);
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const port = config.ports[`pool:n${index}`];
      const type = node.raw?.type ?? node.type ?? '?';
      if (!port) { console.log(`  [${node.name}] (${type}) 没有 listener 端口，跳过`); continue; }
      const results = [];
      for (const [label, url] of probeTargets) {
        const result = probeVia(port, url);
        const okMark = result.code > 0 && result.code < 400 ? '✓' : '✗';
        results.push(`${okMark}${label}=${result.code || 'ERR'}${result.seconds ? `/${result.seconds}s` : ''}${result.ip ? `(${result.loc}:${result.ip})` : ''}`);
      }
      console.log(`  [${node.name}] (${type}) port=${port} :: ${results.join('  ')}`);
    }
  }
} finally {
  await manager.stop();
  console.log('\n内核已停止');
}
