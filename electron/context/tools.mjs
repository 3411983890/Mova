/**
 * 暴露给模型的三个上下文工具：context_status / context_compact / context_read。
 *
 * 负责：把台账的「查账、压缩、回查」翻译成模型直接能读的纯文本，并把压缩结果排进待生效队列（pending）。
 * 不负责：把工具装进 chat-agent（统筹者做）、生成摘要（summarize.mjs）、压缩算法与六层口径（ledger/budget）。
 * 被谁调用：electron/chat-agent.mjs 的工具列表与 handlers 接线，以及 tests/context-tools.test.mjs。
 * 为什么返回文本而不是 JSON：模型要读的是结论（用了多少、能不能压、原文在哪），
 *   一堆带引号的字段反而占 token 且容易被误当作数据去猜（§4.6）。
 * 硬规则：任何内部异常都收敛成 isError:true 的文本，绝不抛——工具抛错会中断整轮对话。
 * @see Mova上下文压缩与Agent上下文工程方案.md §4.6 §8.2
 */
import { estimateMessageTokens } from './budget.mjs';
import { selectCompressible } from './ledger.mjs';

const DEFAULT_READ_LIMIT = 4000;
/** 单次回查上限：与 ledger.read 的 MAX_READ_LIMIT、schema 里的 maximum 保持一致。 */
const MAX_READ_LIMIT = 6000;
const MIN_KEEP_RECENT = 4;
const MAX_KEEP_RECENT = 30;
/** 提示阈值：越过就在 status 文本里明说「现在就该压」，而不是让模型自己去算。 */
const HINT_PERCENT = 85;
const ABORTED_TEXT = '已中止：这次调用被取消，没有读取或压缩任何内容。';

function formatNumber(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '0';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 整数参数归一：越界夹住、非整数按「没传」处理（schema 校验之外的兜底）。 */
function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** ctx 既可能是 `{ signal }`，也可能直接是 AbortSignal（两种接线都常见）。 */
function signalOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (typeof ctx.aborted === 'boolean' && typeof ctx.addEventListener === 'function') return ctx;
  const signal = ctx.signal;
  return signal && typeof signal.aborted === 'boolean' ? signal : null;
}

function isAborted(ctx) {
  const signal = signalOf(ctx);
  return Boolean(signal && signal.aborted);
}

/**
 * 兼容两种调用形态。
 * 本模块对外的契约是 `(args, ctx)`；但 chat-agent 既有工具的签名是 `(id, input, toolSignal)`，
 * 所以首个参数是字符串时按「工具调用 id」处理，真正的入参在第二位——统筹者接线时两种写法都不会踩坑。
 */
function normalizeCall(first, second, third) {
  const isRecord = (value) => Boolean(value) && typeof value === 'object';
  if (typeof first === 'string') {
    return { args: isRecord(second) ? second : {}, ctx: third };
  }
  return { args: isRecord(first) ? first : {}, ctx: second };
}

/**
 * 可压缩区间的大小。这里刻意复用 ledger 的 `selectCompressible`，
 * 而不是自己按「最近 8 条」估——两处各写一份规则，就会在默认值改动后悄悄对不上。
 */
function compressibleStats(ledger) {
  let rows = null;
  try {
    rows = selectCompressible(ledger && ledger.messages);
  } catch {
    // 台账形状异常时按「0 条可压缩」展示，不阻断查账。
  }
  const list = Array.isArray(rows?.compressible) ? rows.compressible : [];
  let tokens = 0;
  for (const message of list) {
    try {
      const value = estimateMessageTokens({ role: message.role, content: message.text });
      if (Number.isFinite(value) && value > 0) tokens += value;
    } catch {
      // 单条估算失败不该让「查账」失败：少算一条比报错更有用。
    }
  }
  return { count: list.length, tokens: Math.round(tokens) };
}

export function createContextTools({ key, ledgerFor, pending, emit, now = Date.now, contextWindow } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  // 没拿到 key 时退到 'default'：宁可同会话共用一条待生效项，也不要压缩成功却静默取不到归档。
  const pendingKey = typeof key === 'string' && key ? key : (typeof key === 'number' && Number.isFinite(key) ? String(key) : 'default');
  // ledgerFor 必须是延迟求值函数：工具被调用的那一刻才读消息，构造时的快照已经过期了。
  const readLedger = typeof ledgerFor === 'function' ? ledgerFor : () => ledgerFor;

  const peekPending = () => {
    try {
      if (!pending || typeof pending.peek !== 'function') return null;
      return pending.peek(pendingKey) ?? null;
    } catch {
      return null;
    }
  };

  const emitReport = (event) => {
    try {
      if (typeof emit === 'function') emit(event);
    } catch {
      // 上报失败不能影响工具结果：模型只关心「压没压」。
    }
  };

  /**
   * 窗口分母：优先显式传入（数字或函数），其次读 ledger 上挂的同名字段。
   * 都拿不到就返回 null，status 会明说「比例未知」——绝不编一个默认窗口算百分比。
   */
  function resolveWindow(ledger) {
    const candidates = [];
    try {
      candidates.push(typeof contextWindow === 'function' ? contextWindow() : contextWindow);
    } catch {
      candidates.push(null);
    }
    if (ledger && typeof ledger === 'object') candidates.push(ledger.contextWindow, ledger.window);
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function statusText() {
    const ledger = readLedger();
    if (!ledger || typeof ledger.status !== 'function') return fail('上下文台账不可用，暂时查不到用量。可以继续正常对话。');
    const status = ledger.status();
    const tokens = Math.max(0, Number(status?.total?.tokens) || 0);
    const window = resolveWindow(ledger);
    const share = window ? Math.round((tokens / window) * 100) : null;
    const layers = Array.isArray(status?.layers) ? status.layers : [];
    const compressible = compressibleStats(ledger);
    const pendingPayload = peekPending();

    const lines = [
      share === null
        ? `上下文占用：约 ${formatNumber(tokens)} tokens（占窗口比例未知：未拿到窗口大小）`
        : `上下文占用：约 ${formatNumber(tokens)} tokens（占窗口 ${share}%）`,
      `分层：${layers.map((row) => `${row.name} ${formatNumber(row.tokens)}`).join(' / ')}`,
      compressible.count > 0
        ? `可压缩：${formatNumber(compressible.count)} 条旧消息（约 ${formatNumber(compressible.tokens)} tokens）`
        : '可压缩：0 条（消息太少，或已经压到只剩近期消息与用户约束）',
      pendingPayload
        ? `待生效：有（${pendingPayload.source === 'llm' ? '模型摘要' : '程序摘要'}，覆盖 ${formatNumber(pendingPayload.coveredCount)} 条，下一次请求生效）`
        : '待生效：无',
    ];
    if (share === null) {
      lines.push(`提示：超过 ${HINT_PERCENT}% 建议调用 context_compact`);
    } else if (share >= HINT_PERCENT) {
      lines.push(`提示：已用 ${share}%，超过 ${HINT_PERCENT}%，现在就该调用 context_compact`);
    } else {
      const room = Math.max(0, Math.ceil((window * HINT_PERCENT) / 100) - tokens);
      lines.push(`提示：超过 ${HINT_PERCENT}% 建议调用 context_compact（离阈值约 ${formatNumber(room)} tokens）`);
    }
    return ok(lines.join('\n'));
  }

  async function compactText(args, ctx) {
    if (isAborted(ctx)) return ok(ABORTED_TEXT);
    const ledger = readLedger();
    if (!ledger || typeof ledger.compact !== 'function') return fail('上下文台账不可用，这次没有压缩。可继续对话，稍后再试。');

    const at = Number(clock());
    const createdAt = Number.isFinite(at) ? at : Date.now();
    const keepRecent = clampInt(args?.keepRecent, MIN_KEEP_RECENT, MAX_KEEP_RECENT);
    const options = { now: createdAt };
    if (keepRecent !== undefined) options.keepRecent = keepRecent;

    const before = typeof ledger.status === 'function' ? ledger.status() : null;
    // ledger.compact 在没有 summarize 时是同步的；有注入摘要器时返回 Promise——统一 await 两种都成立。
    const result = await ledger.compact(options);
    if (!result || result.compacted !== true) {
      return fail('没有可压缩区间（消息太少或刚压缩过）。可用 context_status 查看当前用量。');
    }

    const coveredIds = Array.isArray(result.coveredMessages) ? result.coveredMessages.slice() : [];
    const archive = (Array.isArray(result.archive) ? result.archive : [])
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => ({ id: entry.id, text: typeof entry.text === 'string' ? entry.text : '' }));
    const payload = {
      summaryBlock: typeof result.summaryBlock === 'string' ? result.summaryBlock : '',
      coveredIds,
      coveredCount: coveredIds.length,
      source: result.source === 'llm' ? 'llm' : 'deterministic',
      createdAt,
      archive,
    };
    if (pending && typeof pending.set === 'function') pending.set(pendingKey, payload);

    const after = typeof ledger.status === 'function' ? ledger.status() : null;
    const tokensBefore = Math.max(0, Number(result.record?.tokens?.before ?? before?.total?.tokens) || 0);
    const tokensAfter = Math.max(0, Number(result.record?.tokens?.after ?? after?.total?.tokens) || 0);
    // 形状与 wiring 的 report 逐字对齐，前端只需要一条渲染路径（mode 用 'model'：模型主动触发）。
    emitReport({
      type: 'context',
      report: {
        mode: 'model',
        estimated: true,
        messages: {
          sent: Math.max(0, Number(after?.messages?.kept ?? payload.coveredCount) || 0),
          total: Math.max(0, Number(after?.messages?.total ?? before?.messages?.total) || 0),
        },
        tokens: { before: tokensBefore, after: tokensAfter },
        layers: (Array.isArray(before?.layers) ? before.layers : []).map((row) => ({ id: row.id, name: row.name, tokens: row.tokens })),
        compaction: { covered: payload.coveredCount, source: payload.source, before: tokensBefore, after: tokensAfter },
      },
    });

    return ok(`已压缩 ${formatNumber(payload.coveredCount)} 条旧消息（约 ${formatNumber(tokensBefore)} tokens → ${formatNumber(tokensAfter)} tokens）。`
      + '下一次请求生效；原文可用 context_read 回查。');
  }

  /** 一页结果：首行定位（含 nextOffset），其后逐字正文。 */
  function pageText({ text, offset, limit, note }) {
    const total = text.length;
    const size = Math.min(limit, MAX_READ_LIMIT);
    const end = Math.min(total, offset + size);
    const page = text.slice(offset, end);
    const nextOffset = end < total ? end : null;
    const tail = nextOffset === null ? '已到末尾' : `nextOffset=${nextOffset}`;
    const header = `[原文回查 ${offset}–${end} / 共 ${formatNumber(total)} 字符｜${tail}${note ? `｜${note}` : ''}]`;
    return ok(`${header}\n${page}`);
  }

  function rangeError(total) {
    if (!Number.isFinite(total) || total <= 0) return ok('没有可回查的原文：当前会话还没有被压缩的内容。');
    return ok(`回查范围无效：可用范围 0–${formatNumber(total)} 字符（offset 取 0–${formatNumber(Math.max(0, total - 1))}，limit 取 1–${MAX_READ_LIMIT}）。`);
  }

  /** 参数本身不合法（非整数 / 负数 / limit<1）：给出改法，别让模型猜。 */
  function rangeInvalidText() {
    return ok(`回查范围无效：offset 需为 ≥0 的整数，limit 需为 1–${MAX_READ_LIMIT} 的整数。`);
  }

  /** 入参校验：整数、非负、limit ≥1；越界夹到 6000 而不是报错（与 ledger.read 同口径）。 */
  function rangeOf(args) {
    const offset = args?.offset === undefined ? 0 : args.offset;
    const limit = args?.limit === undefined ? DEFAULT_READ_LIMIT : args?.limit;
    if (!Number.isInteger(offset) || !Number.isInteger(limit)) return null;
    if (offset < 0 || limit < 1) return null;
    return { offset, limit: Math.min(limit, MAX_READ_LIMIT) };
  }

  function readText(args, ctx) {
    if (isAborted(ctx)) return ok(ABORTED_TEXT);
    const range = rangeOf(args);
    const pendingPayload = peekPending();
    const archive = pendingPayload && Array.isArray(pendingPayload.archive) ? pendingPayload.archive : [];

    // 有 pending 时优先读归档：那才是「已被摘要取代」的那段原文，ledger.read 给的是全量窗口原文。
    if (archive.length > 0) {
      const source = archive.map((entry) => (typeof entry.text === 'string' ? entry.text : '')).join('\n');
      const total = source.length;
      if (!range) return rangeInvalidText();
      if (range.offset >= total) return rangeError(total);
      return pageText({ text: source, offset: range.offset, limit: range.limit, note: '来自待生效压缩的归档' });
    }

    if (!range) return rangeInvalidText();
    const ledger = readLedger();
    if (!ledger || typeof ledger.read !== 'function') return fail('上下文台账不可用，暂时读不到原文。可以继续正常对话。');
    const result = ledger.read(range);
    if (result && typeof result.text === 'string' && !result.error) {
      const total = Number.isFinite(Number(result.total)) ? Number(result.total) : result.text.length;
      const start = Number.isFinite(Number(result.offset)) ? Number(result.offset) : 0;
      const end = start + result.text.length;
      const nextOffset = Number.isFinite(Number(result.nextOffset)) ? Number(result.nextOffset) : null;
      const tail = nextOffset === null ? '已到末尾' : `nextOffset=${nextOffset}`;
      return ok(`[原文回查 ${start}–${end} / 共 ${formatNumber(total)} 字符｜${tail}]\n${result.text}`);
    }

    // 越界时 ledger 只回 `{error}`，不告诉你有多大；用一次 1 字符的探测拿到总数，好把范围写清楚。
    let total = null;
    try {
      const probe = ledger.read({ offset: 0, limit: 1 });
      if (probe && !probe.error && Number.isFinite(Number(probe.total))) total = Number(probe.total);
    } catch {
      total = null;
    }
    // 参数本身不合法（非整数/负数）时 total 可能是 null，rangeError 会退回「没有可回查的原文」文案。
    return rangeError(total);
  }

  /** 统一兜底：任何同步/异步异常都变成 isError 文本，不抛给 agent 主循环。 */
  function guard(name, run) {
    return async (first, second, third) => {
      const { args, ctx } = normalizeCall(first, second, third);
      try {
        return await run(args ?? {}, ctx);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error ?? '');
        return fail(`${name} 执行失败：${detail || '未知错误'}`);
      }
    };
  }

  const definitions = [
    {
      name: 'context_status',
      label: '上下文用量',
      description: 'Report how much of the context window this conversation already uses: total tokens, the six layers (rules, project, goal, summary, recent messages, archive index), how many older messages can still be compressed, and whether a compaction is already queued for the next request.\n'
        + 'Call it before a long read, a big tool batch or a long browser task, when a tool result looks huge, or whenever the user asks about context, tokens or compaction — these numbers are free to read, never guess them.\n'
        + `Above ${HINT_PERCENT}% call context_compact yourself.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'context_compact',
      label: '压缩上下文',
      description: 'Compress older turns of this conversation into one summary block so the window stops filling up. The newest turns, the current goal and the explicit user constraints are never compressed, and the original text stays readable with context_read.\n'
        + `Call it when context_status shows more than about ${HINT_PERCENT}% used, before starting a long reading or search phase, after a huge tool result, or when the user says the conversation is getting long. It costs one model call, so do not call it while the conversation is still short.\n`
        + 'The compaction applies to the next request, not this one: tell the user it takes effect from their next message.',
      parameters: {
        type: 'object',
        properties: {
          keepRecent: {
            type: 'integer', minimum: MIN_KEEP_RECENT, maximum: MAX_KEEP_RECENT,
            description: 'How many of the newest messages to keep verbatim (4–30, default 8). Raise it when the last few turns are still decisive.',
          },
          reason: { type: 'string', maxLength: 200, description: 'One short sentence on why compaction is needed now.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'context_read',
      label: '回查被压缩的原文',
      description: 'Read the original messages behind a compaction summary, verbatim and page by page (offset/limit, up to 6000 characters per call). A summary is a derived note, not evidence: never claim a file change, a page state or a command result from a summary alone.\n'
        + 'Call it whenever a summary is too coarse to act on, when you need the exact wording of an earlier instruction or constraint, or before retrying something the summary marks as done.\n'
        + 'The first line of the reply gives the range and nextOffset; pass nextOffset back as offset to continue.',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0, description: 'Character offset into the archived text. Defaults to 0.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT, description: `Maximum characters to return (1–${MAX_READ_LIMIT}). Defaults to ${DEFAULT_READ_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
  ];

  return {
    definitions,
    handlers: {
      context_status: guard('context_status', () => statusText()),
      context_compact: guard('context_compact', (args, ctx) => compactText(args, ctx)),
      context_read: guard('context_read', (args, ctx) => readText(args, ctx)),
    },
  };
}
