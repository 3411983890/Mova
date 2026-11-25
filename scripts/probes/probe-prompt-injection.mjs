/**
 * 负责：抓出两条订阅通道「真正发出去的提示词」——
 *   ① Codex（ChatGPT 订阅，pi-ai 自建循环）：runChatAgent 组装的 systemPrompt 原文（两种能力档位）；
 *   ② Codex 的线上形态：把同一段文本交给 pi-ai 的 openai-codex-responses，抓请求体（instructions 等）；
 *   ③ Gemini（ACP，`agy acp`）：composeAcpPrompt 拼出来的那一条 session/prompt 文本。
 * 不负责：任何真实网络请求（fetch 全部被替换成捕获器），也不改仓库里的源码。
 * 被谁调用：人手排查用 `node scripts/probes/probe-prompt-injection.mjs`。
 *
 * 为什么用「替换 fetch」而不是读日志：提示词从来没有落盘，唯一的真相在请求体里。
 * runChatAgent 的 `fetchModel` 是注入的依赖，所以拦在发请求之前就能拿到逐字文本。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = resolve(root, '.test-temp/prompt-probe');

const { runChatAgent } = await import('../../electron/chat-agent.mjs');
const { composeAcpPrompt, buildAcpConversationContext } = await import('../../electron/chat-agent-prompt.mjs');
const { attachmentTextBlocks, imageLocationBlocks } = await import('../../electron/services/attachment-text.mjs');

/**
 * 请求体在不同调用点有三种形态：字符串、Uint8Array/ArrayBuffer（pi-ai 复制过一份）、ReadableStream。
 * codex 通道还会用 zstd 压缩正文（见 dist/api/openai-codex-responses.js 的 compressRequestBodyZstd），
 * 所以解 JSON 失败时再试一次解压。解不开就返回可读的描述（绝不静默返回 null，那会让报告失真）。
 */
function parseBody(raw, headers) {
  if (raw === undefined || raw === null) return null;
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  const text = typeof bytes === 'string' ? bytes
    : bytes instanceof Uint8Array ? Buffer.from(bytes).toString('utf8') : null;
  if (text === null) return { unsupportedBodyType: bytes?.constructor?.name ?? typeof bytes };
  try { return JSON.parse(text); } catch { /* 可能是压缩过的 */ }
  try {
    const zlib = process.getBuiltinModule('node:zlib');
    if (typeof zlib?.zstdDecompressSync === 'function') {
      return JSON.parse(zlib.zstdDecompressSync(bytes instanceof Uint8Array ? bytes : Buffer.from(text, 'utf8')).toString('utf8'));
    }
  } catch { /* 落到下面 */ }
  return {
    undecodable: true,
    contentEncoding: String(new Headers(headers ?? {}).get('content-encoding') ?? ''),
    head: text.slice(0, 40),
  };
}

/** systemPrompt 是 `[...].join(' ')` 的产物：空槽位会留下连续空格，这里保留原样不做美化。 */
const systemTextOf = body => {
  const message = (body?.messages ?? []).find(row => row.role === 'system');
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map(part => part?.text ?? '').join('\n');
};

/**
 * 跑一遍 runChatAgent，只抓请求体。
 * @param {'minimal'|'rich'} profile minimal=没有项目根 / 没有浏览器桌面；rich=登记了项目根并允许完全访问
 */
async function captureAgentPrompt(profile) {
  let captured = null;
  const deps = {
    key: 'probe-token',
    provider: { id: 'probe', protocol: 'openai', baseUrl: 'https://probe.local/v1' },
    entry: { id: 'probe-model', name: 'probe-model', efforts: [], vision: true },
    request: { messages: [{ role: 'user', text: 'probe' }] },
    signal: AbortSignal.timeout(60_000),
    emit: () => {},
    fetchModel: async (url, init) => {
      captured = { url: String(url), body: parseBody(init?.body, init?.headers) };
      throw new Error('probe-stop'); // 抓完就掐断，不发真实请求
    },
  };
  if (profile === 'rich') {
    // 形状照 electron/permissions.cjs 的 check/checkRootless；这里只回答「允许」，不碰真实权限位。
    deps.permissions = { check: () => ({ ok: true }), checkRootless: () => ({ ok: true, scope: 'rootless' }) };
    deps.projectRoots = [{ name: 'Mova', path: root }];
    deps.projectInstructions = '示例项目规则：改文件之前先说明计划。';
    deps.sessionKey = 'probe-session';
    deps.historyDir = resolve(outDir, 'history');
    deps.approvalPreset = 'full';
    deps.memorySearch = async () => ([{ id: '3f9a2c7d1b4e', text: '用户偏好中文回复。', source: 'memory_write' }]);
  }
  try { await runChatAgent(deps); } catch (error) {
    if (process.env.PROBE_VERBOSE) console.error(`${profile}:`, error?.message || error);
  }
  return captured;
}

const minimal = await captureAgentPrompt('minimal');
const rich = await captureAgentPrompt('rich');
if (!minimal) {
  console.error('没能抓到 pi-ai 请求体：runChatAgent 在构造 Agent 之前就失败了');
  process.exit(1);
}

const minimalPrompt = systemTextOf(minimal.body);
const richPrompt = rich ? systemTextOf(rich.body) : '';

// ── ② Codex 线上形态：同一段文本交给 pi-ai 的 codex 适配器，抓 instructions ──────
let codexWire = null;
try {
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-codex-responses');
  // pi-ai 从 access token 的 JWT 里解 `chatgpt-account-id`：给一个签名无意义的假令牌即可，
  // 因为下面的 fetch 已经是捕获器，请求不会真的发出去。
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const fakeJwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'probe-account' } })}.probe`;
  const stream = streamSimple({
    id: 'gpt-5.6-luna', name: 'GPT-5.6', api: 'openai-codex-responses',
    provider: 'mova-subscription-chatgpt', baseUrl: 'https://chatgpt.com/backend-api',
    input: ['text', 'image'], reasoning: true,
    thinkingLevelMap: { off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000, maxTokens: 128_000,
  }, {
    // 注意：pi-ai 的 codex 适配器只从 messages 里找 system 消息（resolveTranscript → collapseSystemMessages），
    // 不读 `context.systemPrompt`。高层 Agent 会先把 systemPrompt 折成 messages[0]，这里照抄那个形态。
    messages: [
      { role: 'system', content: minimalPrompt, timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'probe' }], timestamp: Date.now() },
    ],
    tools: [],
  }, {
    apiKey: fakeJwt, reasoning: 'medium', transport: 'sse',
    fetch: async (url, init) => {
      codexWire = { url: String(url), body: parseBody(init?.body, init?.headers) };
      throw new Error('probe-stop');
    },
  });
  await Promise.race([
    (async () => { for await (const event of stream) { if (event?.type === 'error' && process.env.PROBE_VERBOSE) console.error('codex:', event?.error?.errorMessage); } })(),
    new Promise(done => setTimeout(done, 3_000)),
  ]);
} catch (error) { if (process.env.PROBE_VERBOSE) console.error('codex wire:', error?.message || error); }

// ── ③ Gemini：composeAcpPrompt 的真实产物 ────────────────────────────────
const files = attachmentTextBlocks([
  { kind: 'text', name: '需求.md', mime: 'text/markdown', size: 1284, text: '# 需求\n\n1. 列表要能搜索\n2. 删除要二次确认\n' },
]);
// 图片在 ACP 支路不是 image block，而是「落盘后的绝对路径 + 让 CLI 自己读」这一块。
// 用固定的 64 位 id 模拟一个真实的 chat-images 文件名（真实 id 就是 sha256 + 扩展名）。
const images = imageLocationBlocks([{
  name: '截图.png', mime: 'image/png', size: 239_616,
  path: `C:\\Users\\34119\\AppData\\Roaming\\Mova\\chat-images\\${'9c1f'.repeat(16)}.png`,
}]);
const geminiPrompt = composeAcpPrompt(
  ['帮我把这个需求拆成任务', ...files.blocks, ...images].join('\n\n'),
  buildAcpConversationContext({
    messages: [
      { role: 'user', text: '我在做 Mova 的设置页' },
      { role: 'assistant', text: '好的，先看现有结构再改。' },
    ],
    memory: [{ id: '3f9a2c7d1b4e', text: '用户偏好中文回复，代码风格要求 kebab-case 文件名。', source: 'memory_write', updatedAt: Date.UTC(2026, 10, 12) }],
  }),
);

const payload = {
  capturedAt: new Date().toISOString(),
  codex: {
    minimal: { chars: minimalPrompt.length, systemPrompt: minimalPrompt, envelope: minimal.body },
    rich: { chars: richPrompt.length, systemPrompt: richPrompt, envelope: rich?.body ?? null },
    wire: codexWire,
  },
  gemini: { chars: geminiPrompt.length, prompt: geminiPrompt },
};

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'prompt-injection.json'), JSON.stringify(payload, null, 2), 'utf8');
await writeFile(resolve(outDir, 'codex-system-prompt-minimal.txt'), minimalPrompt, 'utf8');
if (richPrompt) await writeFile(resolve(outDir, 'codex-system-prompt-rich.txt'), richPrompt, 'utf8');
await writeFile(resolve(outDir, 'gemini-prompt.txt'), geminiPrompt, 'utf8');

console.log(`codex systemPrompt（无能力档）: ${minimalPrompt.length} 字符`);
console.log(`codex systemPrompt（项目+完全访问）: ${richPrompt ? `${richPrompt.length} 字符` : '未捕获'}`);
console.log(`codex wire instructions: ${codexWire ? `${codexWire.body.instructions.length} 字符` : '未捕获'}`);
console.log(`gemini prompt: ${geminiPrompt.length} 字符`);
console.log(`写出：${outDir}`);
