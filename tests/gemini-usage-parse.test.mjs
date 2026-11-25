/**
 * 负责：`/usage` 额度这条链路的真实故障点（从 CLI 输出 → 窗口列表）。
 * 不负责：真跑 CLI（那需要本机安装，属于 `scripts/probes/`）。
 * 被谁调用：`node --test`。
 *
 * 四个 bug 都是本机实测（agy 1.5.8）撞出来的，任一残留都会让额度永远显示「未知」：
 * 1) **探针目录会触发「信任这个文件夹」向导**：TUI 那条路在空目录里起不来，
 *    护栏（正确地）拒绝替你点「我信任」→ 额度永远读不到。`agy --print "/usage"` 没有这个问题。
 * 2) 面板用**绝对光标定位**画表（`\x1b[19;5H` 画进度条、`\x1b[22;1H` 跳行）。
 *    只做 stripAnsi 会把整张表压成一行，区块判定与「一行一个窗口」全部失效。
 * 3) TUI 会先画一帧 `⣷ Loading quota summary…` + 页脚，再补数据。
 *    按**第一次**页脚切面板，会把面板切成只剩「加载中」。
 * 4) 启动瞬间会先打一帧 `You are currently not signed in` + `Signing in...`，
 *    早先当成「未登录」直接放弃 —— 明明登录着也读不到额度。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRINT_TIMEOUT_MS, PROBE_TIMEOUT_MS,
  frameToText, parsePrintUsage, parseUsageOutput, probeGeminiCli, stripAnsi,
} from '../electron/subscription/gemini-usage-cli.mjs';

/** 真实字节流的浓缩版：包含光标定位、先加载后数据、末尾页脚。 */
const CAPTURE = [
  '\u001b[1m\r\n└ Models & Quota\u001b[22m\u001b[K\r\n\u001b[K\r\n  Account: real.user@gmail.com\r\n',
  '\u001b[K\u001b[2m⣷ Loading quota summary...\u001b[22m\r\n',
  '\u001b[K\u001b[2m↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · esc Close\u001b[22m\r\n',
  '\u001b[K\u001b[1m\r\nGEMINI MODELS\u001b[22m\u001b[K\r\n',
  '  \u001b[2mModels within this group: Gemini Flash, Gemini Pro\u001b[22m\r\n',
  '  \u001b[1mWeekly Limit Remaining\u001b[22m\u001b[K\u001b[19;5H[██████████\u001b[2m░░░░\u001b[22m]',
  '\u001b[2m 91.38%\u001b[22m\u001b[20;5HRefreshes in 31h 54m',
  '\u001b[22;1H  \u001b[1mFive Hour Limit Remaining\u001b[22m\u001b[K\u001b[23;5H[████]',
  '\u001b[2m 98.91%\u001b[22m\u001b[24;5HRefreshes in 4h 49m',
  '\u001b[26;1H\u001b[1mCLAUDE AND GPT MODELS\u001b[22m\u001b[K\r\n',
  '  \u001b[2mModels within this group: Claude Opus, Claude Sonnet, GPT-OSS\u001b[22m\r\n',
  '  \u001b[1mWeekly Limit Remaining\u001b[22m\u001b[K\u001b[29;5H[████]',
  '\u001b[2m 100.00%\u001b[22m\u001b[2m Quota available\u001b[22m',
  '\u001b[30;1H  \u001b[1mFive Hour Limit Remaining\u001b[22m\u001b[K\u001b[31;5H[████]',
  '\u001b[2m 100.00%\u001b[22m\u001b[2m Quota available\u001b[22m',
  '\u001b[32;1H\u001b[1mGEMINI 4 ARGON\u001b[22m\u001b[K\r\n',
  '  \u001b[1mGemini 4 Argon Weekly Limit\u001b[22m\u001b[K\u001b[35;5H[███ \u001b[2m░░░\u001b[22m]',
  '\u001b[2m 5.94%\u001b[22m\u001b[36;5HRefreshes in 32h 37m',
  '\u001b[38;1H\u001b[2m↑/↓ Scroll · pgup/pgdown Page · esc Close\u001b[22m\r\n',
].join('');

// ── 首选路径：`agy --print "/usage"`（干净 TSV、绝对重置时间、不需要信任目录）──────

test('parsePrintUsage：--print 的 TSV 直接解析，重置时间用绝对 ISO', () => {
  const sample = [
    'Gemini Models\tWeekly Limit Remaining\t91.38%\t2026-11-21T09:17:22Z',
    'Gemini Models\tFive Hour Limit Remaining\t98.91%\t2026-11-14T14:17:22Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-21T09:17:22Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t42.5%\t2026-11-14T14:17:22Z',
    'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t5.94%\t2026-11-21T09:17:22Z',
  ].join('\n');
  const checkedAt = Date.parse('2026-11-14T09:17:22Z');
  const parsed = parsePrintUsage(sample, { checkedAt });

  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.windows.length, 5);
  const byId = Object.fromEntries(parsed.windows.map(item => [item.id, item]));
  // 与 TUI 同一口径：报的是「剩余」，落盘要「已用」。
  assert.equal(byId['gemini-weekly'].usedPercent, 9);
  assert.equal(byId['3p-5h'].usedPercent, 58, '剩 42.5% → 已用 58%（四舍五入）');
  assert.equal(byId['gemini-argon-weekly'].usedPercent, 94);
  // 关键提升：重置时间是绝对时间，不用从「还有 31h 54m」倒推。
  assert.equal(byId['gemini-weekly'].resetsAt, Date.parse('2026-11-21T09:17:22Z'));
  assert.equal(byId['gemini-5h'].resetsAt, Date.parse('2026-11-14T14:17:22Z'));
});

test('parsePrintUsage：脏输入给 parseFailed，缺 ISO 时不编造重置时间', () => {
  assert.equal(parsePrintUsage('', { checkedAt: 1 }).detail, 'usage_parse_failed');
  assert.equal(parsePrintUsage('随便一段文字', { checkedAt: 1 }).detail, 'usage_parse_failed');
  const noIso = parsePrintUsage('Gemini Models\tWeekly Limit Remaining\t50%', { checkedAt: 1 });
  assert.equal(noIso.windows.length, 1);
  assert.equal(noIso.windows[0].usedPercent, 50);
  assert.equal(noIso.windows[0].resetsAt, undefined, '没有 ISO 就不能猜一个时间出来');
});

// ── 回退路径：ConPTY 抓 TUI 面板 ────────────────────────────────────────────

test('frameToText：绝对光标定位还原成行，面板不再是糊成一坨的一行', () => {
  const text = frameToText(CAPTURE);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(lines.length > 8, `行数太少（${lines.length}）：光标定位没有被还原成换行`);
  assert.ok(
    lines.some(line => /^GEMINI MODELS$/i.test(line)),
    '区块标题必须独占一行，否则 ^ 锚点的区块判定永远失效',
  );
  assert.ok(
    lines.some(line => /Weekly Limit Remaining/.test(line) && /91\.38%/.test(line)),
    '进度条、百分比、倒计时必须落在同一行（它们由光标定位拼起来）',
  );
  const plain = stripAnsi(CAPTURE).split('\n').filter(line => line.trim()).length;
  assert.ok(lines.length > plain, `frameToText 的行数应多于纯 stripAnsi（${lines.length} vs ${plain}）`);
});

test('parseUsageOutput：五个窗口全部解析出来，且百分比取「剩余 → 已用」', () => {
  const parsed = parseUsageOutput(CAPTURE, { checkedAt: 1_000 });
  assert.equal(parsed.email, 'real.user@gmail.com');
  assert.equal(parsed.windows.length, 5, `应当 5 个窗口，实际 ${parsed.windows.length}`);

  const byId = Object.fromEntries(parsed.windows.map(item => [item.id, item]));
  assert.equal(byId['gemini-weekly'].usedPercent, 9, '剩 91.38% → 已用 9%');
  assert.equal(byId['gemini-5h'].usedPercent, 1, '剩 98.91% → 已用 1%');
  assert.equal(byId['gemini-argon-weekly'].usedPercent, 94, '剩 5.94% → 已用 94%');
  assert.equal(byId['3p-weekly'].usedPercent, 0, '100% 剩余 → 已用 0%');
  assert.equal(byId['3p-5h'].usedPercent, 0);

  assert.ok(byId['gemini-weekly'].resetsAt > 1_000, '每周窗口应有重置时间');
  assert.equal(byId['3p-weekly'].resetsAt, undefined, '「Quota available」没有倒计时，不能编一个出来');

  assert.deepEqual(parsed.windows.map(item => item.id), [
    'gemini-5h', 'gemini-weekly', 'gemini-argon-weekly', '3p-5h', '3p-weekly',
  ]);
});

test('parseUsageOutput：脏输入一律给 parseFailed，不抛异常', () => {
  assert.equal(parseUsageOutput('', { checkedAt: 1 }).detail, 'usage_parse_failed');
  assert.equal(parseUsageOutput('随便一段没有面板的文本', { checkedAt: 1 }).detail, 'usage_parse_failed');
  assert.equal(
    parseUsageOutput('└ Models & Quota\nAccount: a@b.c\nHello\n', { checkedAt: 1 }).detail,
    'usage_parse_failed',
  );
});

test('启动瞬间的「not signed in / Signing in...」不再被当成未登录直接放弃', async () => {
  const result = await probeGeminiCli({
    command: 'agy.exe',
    timeoutMs: 3_000,
    settleMs: 60,
    sendDelayMs: 1,
    fallbackSendMs: 20,
    openSession: async options => {
      const prefix = 'Welcome to the Antigravity CLI. You are currently not signed in.\n ⣷ Signing in...\n';
      const chunks = [prefix, CAPTURE];
      let index = 0;
      const timer = setInterval(() => {
        if (index >= chunks.length) { clearInterval(timer); return; }
        options.onData(chunks[index]);
        index += 1;
      }, 5);
      timer.unref?.();
      return { write() {}, close() { clearInterval(timer); } };
    },
  });
  assert.notEqual(result.detail, 'cli_not_logged_in', '过渡帧不能判成「没登录」');
  assert.ok(Array.isArray(result.windows) && result.windows.length > 0, '最终应拿到窗口数据');
});

test('真的没登录时，超时仍归类成 cli_not_logged_in（不能静默成功）', async () => {
  const result = await probeGeminiCli({
    command: 'agy.exe',
    timeoutMs: 120,
    settleMs: 30,
    openSession: async options => {
      const text = 'Welcome to the Antigravity CLI. You are currently not signed in.\n please sign in\n';
      setTimeout(() => options.onData(text), 5)?.unref?.();
      return { write() {}, close() {} };
    },
  });
  assert.equal(result.detail, 'cli_not_logged_in', '既没登录也没面板 → 明确说没登录，而不是笼统超时');
});

/**
 * 预算必须覆盖实测最慢的一档，否则会把「正在等上游」的 CLI 杀掉，用户看到的是
 * 「VPN 在跑、额度却永远未知」。本机走代理实测 8.4s / 15.5s / 41.7s（直连 95s 才报
 * `dial tcp … i/o timeout`）。TUI 那条路是本地绘屏，保持 12s 即可。
 */
test('`--print` 的探针预算覆盖实测最慢一轮，TUI 仍是短预算', () => {
  assert.ok(PRINT_TIMEOUT_MS >= 42_000, `PRINT_TIMEOUT_MS=${PRINT_TIMEOUT_MS} 低于实测最慢值 41.7s`);
  assert.equal(PROBE_TIMEOUT_MS, 12_000);
});

