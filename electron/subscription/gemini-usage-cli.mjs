/**
 * 负责：Gemini（antigravity CLI）订阅额度的 `/usage` 探针——把 CLI 交互式面板的原始输出
 *      清洗、解析成 `UsageSnapshot` 的窗口列表，并在伪终端里真的跑一次 `agy` + `/usage`。
 * 不负责：调度节流/失败退避（gemini-usage-schedule.mjs）、429 限流回写（gemini-usage-limit.mjs）、
 *      落盘与事件广播（ipc.mjs）、界面文案（渲染层）。
 * 被谁调用：electron/subscription/ipc.mjs 的 `refreshUsage`（`record.type === 'cli'` 的 Gemini 账号）；
 *      tests/gemini-usage-parse.test.mjs、tests/gemini-usage-probe.test.mjs。
 *
 * 三个刻意的设计约束（改之前先读方案 §3 §4 §5.1）：
 * 1. **纯函数与 IO 分离**：`stripAnsi` / `parseUsageOutput` 不 import 任何 Node 能力，
 *    `node --test` 可以直接喂真实样本；进程与时钟全部注入（`openSession` / `now`）。
 * 2. **探针永不抛错**：读不到就返回 `{ windows: [], reason: 'probeFailed', detail }`，
 *    让界面显示「读不到 + 原因」，而不是把设置页拖崩。
 * 3. **安全红线**：向终端写的字节只有 `/usage` 与一个回车。命中向导/条款/工作区信任提示时
 *    立即放弃本轮，绝不发 `y` / `yes` / 回车去「替用户同意」。
 */

/** 错误码（与 contract.mjs 的 ERROR_TEXT 一一对应，parse 测试会断言不存在漏配）。 */
export const USAGE_CODES = Object.freeze({
  cliMissing: 'usage_cli_missing',
  timeout: 'usage_probe_timeout',
  parseFailed: 'usage_parse_failed',
  spawnFailed: 'usage_probe_spawn_failed',
  unavailable: 'usage_probe_unavailable',
  onboarding: 'cli_onboarding_required',
  trust: 'cli_trust_required',
  notLoggedIn: 'cli_not_logged_in',
});

/**
 * TUI 路径的 12s 上限：`agy` 冷启动 + 面板渲染实测 3~5s；再留一倍余量给慢机器与首帧编译
 * （C# 桥接的 `Add-Type` 编译约 0.8~1.5s）。
 */
export const PROBE_TIMEOUT_MS = 12_000;
/**
 * `agy --print "/usage"` 的上限。
 *
 * 为什么不是 12s：这条路要真的去 Google 取一次配额，走代理时实测差异极大——
 * 同一台机器、同一个节点池，连续三次分别是 8.4s / 15.5s / 41.7s（直连则 95s 后
 * `dial tcp … i/o timeout`）。12s 的预算会在 CLI 正在等上游响应时把它杀掉，
 * 用户看到的就是「明明设了账号、VPN 也在跑，额度一直是未知」。
 * 45s 覆盖到实测最慢那一档；更慢的一轮由调度器的退避兜住，不会堆进程。
 */
export const PRINT_TIMEOUT_MS = 45_000;
/** 面板出现后再等这么久没有新输出就认为画完了（实测 120×70 下一屏画完，之后只剩光标闪烁）。 */
const SETTLE_MS = 900;
/** 发 `/usage` 与回车之间隔 300ms：TUI 需要一帧时间把输入框切到命令补全态。 */
const SEND_DELAY_MS = 300;
/** 认不出「就绪提示」时的兜底发送时间：宁可早发一次，也不要因为认不出提示而空等到超时。 */
const FALLBACK_SEND_MS = 2_500;
/** 输出上限：面板 38 行 ≈ 6KB，200KB 足够吸收 TUI 反复重绘，又不至于把内存撑爆。 */
const MAX_BUFFER_CHARS = 200_000;
/** 面板起始标记：没有它就说明这次输出根本不是 `/usage` 面板。 */
const USAGE_MARKER = /models\s*&\s*quota/i;
/** 面板底部：`esc   Close`。命中就不用等 settle。 */
const USAGE_FOOTER = /\besc\b[^\n]{0,80}?\bclose\b/i;
/** 关会话的宽限期：桥接脚本收到 stdin EOF 会先 TerminateProcess 子进程再退出。 */
const CLOSE_GRACE_MS = 2_000;

/** 终端尺寸：实测 45 行会把面板折成「(1–17 of 38 lines)」，70 行才能一屏看完三组配额。 */
const COLS = 120;
const ROWS = 70;

/**
 * 安全护栏：命中即**放弃**本轮探测（不写任何字节）。
 * 顺序即优先级——「同意条款」比「没登录」更危险，必须先判。
 */
const GUARDS = Object.freeze([
  {
    code: USAGE_CODES.onboarding,
    re: /choose your colo(?:u)?r scheme|terms of (?:service|use)|terms and conditions|privacy policy|accept the (?:terms|agreement)|agree to the/i,
    // 条款/隐私一旦出现就必须立刻停手：继续写字节等于替用户点了「同意」。
    fatal: true,
  },
  {
    code: USAGE_CODES.trust,
    re: /do you trust|trust the (?:files|authors|folder|workspace)|trust this (?:folder|workspace|directory)/i,
    fatal: true,
  },
  {
    code: USAGE_CODES.notLoggedIn,
    re: /signing in\s*\.{3}|\/login\b|sign in with google|please (?:log ?in|sign in)|not signed in/i,
    /**
     * **不致命**：`agy` 启动瞬间会先画一帧
     * `Welcome to the Antigravity CLI. You are currently not signed in.` + `⣷ Signing in...`，
     * 随后立刻用已保存的凭据自动登录，并显示邮箱与输入框（本机实测 1.5.8 就是这样）。
     * 早先一命中就放弃，导致「明明登录着却报 cli_not_logged_in、额度永远读不出来」。
     * 现在只记下这个观察，等真正超时还没拿到面板时才归类为「没登录」，
     * 所以既不会误判，也不会静默把「真的没登录」当成成功。
     */
    fatal: false,
  },
]);

/**
 * 「确实已登录」的证据：邮箱行或输入框提示。出现它就说明刚才那帧只是过渡画面。
 * 只要命中，之前的 `notLoggedIn` 观察必须被撤销。
 */
const LOGGED_IN_MARKER = /[\w.+-]+@[\w-]+\.[\w.-]+|\?\s*for shortcuts|type a message|ask anything/i;

/** TUI 就绪提示：任一条命中就认为可以输入斜杠命令了（实测提示文案随版本变，所以给多条）。 */
const READY_PATTERNS = Object.freeze([
  /\?\s*for shortcuts/i,
  /type a message/i,
  /ask anything/i,
  /(?:^|\n)\s*[│|]?\s*>\s*[│|]?\s*$/m,
]);

/** 不完整的转义序列尾巴：跨 chunk 切开时先扣住，下一块拼上再清洗。 */
const INCOMPLETE_ESCAPE = /(?:\x1b\][^\x07\x1b]*|\x1b\[[0-9;?<>!]*[ -/]*)$/;

/**
 * 方案 §4.1 的清洗链。
 * 注意 CSI 替换成**一个空格**而不是空串：面板是左右两列排版，直接删会把
 * `Remaining` 与 `[ ███ ]` 粘成一坨，后续行正则就认不出来了。
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripAnsi(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw
    // OSC（窗口标题等）：`ESC ] ... BEL` 或 `ESC ] ... ESC \`
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    // CSI（颜色、光标、清屏）：`ESC [ 参数 中间字节 终止字节`
    .replace(/\x1b\[[0-9;?<>!]*[ -/]*[@-~]/g, ' ')
    // 其余两字节转义（ESC 7 / ESC = 等）
    .replace(/\x1b[@-_]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 控制符：保留 \t(0x09) 与 \n(0x0a)，其余不可见字符一律丢掉
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // 多空格折叠成一个：解析只看行内文案，列对齐对解析没有意义
    .replace(/[ \t]{2,}/g, ' ');
}

/** 行首/行尾的制表线（`│` `└` `─` 等）与竖线：面板有框，区块标题必须能在去框后仍以文字开头。 */
function trimFrame(line) {
  return String(line).replace(/^[\s\u2500-\u257f|]+/, '').replace(/[\s\u2500-\u257f|]+$/, '');
}

/** 单次流式清洗：把跨 chunk 的不完整转义序列扣住，下一块再拼。 */
function createStreamStripper() {
  let carry = '';
  return (chunk) => {
    const raw = carry + String(chunk ?? '');
    const match = INCOMPLETE_ESCAPE.exec(raw);
    carry = match ? match[0] : '';
    const body = match ? raw.slice(0, raw.length - carry.length) : raw;
    return stripAnsi(body);
  };
}

/** §4.3 的窗口映射表：区块 + 行标签 → id/label/周期。 */
const WINDOW_TABLE = Object.freeze({
  gemini: {
    weekly: { id: 'gemini-weekly', label: 'Gemini · 每周窗口', windowDurationMins: 10080 },
    '5h': { id: 'gemini-5h', label: 'Gemini · 5 小时窗口', windowDurationMins: 300 },
  },
  '3p': {
    weekly: { id: '3p-weekly', label: '第三方模型（Claude/GPT）· 每周', windowDurationMins: 10080 },
    '5h': { id: '3p-5h', label: '第三方模型（Claude/GPT）· 5 小时', windowDurationMins: 300 },
  },
  'gemini-argon': {
    weekly: { id: 'gemini-argon-weekly', label: 'Gemini 4 Argon · 每周窗口', windowDurationMins: 10080 },
  },
});

/** 展示顺序（前端还会再排一次，这里保证落盘顺序也稳定）。 */
const WINDOW_ORDER = Object.freeze({
  'gemini-5h': 0,
  'gemini-weekly': 1,
  'gemini-argon-weekly': 2,
  '3p-5h': 3,
  '3p-weekly': 4,
});

const SECTION_PATTERNS = Object.freeze([
  { section: 'gemini', re: /^gemini models\b/i },
  { section: '3p', re: /^claude and gpt models\b/i },
  { section: 'gemini-argon', re: /^gemini 4 argon\b/i },
]);

const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;
/** `Refreshes in 33h 18m` / `Resets in 2 days 4h`；`Quota available` 没有倒计时。 */
const RESET_LEAD_RE = /(?:refreshes?|resets?)\s+in\b/i;
const DURATION_RE = /(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i;
const EMAIL_RE = /account:\s*([^\s@]+@[^\s@]+)/i;

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 正则最后一次匹配的位置（没命中返回 -1）。用于「页脚出现多次，取最后一条」。 */
function lastMatchIndex(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const scan = new RegExp(re.source, flags);
  let last = -1;
  for (const match of String(text ?? '').matchAll(scan)) last = match.index ?? -1;
  return last;
}

/**
 * `33h 18m` → 毫秒。全部单位都可缺省；一个都认不出时返回 undefined（不是 0，两者语义不同）。
 *
 * 导出是给 gemini-usage-limit.mjs 复用（`retryDelay: "47s"` 也是同一套单位），
 * 免得两处各写一份时长解析。
 *
 * @param {string} text
 * @returns {number|undefined}
 */
export function durationToMs(text) {
  const line = String(text ?? '');
  // 从第一个数字开始匹配：`Refreshes in 34h 1m` 里前面还有字，而正则的每个单位都可缺省，
  // 直接 exec 会在位置 0 匹配出一个空串（于是「有重置时间」被误判成「没写」）。
  const start = line.search(/\d/);
  if (start < 0) return undefined;
  const match = DURATION_RE.exec(line.slice(start));
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3] ?? 0);
  const secs = Number(match[4] ?? 0);
  if (![days, hours, mins, secs].every(Number.isFinite)) return undefined;
  const total = (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
  return total > 0 ? total : undefined;
}

/** 从「Refreshes in …」句子里取相对毫秒；没有这句返回 undefined。 */
function resetDelta(text) {
  const line = String(text ?? '');
  const lead = RESET_LEAD_RE.exec(line);
  if (!lead) return undefined;
  return durationToMs(line.slice(lead.index));
}

/**
 * 把 TUI 的字节流还原成**按行**的纯文本。
 *
 * 为什么非它不可：`agy` 的 `/usage` 面板是用**绝对光标定位**画出来的表格
 * （`\x1b[19;5H` 去画进度条、`\x1b[22;1H` 跳到第 22 行第 1 列画下一条）。
 * 如果只做 `stripAnsi`，整张面板会被压成一行：
 *   `Weekly Limit Remaining … 91.38% … Five Hour Limit Remaining … 98.91% …`
 * 于是区块判定（`^GEMINI MODELS`）和「一行一个窗口」全部失效，
 * 表现就是「面板明明在屏幕上，却报 usage_parse_failed」——实测 agy 1.5.8 正是这个形态。
 *
 * 规则（都是从真实字节里归纳的，不是猜）：
 * - 定位到**第 1 列**（`\x1b[22;1H` / `\x1b[22H`）→ 换行；
 * - 定位到其它列（`\x1b[19;5H`）→ 同一行内的一个空格（进度条、百分比、倒计时拼在一起）；
 * - `\r` → 换行（TUI 用「回到行首重绘」表达换行）。
 *
 * @param {string} raw
 * @returns {string} 已按行还原、已去 ANSI 的文本
 */
export function frameToText(raw) {
  const source = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!source) return '';
  const withRows = source
    // 先处理带列号 / 只带行号的绝对定位，再处理相对移动，顺序不能反。
    .replace(/\x1b\[\d+;1[Hf]/gi, '\n')
    .replace(/\x1b\[\d+;\d+[Hf]/gi, ' ')
    .replace(/\x1b\[\d+[Hf]/gi, '\n')
    // 相对下移 n 行 = n 个换行；相对右移 = 空格。
    .replace(/\x1b\[(\d*)B/g, (_all, count) => '\n'.repeat(Math.max(1, Number(count) || 1)))
    .replace(/\x1b\[(\d*)C/g, (_all, count) => ' '.repeat(Math.max(1, Number(count) || 1)))
    // 清行/清屏不产生内容。
    .replace(/\x1b\[\d*[JK]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return stripAnsi(withRows);
}

/** 行内百分比 → 剩余百分比（CLI 报的是「剩余」）。 */
function remainingPercentOf(line) {
  const match = PERCENT_RE.exec(line);
  if (!match) return null;
  return clampPercent(Number(match[1]));
}

/**
 * 「剩余百分比」→「已用百分比」。
 *
 * 必须用**未取整**的剩余值再取整：先取整剩余（42.5 → 43）再减会得到 57，
 * 而正确答案是 58（100 − 42.5 = 57.5 → 58）。两条路径（TSV 与 TUI）共用这一个函数。
 */
function usedFromRemaining(text) {
  const match = PERCENT_RE.exec(String(text ?? ''));
  if (!match) return null;
  const remaining = Number(match[1]);
  if (!Number.isFinite(remaining)) return null;
  return clampPercent(100 - remaining);
}

/** 行标签 → 窗口类型（weekly / 5h）；认不出返回 null。 */
function windowKindOf(line) {
  if (/\bweekly\b/i.test(line)) return 'weekly';
  if (/five\s*hour/i.test(line)) return '5h';
  return null;
}

function sectionOf(line) {
  for (const entry of SECTION_PATTERNS) if (entry.re.test(line)) return entry.section;
  return null;
}

/**
 * 面板原始输出 → `{ checkedAt, email, windows, reason?, detail? }`。
 *
 * 纯函数：不读时钟（`checkedAt` 由调用方给）、不抛异常、不认识就返回带 `detail` 的空快照。
 * 窗口按 id 去重且**后出现的覆盖先出现的**：TUI 重绘时先画的可能是半截行。
 *
 * @param {string} raw ConPTY 抓到的原始文本（可含 ANSI 转义）
 * @param {{ checkedAt?: number }} [options]
 * @returns {{ checkedAt: number, email: string|null, windows: Array<object>, reason?: string, detail?: string }}
 */
export function parseUsageOutput(raw, options = {}) {
  const checkedAt = Number.isFinite(options.checkedAt) ? options.checkedAt : Date.now();
  const text = frameToText(typeof raw === 'string' ? raw : String(raw ?? ''));
  const failed = detail => ({ checkedAt, email: null, windows: [], reason: 'probeFailed', detail });

  if (text.trim().length === 0) return failed(USAGE_CODES.parseFailed);
  const marker = USAGE_MARKER.exec(text);
  if (!marker) return failed(USAGE_CODES.parseFailed);

  // 只解析面板本体：标记之前是启动横幅（可能混着别的版本信息），页脚之后是残留提示符。
  // ⚠️ 页脚必须取**最后一次**出现：TUI 会先画一帧 `⣷ Loading quota summary…` + 页脚，
  // 再逐行补上真正的窗口数据。按第一次页脚切会把面板切成只剩「加载中」，
  // 于是明明抓到了完整数据却解析出 0 个窗口（实测 agy 1.5.8 就栽在这里）。
  const body = text.slice(marker.index);
  const footerAt = lastMatchIndex(body, USAGE_FOOTER);
  const panel = footerAt > 0 ? body.slice(0, footerAt) : body;

  const emailMatch = EMAIL_RE.exec(panel);
  const email = emailMatch ? emailMatch[1].replace(/[.,;:)\]]+$/, '') : null;

  const lines = panel.split('\n').map(trimFrame);
  const windows = new Map();
  let section = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const kind = windowKindOf(line);
    const remaining = remainingPercentOf(line);
    /**
     * 顺序很重要：窗口行必须**先**判，再看区块标题。
     * `GEMINI 4 ARGON` 区块里的窗口行文案是 `Gemini 4 Argon Weekly Limit … 6.09%`，
     * 它的行首和区块标题长得一模一样——先判区块会把这条窗口当成标题吃掉（少一条 Argon 配额）。
     */
    if (section && kind && remaining !== null) {
      const named = WINDOW_TABLE[section]?.[kind];
      if (!named) continue;

      // 用未取整的剩余值算已用，避免「42.5% → 先取整 43 → 57%」这种双重取整误差。
      const usedPercent = usedFromRemaining(line);
      if (usedPercent === null) continue;
      // 倒计时可能折到下一行（窄终端），但下一行如果自己就是一条窗口行就不能借用。
      let delta = resetDelta(line.slice(PERCENT_RE.exec(line).index));
      if (delta === undefined) {
        const next = lines[index + 1] ?? '';
        if (next && !windowKindOf(next) && remainingPercentOf(next) === null) delta = resetDelta(next);
      }
      windows.set(named.id, {
        id: named.id,
        label: named.label,
        usedPercent,
        ...(delta === undefined ? {} : { resetsAt: checkedAt + delta }),
        windowDurationMins: named.windowDurationMins,
      });
      continue;
    }
    const nextSection = sectionOf(line);
    if (nextSection) {
      section = nextSection;
      continue;
    }
  }

  if (windows.size === 0) return failed(USAGE_CODES.parseFailed);
  const ordered = [...windows.values()].sort(
    (left, right) => (WINDOW_ORDER[left.id] ?? 9) - (WINDOW_ORDER[right.id] ?? 9),
  );
  return { checkedAt, email, windows: ordered };
}

/** 就绪与否：任意一条提示命中即可。 */
function looksReady(text) {
  for (const pattern of READY_PATTERNS) if (pattern.test(text)) return true;
  return false;
}

/** 安全护栏：命中就返回错误码（调用方据此**放弃**本轮，不写任何字节）。 */
function guardCodeOf(text) {
  for (const guard of GUARDS) if (guard.re.test(text)) return guard.code;
  return null;
}

/** 命中并返回 guard 本身（需要区分「致命 / 仅记录」时用）。 */
function guardOf(text) {
  for (const guard of GUARDS) if (guard.re.test(text)) return guard;
  return null;
}

/**
 * 在伪终端里跑一次 `agy` 的 `/usage`，抓到面板就返回快照。
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   cols?: number,
 *   rows?: number,
 *   timeoutMs?: number,
 *   settleMs?: number,
 *   sendDelayMs?: number,
 *   fallbackSendMs?: number,
 *   openSession?: (options: {
 *     command: string, args: string[], env?: Record<string, string>, cwd?: string,
 *     cols: number, rows: number, onData: (chunk: string) => void, onExit: (info?: object) => void,
 *   }) => Promise<{ write: (text: string) => void, close: () => Promise<void> | void }>,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<{ checkedAt: number, windows: Array<object>, reason?: string, detail?: string,
 *   email: string|null, status: string, ms: number }>}
 */
export async function probeGeminiCli(options = {}) {
  const {
    command,
    args = [],
    env,
    cwd,
    cols = COLS,
    rows = ROWS,
    timeoutMs = PROBE_TIMEOUT_MS,
    settleMs = SETTLE_MS,
    sendDelayMs = SEND_DELAY_MS,
    fallbackSendMs = FALLBACK_SEND_MS,
    openSession = createConPtySession,
    now = Date.now,
  } = options;
  const startedAt = now();

  const failure = (detail, status) => ({
    checkedAt: now(),
    email: null,
    windows: [],
    reason: 'probeFailed',
    detail,
    status,
    ms: Math.max(0, now() - startedAt),
  });

  if (typeof command !== 'string' || command.trim().length === 0) return failure(USAGE_CODES.cliMissing, 'cli_missing');
  if (typeof openSession !== 'function') return failure(USAGE_CODES.unavailable, 'unavailable');

  /** 原始输出（最终交给解析器）与流式清洗后的文本（只用于识别提示）。 */
  let raw = '';
  let clean = '';
  const strip = createStreamStripper();
  let session = null;
  /** 安全护栏一旦命中就置位：此后**任何**写入都被拒绝（见 write()）。 */
  let blocked = null;
  /** 「未登录」只作为观察记录，不中断；超时仍无面板才归类成 notLoggedIn。 */
  let sawNotLoggedIn = false;
  let sentUsage = false;
  let sawUsage = false;
  let done = false;

  let settleResolve = null;
  const settled = new Promise((resolve) => { settleResolve = resolve; });
  let settleTimer = null;
  let fallbackTimer = null;
  let hardTimer = null;

  function clearTimers() {
    if (settleTimer) clearTimeout(settleTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (hardTimer) clearTimeout(hardTimer);
    settleTimer = null;
    fallbackTimer = null;
    hardTimer = null;
  }

  function finish(result) {
    if (done) return;
    done = true;
    clearTimers();
    settleResolve(result);
  }

  function fromBuffer(status) {
    const parsed = parseUsageOutput(raw, { checkedAt: now() });
    const ms = Math.max(0, now() - startedAt);
    const ok = Array.isArray(parsed.windows) && parsed.windows.length > 0;
    // 进程自己退出且没解析出面板：把「见过未登录」翻译成明确原因（比 exited 有用）。
    if (!ok && sawNotLoggedIn) {
      return { ...failure(USAGE_CODES.notLoggedIn, 'blocked'), email: parsed.email ?? null, ms };
    }
    return { ...parsed, status: ok ? 'ok' : status, ms };
  }

  /**
   * 唯一允许的写入点（安全红线）。
   * `blocked` 命中向导/条款/信任提示后这里直接返回 false——即使上层误调，也不会把
   * `y` / 回车送到确认对话框上。整个探针只会写 `/usage` 和 `\r` 两种字节。
   */
  function write(text) {
    if (blocked || done || !session || typeof session.write !== 'function') return false;
    try {
      session.write(text);
      return true;
    } catch {
      return false;
    }
  }

  async function sendUsage() {
    if (blocked || done || sentUsage) return;
    sentUsage = true;
    write('/usage');
    if (sendDelayMs > 0) await new Promise(resolve => { setTimeout(resolve, sendDelayMs); });
    write('\r');
  }

  function onData(chunk) {
    if (done) return;
    const text = strip(chunk);
    raw = (raw + String(chunk ?? '')).slice(-MAX_BUFFER_CHARS);
    clean = (clean + text).slice(-MAX_BUFFER_CHARS);

    // 1) 护栏优先：命中就放弃本轮，一个字节都不再写（§5.1「绝不替用户确认」）。
    //    面板已经在手后不再判护栏：那时本来也不需要再写任何字节，而不该因为面板/帮助行里
    //    恰好出现 `/login` 之类字样，把一份已经抓到的真实数据丢掉。
    if (!sawUsage) {
      const guard = guardOf(clean);
      if (guard) {
        if (guard.fatal) {
          blocked = guard.code;
          finish(failure(guard.code, 'blocked'));
          return;
        }
        // 非致命（目前只有「未登录」）：只记录，不中断。
        // CLI 启动瞬间会先画一帧「not signed in / Signing in...」，随后用已保存凭据自动登录；
        // 在那里直接放弃会让「明明登录着」也永远读不到额度（真实踩过）。
        sawNotLoggedIn = true;
      }
    }
    // 已登录证据出现 → 撤销上一步的记录（那只是过渡帧）。
    if (sawNotLoggedIn && LOGGED_IN_MARKER.test(clean)) sawNotLoggedIn = false;
    // 2) 就绪 → 发 `/usage`（只发一次；fallback 定时器会先把它标记成已发）。
    if (!sentUsage && looksReady(clean)) {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      void sendUsage();
    }
    // 3) 面板出现 → 等它画完（底部 `esc Close` 命中则立即收尾）
    if (!sawUsage && USAGE_MARKER.test(clean)) {
      sawUsage = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    }
    if (!sawUsage) return;
    /**
     * 看到页脚（`esc Close`）说明面板开始收尾，但**不能立刻收工**：
     * TUI 是逐行往终端上画的，页脚先出现、上面的窗口行可能还差一两行。
     * 早先这里直接 `finish`，实测会在 4.5s 处拿到一份只有半张表的面板，
     * 于是解析出 0 个窗口 → 报 `usage_parse_failed`。
     * 现在统一「最后一帧 + settleMs 静默」再收，footer 只用来提前结束等待。
     */
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => finish(fromBuffer('settled')), Math.max(0, settleMs));
  }

  hardTimer = setTimeout(() => {
    // 超时还没拿到面板：如果这一轮见过「未登录」字样，按「没登录」报，比笼统的「超时」有用得多。
    finish(sawNotLoggedIn
      ? failure(USAGE_CODES.notLoggedIn, 'blocked')
      : failure(USAGE_CODES.timeout, 'timeout'));
  }, Math.max(1, timeoutMs));
  fallbackTimer = setTimeout(() => { void sendUsage(); }, Math.max(0, fallbackSendMs));

  try {
    session = await openSession({
      command: command.trim(),
      args: Array.isArray(args) ? args : [],
      env,
      cwd,
      cols,
      rows,
      onData,
      onExit: () => finish(fromBuffer('exited')),
    });
  } catch (error) {
    return failure(error?.code === 'conpty_unavailable' ? USAGE_CODES.unavailable : USAGE_CODES.spawnFailed, 'spawn_failed');
  }
  if (!session || typeof session.write !== 'function') {
    return failure(USAGE_CODES.spawnFailed, 'spawn_failed');
  }
  // 会话开好之前就可能已经有输出（假会话在 openSession 里同步回放），也可能已经结束。
  if (done) {
    await closeQuietly(session);
    return await settled;
  }

  const result = await settled;
  await closeQuietly(session);
  return result;
}

async function closeQuietly(session) {
  try {
    await session?.close?.();
  } catch {
    // 关不掉不影响已经拿到的快照：进程会被桥接脚本/Node 侧兜底杀掉。
  }
}

/** `--print` 输出的分组名 → 内部区块 id（大小写与空格都不敏感）。 */
const PRINT_GROUP = Object.freeze([
  { section: 'gemini', re: /^gemini\s+models?$/i },
  { section: '3p', re: /^claude\s*(?:and|&)\s*gpt\s*models?$/i },
  { section: 'gemini-argon', re: /^gemini\s*4\s*argon$/i },
]);

function printSectionOf(text) {
  const value = String(text ?? '').trim();
  for (const entry of PRINT_GROUP) if (entry.re.test(value)) return entry.section;
  return null;
}

/**
 * 解析 `agy --print "/usage"` 的**制表符分隔**输出。
 *
 * 为什么优先这条路（`probeGeminiUsageViaPrint`）：
 * - 输出是干净的 TSV，不需要伪终端、不需要 C# 桥、不依赖光标定位；
 * - 重置时间直接给 **ISO 绝对时间**（`2026-11-21T09:17:22Z`），不用从「还有 31h 54m」倒推；
 * - **在未受信任的目录里也能用**：实测 `agy --print` 不会弹「信任这个文件夹」。
 *   走 TUI 那条路时，探针目录是一个空文件夹，agy 每次都要问一次信任，护栏（正确地）拒绝后
 *   额度就永远读不到——这是「设置了账号却一直显示额度未知」的真正原因。
 *
 * 行格式：`<分组>\t<窗口名>\t<剩余百分比>\t<ISO 重置时间>`。
 * 百分比同样是**剩余**，落盘要转成已用。
 *
 * @param {string} raw
 * @param {{ checkedAt?: number }} [options]
 * @returns {{ checkedAt: number, email: string|null, windows: Array<object>, reason?: string, detail?: string, status?: string }}
 */
export function parsePrintUsage(raw, options = {}) {
  const checkedAt = Number.isFinite(options.checkedAt) ? options.checkedAt : Date.now();
  const failed = detail => ({ checkedAt, email: null, windows: [], reason: 'probeFailed', detail });
  const text = stripAnsi(typeof raw === 'string' ? raw : String(raw ?? ''));
  if (!text.trim()) return failed(USAGE_CODES.parseFailed);

  const windows = new Map();
  const emailMatch = EMAIL_RE.exec(text);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split('\t').map(cell => cell.trim());
    if (cells.length < 3) continue;
    const section = printSectionOf(cells[0]);
    if (!section) continue;
    const label = cells[1];
    const kind = windowKindOf(label);
    if (!kind) continue;
    const named = WINDOW_TABLE[section]?.[kind];
    if (!named) continue;
    const remaining = remainingPercentOf(cells[2]);
    if (remaining === null) continue;
    const usedPercent = usedFromRemaining(cells[2]);
    if (usedPercent === null) continue;
    const iso = cells[3] ?? '';
    const resetsAt = /^\d{4}-\d{2}-\d{2}T/.test(iso) ? Date.parse(iso) : Number.NaN;
    windows.set(named.id, {
      id: named.id,
      label: named.label,
      usedPercent,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      windowDurationMins: named.windowDurationMins,
    });
  }

  if (!windows.size) return failed(USAGE_CODES.parseFailed);
  const ordered = [...windows.values()].sort(
    (left, right) => (WINDOW_ORDER[left.id] ?? 9) - (WINDOW_ORDER[right.id] ?? 9),
  );
  return {
    checkedAt,
    email: emailMatch ? emailMatch[1].replace(/[.,;:)\]]+$/, '') : null,
    windows: ordered,
    status: 'ok',
  };
}

/**
 * 用 `agy --print "/usage"` 取额度（首选路径，零伪终端）。
 *
 * 安全：这是一条**只读**斜杠命令，不需要终端、不需要信任目录、不会替用户确认任何东西。
 *
 * @param {{ command: string, cwd?: string, timeoutMs?: number, env?: object, now?: Function }} options
 */
export async function probeGeminiUsageViaPrint(options = {}) {
  const { command, cwd, timeoutMs = PRINT_TIMEOUT_MS, env, now = Date.now, spawnImpl } = options;
  const startedAt = Math.max(0, Math.floor(Number(now()) || 0));
  const failure = (detail, status) => ({
    checkedAt: startedAt, email: null, windows: [], reason: 'probeFailed', detail,
    status, ms: Math.max(0, Math.floor(Number(now()) || 0) - startedAt),
  });
  if (typeof command !== 'string' || !command.trim()) return failure(USAGE_CODES.cliMissing, 'cli_missing');

  const spawn = spawnImpl || (await import('node:child_process')).spawn;
  return await new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command.trim(), ['--print', '/usage'], {
        cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
        env: { ...process.env, ...(env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done(failure(error?.code === 'ENOENT' ? USAGE_CODES.cliMissing : USAGE_CODES.spawnFailed, 'spawn_failed'));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      done(failure(USAGE_CODES.timeout, 'timeout'));
    }, Math.max(1_000, Math.floor(Number(timeoutMs) || PRINT_TIMEOUT_MS)));
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      done(failure(USAGE_CODES.spawnFailed, 'spawn_failed'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const parsed = parsePrintUsage(stdout, { checkedAt: Math.max(0, Math.floor(Number(now()) || 0)) });
      const ms = Math.max(0, Math.floor(Number(now()) || 0) - startedAt);
      if (parsed.windows.length) {
        done({ ...parsed, status: 'ok', ms });
        return;
      }
      // 把「未登录」「需要信任」这类可读原因透出去，而不是笼统的解析失败。
      const guard = guardOf(`${stdout}\n${stderr}`);
      if (guard) {
        done({ ...failure(guard.code, 'blocked'), ms });
        return;
      }
      done({ ...failure(code === 0 ? USAGE_CODES.parseFailed : USAGE_CODES.spawnFailed, 'failed'), ms });
    });
  });
}

/** 各平台的伪终端桥。Windows 用 ConPTY；其它平台暂时没有实现（明确报不可用，不假装成功）。 */
function powershellPath(env) {
  const root = String(env?.SystemRoot ?? env?.windir ?? 'C:\\Windows');
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * 建一个 ConPTY 会话（Windows）。
 *
 * 为什么不用 `node-pty`：零新增依赖是硬约束。
 * 为什么不用 `koffi` 直接调 Win32：库里没有现成的 ConPTY 绑定，手写要自己摆平
 * `LPPROC_THREAD_ATTRIBUTE_LIST` 的裸内存布局、同步管道上的阻塞读线程与句柄生命周期，
 * 一旦结构体对齐错了只会表现为「收不到任何输出」，排查成本远高于收益；
 * 方案 §3.1 明确允许 `powershell.exe -NoProfile` + 内联 C# 桥这条兜底路径（代价是首帧多
 * ~0.8s 的 `Add-Type` 编译）。所以这里走 C# 桥：零 ABI 风险、无第三方 exe、无 npm 依赖。
 *
 * @param {{
 *   command: string, args?: string[], env?: Record<string, string>, cwd?: string,
 *   cols?: number, rows?: number,
 *   onData: (chunk: string) => void, onExit: (info?: object) => void,
 * }} options
 */
export async function createConPtySession(options) {
  const { command, args = [], env, cwd, cols = COLS, rows = ROWS, onData, onExit } = options;
  if (process.platform !== 'win32') {
    const error = new Error('conpty only supported on win32');
    error.code = 'conpty_unavailable';
    throw error;
  }
  const { spawn } = await import('node:child_process');
  const script = buildBridgeScript();
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    powershellPath(env ?? process.env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
      env: {
        ...process.env,
        ...(env ?? {}),
        MOVA_PTY_FILE: command,
        // 参数用 \u0001 拼接：桥接脚本里 split 一次就能还原，避免在 C# 里手写 JSON 解析。
        MOVA_PTY_ARGS: (Array.isArray(args) ? args : []).join('\u0001'),
        MOVA_PTY_CWD: typeof cwd === 'string' ? cwd : '',
        MOVA_PTY_COLS: String(cols),
        MOVA_PTY_ROWS: String(rows),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stderrChars = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { try { onData(String(chunk)); } catch { /* 解析失败不许打断读取 */ } });
  // stderr 只数长度不记内容：桥接脚本的报错里可能带命令行（含用户目录），不值得进日志。
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrChars += String(chunk ?? '').length; });
  child.on('error', () => onExit?.({ code: null, kind: 'spawn_error' }));
  child.on('close', code => onExit?.({ code, stderrChars }));

  return {
    write(text) {
      try {
        child.stdin.write(String(text));
      } catch {
        // 进程已经退出：交给超时/退出事件收敛。
      }
    },
    async close() {
      try {
        // 先关 stdin：桥接脚本读到 EOF 会 TerminateProcess 掉 agy 再退出，
        // 这样不会留下残留的 agy（残留会让后续 session/new 返回空模型列表）。
        child.stdin.end();
      } catch {
        // 同上
      }
      const exited = await waitForExit(child, CLOSE_GRACE_MS);
      if (!exited) {
        try { child.kill(); } catch { /* 已经退出 */ }
      }
      // 再给 500ms：让桥接脚本有机会自己干掉子进程，避免 agy 变孤儿。
      await waitForExit(child, 500);
    },
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { child.removeListener('close', onClose); } catch { /* 已经移除 */ }
      resolve(value);
    };
    const onClose = () => done(true);
    child.once('close', onClose);
    const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
}

/**
 * ConPTY 桥接脚本（PowerShell + 内联 C#）。
 *
 * 三条实测坑都在里面，改之前请对照方案 §3.1：
 * 1. `dwFlags` 必须含 `STARTF_USESTDHANDLES`，否则子进程继续往父控制台写，管道收不到内容；
 * 2. 收到 DSR（`ESC [ 6 n`）必须立刻回 `ESC [ 1 ; 1 R`，否则 TUI 卡在光标探针；
 * 3. 伪终端尺寸 `120×70`，否则面板被折叠成 `(1–17 of 38 lines)`。
 *
 * 只做字节搬运：stdin → 伪终端输入，伪终端输出 → stdout。所有判定（就绪、护栏、抓取）
 * 都在 Node 侧，方便单测；这里的 C# 必须保持 C# 5 语法（Windows PowerShell 5.1 的 csc 只到 C# 5）。
 */
function buildBridgeScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$source = @\'',
    'using System;',
    'using System.IO;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'using System.Threading;',
    '',
    'namespace MovaPty {',
    '  public static class Bridge {',
    '    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }',
    '    [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }',
    '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '    public struct STARTUPINFO {',
    '      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;',
    '      public int dwX; public int dwY; public int dwXSize; public int dwYSize;',
    '      public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;',
    '      public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;',
    '      public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;',
    '    }',
    '    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }',
    '    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
    '',
    '    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;',
    '    const uint STARTF_USESTDHANDLES = 0x00000100;',
    '    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;',
    '',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, ref SECURITY_ATTRIBUTES attrs, int size);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr hPC);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);',
    '    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]',
    '    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);',
    '    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] buffer, uint count, out uint written, IntPtr overlapped);',
    '',
    '    static IntPtr hpc = IntPtr.Zero;',
    '    static IntPtr inWrite = IntPtr.Zero;',
    '    static IntPtr outRead = IntPtr.Zero;',
    '    static IntPtr child = IntPtr.Zero;',
    '    static Stream stdoutStream;',
    '    static Stream stdinStream;',
    '    static int dsrState = 0;',
    '',
    '    static int EnvInt(string name, int fallback) {',
    '      string raw = Environment.GetEnvironmentVariable(name);',
    '      int value;',
    '      if (raw != null && int.TryParse(raw, out value) && value > 0) return value;',
    '      return fallback;',
    '    }',
    '',
    '    static void Fail(string where) {',
    '      Console.Error.WriteLine("mova-pty: " + where + " failed, err=" + Marshal.GetLastWin32Error());',
    '      Environment.Exit(2);',
    '    }',
    '',
    '    static void WriteAll(IntPtr handle, byte[] buffer, int count) {',
    '      int offset = 0;',
    '      while (offset < count) {',
    '        byte[] slice = new byte[count - offset];',
    '        Buffer.BlockCopy(buffer, offset, slice, 0, slice.Length);',
    '        uint written;',
    '        if (!WriteFile(handle, slice, (uint)slice.Length, out written, IntPtr.Zero) || written == 0) return;',
    '        offset += (int)written;',
    '      }',
    '    }',
    '',
    '    static bool FeedDsr(byte value) {',
    '      if (value == 0x1b) { dsrState = 1; return false; }',
    '      if (dsrState == 1 && value == (byte)91) { dsrState = 2; return false; }',
    '      if (dsrState == 2 && value == (byte)54) { dsrState = 3; return false; }',
    '      if (dsrState == 3 && value == (byte)110) { dsrState = 0; return true; }',
    '      dsrState = 0;',
    '      return false;',
    '    }',
    '',
    '    static void ReadLoop() {',
    '      byte[] buffer = new byte[8192];',
    '      byte[] reply = new byte[] { 0x1b, (byte)91, (byte)49, (byte)59, (byte)49, (byte)82 };',
    '      while (true) {',
    '        uint read;',
    '        if (!ReadFile(outRead, buffer, (uint)buffer.Length, out read, IntPtr.Zero) || read == 0) break;',
    '        for (int index = 0; index < (int)read; index++) {',
    '          if (FeedDsr(buffer[index])) { WriteAll(inWrite, reply, reply.Length); break; }',
    '        }',
    '        try { stdoutStream.Write(buffer, 0, (int)read); stdoutStream.Flush(); } catch { break; }',
    '      }',
    '      Shutdown();',
    '    }',
    '',
    '    static void WriteLoop() {',
    '      byte[] buffer = new byte[4096];',
    '      while (true) {',
    '        int read;',
    '        try { read = stdinStream.Read(buffer, 0, buffer.Length); } catch { read = 0; }',
    '        if (read <= 0) break;',
    '        WriteAll(inWrite, buffer, read);',
    '      }',
    '      Shutdown();',
    '    }',
    '',
    '    static void Shutdown() {',
    '      if (child != IntPtr.Zero) { TerminateProcess(child, 0); CloseHandle(child); child = IntPtr.Zero; }',
    '      if (hpc != IntPtr.Zero) { ClosePseudoConsole(hpc); hpc = IntPtr.Zero; }',
    '      Environment.Exit(0);',
    '    }',
    '',
    '    public static void Run() {',
    '      string file = Environment.GetEnvironmentVariable("MOVA_PTY_FILE");',
    '      if (file == null || file.Length == 0) Fail("MOVA_PTY_FILE");',
    '      string cwd = Environment.GetEnvironmentVariable("MOVA_PTY_CWD");',
    '      string rawArgs = Environment.GetEnvironmentVariable("MOVA_PTY_ARGS");',
    '      int cols = EnvInt("MOVA_PTY_COLS", 120);',
    '      int rows = EnvInt("MOVA_PTY_ROWS", 70);',
    '',
    '      SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();',
    '      sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));',
    '      sa.bInheritHandle = 1;',
    '      IntPtr inRead;',
    '      IntPtr outWrite;',
    '      if (!CreatePipe(out inRead, out inWrite, ref sa, 0)) Fail("CreatePipe(in)");',
    '      if (!CreatePipe(out outRead, out outWrite, ref sa, 0)) Fail("CreatePipe(out)");',
    '',
    '      COORD size = new COORD();',
    '      size.X = (short)cols;',
    '      size.Y = (short)rows;',
    '      int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hpc);',
    '      if (hr != 0) Fail("CreatePseudoConsole");',
    '      CloseHandle(inRead);',
    '      CloseHandle(outWrite);',
    '',
    '      IntPtr attrSize = IntPtr.Zero;',
    '      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);',
    '      IntPtr attrs = Marshal.AllocHGlobal(attrSize);',
    '      if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref attrSize)) Fail("InitializeProcThreadAttributeList");',
    '      if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) Fail("UpdateProcThreadAttribute");',
    '',
    '      STARTUPINFOEX si = new STARTUPINFOEX();',
    '      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));',
    '      si.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;',
    '      si.StartupInfo.hStdInput = IntPtr.Zero;',
    '      si.StartupInfo.hStdOutput = IntPtr.Zero;',
    '      si.StartupInfo.hStdError = IntPtr.Zero;',
    '      si.lpAttributeList = attrs;',
    '',
    '      StringBuilder commandLine = new StringBuilder("\\"" + file + "\\"");',
    '      if (rawArgs != null && rawArgs.Length > 0) {',
    '        string[] parts = rawArgs.Split(new char[] { (char)1 });',
    '        for (int index = 0; index < parts.Length; index++) {',
    '          if (parts[index].Length == 0) continue;',
    '          commandLine.Append(" \\"" + parts[index].Replace("\\"", "\\\\\\"") + "\\"");',
    '        }',
    '      }',
    '      PROCESS_INFORMATION pi = new PROCESS_INFORMATION();',
    '      string workDir = (cwd == null || cwd.Length == 0) ? null : cwd;',
    '      bool started = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workDir, ref si, out pi);',
    '      DeleteProcThreadAttributeList(attrs);',
    '      Marshal.FreeHGlobal(attrs);',
    '      if (!started) Fail("CreateProcess");',
    '      child = pi.hProcess;',
    '      CloseHandle(pi.hThread);',
    '',
    '      stdoutStream = Console.OpenStandardOutput();',
    '      stdinStream = Console.OpenStandardInput();',
    '      Thread reader = new Thread(new ThreadStart(ReadLoop));',
    '      reader.IsBackground = true;',
    '      reader.Start();',
    '      Thread writer = new Thread(new ThreadStart(WriteLoop));',
    '      writer.IsBackground = true;',
    '      writer.Start();',
    '      reader.Join();',
    '      Shutdown();',
    '    }',
    '  }',
    '}',
    '\'@',
    "$assemblies = @('System.dll')",
    'Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $assemblies',
    '[MovaPty.Bridge]::Run()',
  ].join('\n');
}
