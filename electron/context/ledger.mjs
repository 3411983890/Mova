/**
 * 上下文台账（Context Ledger）：六层视图 + 压缩编排的纯函数内核。
 *
 * 负责：L1..L6 分层与 token 估算、把一段连续旧历史替换成摘要锚点、把被替换的原文留成可回查索引。
 * 不负责：调用模型（summarize 由调用方注入，同步 / Promise 均可）、归档落盘、组装 payload。
 * 被谁调用：electron/chat-agent.mjs 的 prepareLedger / applyLedger，以及 tests/context-ledger.test.mjs。
 * 零 IO、无全局状态；外部能力只有注入的 budget / digest 两个纯模块。
 * @see Mova上下文压缩与Agent上下文工程方案.md §4.2 §4.3 §4.4
 */
import { estimateMessageTokens, estimateRequestTokens } from './budget.mjs';
import { deterministicDigest, buildSummaryBlock } from './digest.mjs';

/** 六层固定顺序：组装 payload 与 status 展示都按它，不允许调用方自定义。 */
const LAYER_IDS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
const LAYER_NAMES = Object.freeze({ L1: '系统约束', L2: '项目规则', L3: '目标与计划', L4: '摘要', L5: '近期消息', L6: '归档索引' });
/** 约束识别词：只认这五个，避免把普通祈使句也钉成约束。 */
const PIN_KEYWORDS = Object.freeze(['不要', '禁止', '必须', '不能', '请勿']);
const MAX_PINNED = 8;
const PIN_MAX_CHARS = 120;
const DEFAULT_KEEP_RECENT = 8;
const DEFAULT_KEEP_FIRST_USER = 1;
const DEFAULT_READ_LIMIT = 4000;
/** 单次回查字符上限，与 §4.6 context_read 的 maximum 对齐。 */
const MAX_READ_LIMIT = 6000;
/** 归档索引：单条预览 48 字、最多 24 条。索引必须自己也有界，否则省下的 token 又还回去。 */
const INDEX_PREVIEW_CHARS = 48;
const INDEX_MAX_ENTRIES = 24;

// ---------------------------------------------------------------- 基础工具

/**
 * 从 digest 的任意形态里取出正文。
 * `deterministicDigest` 返回 `{ text, covered }`，但历史上也接受过裸字符串；
 * 统一在这里取一次，避免调用点各自判断导致「把结构化外壳当正文」的回归。
 */
function extractDigestText(digest) {
  if (typeof digest === 'string') return digest;
  if (digest && typeof digest === 'object' && typeof digest.text === 'string') return digest.text;
  return '';
}

/** 按码点计「字」：单条约束限长用的是这个口径，不是 UTF-16 长度。 */
function charCount(text) {
  return [...String(text == null ? '' : text)].length;
}

/** 截断到 max 字，超出用省略号占位且总长不超过 max。 */
function clip(text, max) {
  const source = String(text == null ? '' : text);
  const chars = [...source];
  return chars.length <= max ? source : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** 整数参数归一：非整数/越界一律退回默认值，避免 NaN 把压缩区间算穿。 */
function toInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(n, min), max);
}

/** 从各种消息形态里取纯文本：`{text}`（仓库现状）、`{content:string}`、`{content:[{type:'text'}]}`。 */
function textOf(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part.text === 'string' && (part.type === undefined || part.type === 'text'))
    .map((part) => part.text)
    .join('');
}

/** 消息归一化成 `{id, role, text}`；id 缺失时按位置补 `m1..mN`（归档与 coveredMessages 都要稳定 id）。 */
function normalizeMessages(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((item, index) => {
    const isObject = item && typeof item === 'object';
    return {
      id: isObject && typeof item.id === 'string' && item.id ? item.id : `m${index + 1}`,
      role: isObject && typeof item.role === 'string' && item.role ? item.role : 'user',
      text: textOf(item),
    };
  });
}

/** 层的输入允许 string / `{text}` / `{content}`，一律折成字符串。 */
function layerTextOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/** 外部显式钉住的事实（P4）：只留有文本的项，且与约束同口径限量。 */
function normalizePinned(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const raw = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const id = item && typeof item === 'object' && typeof item.id === 'string' && item.id ? item.id : `pin-${out.length + 1}`;
    out.push({ id, text: clip(text, PIN_MAX_CHARS) });
    if (out.length >= MAX_PINNED) break;
  }
  return out;
}

/** 句子 → 分句，并去掉列表符号（`-`、`1.`、`*`）。约束藏在长句中间时必须能被切出来。 */
function splitClauses(text) {
  return String(text == null ? '' : text)
    .split(/[\n。！？；!?;]+/)
    .flatMap((sentence) => sentence.split(/[，,]+/))
    .map((part) => part.replace(/^[\s>*\-–—0-9.、)）]+/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 公开纯函数

/**
 * 抽取「不得违背」的约束，最多 8 条、单条 ≤120 字。
 * 只做逐字抓取不做改写：约束一旦被重写就失去了「原文逐字」的效力。
 * @param {Array} messages 任意形态的消息数组
 * @returns {{id: string, text: string}[]}
 */
export function pinnedConstraints(messages) {
  const out = [];
  const seen = new Set();
  for (const message of normalizeMessages(messages)) {
    const clauses = splitClauses(message.text);
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index];
      if (!PIN_KEYWORDS.some((keyword) => clause.includes(keyword))) continue;
      const text = clip(clause, PIN_MAX_CHARS);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ id: `${message.id}:c${index + 1}`, text });
      if (out.length >= MAX_PINNED) return out;
    }
  }
  return out;
}

/**
 * 划出不压缩区：最近 keepRecent 条 + 最前 keepFirstUser 条用户消息。
 * 两个数组都保持原顺序；区间必须连续（§4.4 硬规则 1），所以两头之间的消息一律算 compressible。
 * @param {Array} messages
 * @param {{keepRecent?: number, keepFirstUser?: number}} [options]
 * @returns {{compressible: Array, keep: Array}}
 */
export function selectCompressible(messages, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const list = normalizeMessages(messages);
  const plan = planCompaction(list, {
    keepRecent: toInt(settings.keepRecent, DEFAULT_KEEP_RECENT, 0, list.length),
    keepFirstUser: toInt(settings.keepFirstUser, DEFAULT_KEEP_FIRST_USER, 0, list.length),
  });
  return {
    compressible: plan.covered.map((entry) => entry.message),
    keep: plan.kept.map((entry) => entry.message),
  };
}

/**
 * 内部区间规划：返回带索引的 covered / kept（压缩后要按索引拼连续区间，所以必须留索引）。
 * 区间连续性：被 keep 夹在中间的少数消息（典型是「首条用户消息」落在旧历史里）并入 covered，
 * 其原文由摘要块逐字保留，否则摘要会跨过一段没压缩的区间而顺序错乱。
 */
function planCompaction(list, { keepRecent, keepFirstUser }) {
  const keepIndex = new Set();
  for (let i = Math.max(0, list.length - keepRecent); i < list.length; i += 1) keepIndex.add(i);
  let foundUsers = 0;
  for (let i = 0; i < list.length && foundUsers < keepFirstUser; i += 1) {
    if (list[i].role === 'user') {
      keepIndex.add(i);
      foundUsers += 1;
    }
  }
  const marked = [];
  list.forEach((_, index) => {
    if (!keepIndex.has(index)) marked.push(index);
  });
  if (!marked.length) return { covered: [], kept: list.map((message, index) => ({ index, message })) };

  const start = marked[0];
  const end = marked[marked.length - 1];
  const covered = [];
  const kept = [];
  list.forEach((message, index) => {
    if (index >= start && index <= end) covered.push({ index, message });
    else kept.push({ index, message });
  });
  return { covered, kept };
}

// ---------------------------------------------------------------- 台账

/**
 * 创建一份台账。`messages` 在创建时做快照：压缩只改「当前窗口」，原文快照永久可用（read 靠它）。
 * @param {{layers?: object, messages?: Array, tools?: Array, pinned?: Array}} input
 */
export function createLedger({ layers, messages, tools, pinned } = {}) {
  const baseLayerTexts = {
    L1: layerTextOf(layers && layers.L1),
    L2: layerTextOf(layers && layers.L2),
    L3: layerTextOf(layers && layers.L3),
  };
  const toolList = Array.isArray(tools) ? tools.slice() : [];
  const initialMessages = normalizeMessages(messages);

  // 约束在创建时抽取一次并常驻 L1：压缩把原消息移出窗口后，约束不能跟着消失。
  const allPinned = normalizePinned([...(Array.isArray(pinned) ? pinned : []), ...pinnedConstraints(initialMessages)]);

  // read() 的原文快照：用 '\n' 连接即「逐字可拼回」，不做任何改写。
  const sourceText = initialMessages.map((message) => message.text).join('\n');

  const state = {
    messages: initialMessages.slice(),
    summaries: [],
    archive: [],
    compactions: 0,
    lastCompactionAt: null,
  };

  function pinnedBlock() {
    if (!allPinned.length) return '';
    return ['【用户约束（逐字保留，压缩不移除）】', ...allPinned.map((item, i) => `${i + 1}. ${item.text}`)].join('\n');
  }

  function archiveIndex() {
    if (!state.archive.length) return '';
    const half = Math.floor(INDEX_MAX_ENTRIES / 2);
    const head = state.archive.slice(0, half);
    const tail = state.archive.length > INDEX_MAX_ENTRIES ? state.archive.slice(-half) : [];
    const format = (entry) => `- ${entry.id} · ${clip(entry.text.replace(/\s+/g, ' '), INDEX_PREVIEW_CHARS)}`;
    const lines = head.map(format);
    if (tail.length) lines.push(`- … 省略 ${state.archive.length - head.length - tail.length} 条（按 id 回查）`);
    lines.push(...tail.map(format));
    return ['【归档索引（原文可逐字回查）】', ...lines].join('\n');
  }

  /** 六层各自的文本。L5 是消息数组，在 layerRows 里按条估算。 */
  function layerTexts() {
    return {
      L1: [baseLayerTexts.L1, pinnedBlock()].filter(Boolean).join('\n\n'),
      L2: baseLayerTexts.L2,
      L3: baseLayerTexts.L3,
      L4: state.summaries.map((summary) => summary.block).join('\n\n'),
      L5: state.messages.map((message) => message.text).join('\n'),
      L6: archiveIndex(),
    };
  }

  /** 空文本直接 0：否则预算模块的固定开销会让「空的 L4 / L6」也占 token。 */
  function tokenOf(role, content) {
    if (!content) return 0;
    const value = estimateMessageTokens({ role, content });
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  function layerRows() {
    const texts = layerTexts();
    return LAYER_IDS.map((id) => {
      if (id === 'L5') {
        let tokens = 0;
        for (const message of state.messages) tokens += tokenOf(message.role, message.text);
        return { id, name: LAYER_NAMES[id], tokens, chars: charCount(texts.L5), messages: state.messages.length };
      }
      const text = texts[id] || '';
      return { id, name: LAYER_NAMES[id], tokens: tokenOf('system', text), chars: charCount(text) };
    });
  }

  function totalTokens() {
    return layerRows().reduce((sum, row) => sum + row.tokens, 0);
  }

  /** 整请求口径（含工具声明），只做展示；六层之和才是台账口径。 */
  function requestTokens() {
    try {
      const value = estimateRequestTokens({
        messages: state.messages.map((message) => ({ role: message.role, content: message.text })),
        tools: toolList,
      });
      return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    } catch {
      // 预算模块升级不应该让「查账」失败
      return 0;
    }
  }

  function stats() {
    const rows = layerRows();
    return {
      total: {
        tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
        chars: rows.reduce((sum, row) => sum + row.chars, 0),
        estimated: true,
      },
      layers: rows,
      messages: {
        total: initialMessages.length,
        kept: state.messages.length,
        compressed: initialMessages.length - state.messages.length,
      },
      compactions: state.compactions,
      lastCompactionAt: state.lastCompactionAt,
    };
  }

  function status() {
    const base = stats();
    return {
      layers: base.layers.map((row) => ({
        ...row,
        ratio: base.total.tokens ? Number((row.tokens / base.total.tokens).toFixed(4)) : 0,
      })),
      total: base.total,
      request: { tokens: requestTokens(), tools: toolList.length },
      messages: base.messages,
      compactions: base.compactions,
      lastCompactionAt: base.lastCompactionAt,
      pinned: allPinned.length,
      canCompact: planCompaction(state.messages, {
        keepRecent: DEFAULT_KEEP_RECENT,
        keepFirstUser: DEFAULT_KEEP_FIRST_USER,
      }).covered.length > 0,
    };
  }

  /**
   * 确定性回退：摘要器失败时也要给出「能读的」摘要。
   * 依次尝试 digest.mjs 的结构化结果 → 渲染文本 → 原文缩略，三层兜底保证绝不中断。
   */
  function digestText(covered) {    const payload = covered.map((message) => ({ id: message.id, role: message.role, text: message.text }));
    let digest = null;
    try {
      digest = deterministicDigest(payload);
    } catch {
      digest = null;
    }
    if (digest !== null && digest !== undefined) {
      try {
        // buildSummaryBlock 返回的是 `{kind, span, source, text}` 对象，正文在 `.text`；
        // 直接把它当字符串用会掉到 JSON.stringify 分支，把结构化外壳塞进摘要正文。
        const rendered = buildSummaryBlock({ text: extractDigestText(digest) });
        const text = typeof rendered === 'string' ? rendered : (rendered && typeof rendered.text === 'string' ? rendered.text : '');
        if (typeof text === 'string' && text.trim()) return text.trim();
      } catch {
        // 渲染失败就退回字符串 / JSON，仍然不抛
      }
      const inline = extractDigestText(digest);
      if (inline && inline.trim()) return inline.trim();
      if (typeof digest === 'string' && digest.trim()) return digest.trim();
    }
    return payload.map((message) => `[${message.role}] ${clip(message.text, 200)}`).join('\n');
  }

  /** 摘要块 = 导航信息（span/source）+ 正文 + 逐字约束 + 回查提示。 */
  function buildBlock({ id, covered, body, source }) {
    const constraints = pinnedConstraints(covered);
    return [
      `[上下文摘要 ${id} span=${covered[0].id}..${covered[covered.length - 1].id} covered=${covered.length} source=${source}]`,
      body,
      constraints.length ? ['【用户约束（逐字保留）】', ...constraints.map((item, i) => `${i + 1}. ${item.text}`)].join('\n') : '',
      '[上文原文仍可逐字回查：read({offset, limit})]',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 真正落账：改窗口、写归档、加摘要。同步摘要与异步摘要共用。 */
  function commit(plan, result, settings) {
    const before = totalTokens();
    const createdAt = toInt(settings.now, Date.now(), 0, Number.MAX_SAFE_INTEGER);
    const covered = plan.covered.map((entry) => entry.message);
    const coveredMessages = covered.map((message) => message.id);
    const span = { from: plan.covered[0].index, to: plan.covered[plan.covered.length - 1].index + 1 };
    const recordId = `ctx_${createdAt}_${state.compactions + 1}`;

    const candidate = result && typeof result === 'object' && typeof result.text === 'string' ? result.text.trim() : '';
    const body = candidate || digestText(covered);
    // 只有调用方明确声明 deterministic 才降级标注，其余视为模型产物
    const source = candidate && result.source !== 'deterministic' ? 'llm' : 'deterministic';

    const block = buildBlock({ id: recordId, covered, body, source });
    const archive = covered.map((message) => ({ id: message.id, text: message.text }));

    state.archive.push(...archive);
    state.summaries.push({ id: recordId, span, source, createdAt, block, coveredMessages });
    state.messages = plan.kept.map((entry) => entry.message);
    state.compactions += 1;
    state.lastCompactionAt = createdAt;

    const after = totalTokens();
    return {
      compacted: true,
      coveredMessages,
      summaryBlock: block,
      archive,
      source,
      record: {
        id: recordId,
        kind: 'compact',
        version: 1,
        createdAt,
        span,
        coveredMessages: archive.length,
        source,
        tokens: { before, after, saved: Math.max(0, before - after), estimated: true },
      },
    };
  }

  /**
   * 压缩：把「最近 keepRecent + 最前 keepFirstUser + pinned」之外的那一段换成摘要锚点。
   * summarize 抛错/返回非法结果都回退 deterministicDigest，始终返回结果，绝不中断。
   * summarize 也可以返回 Promise：交给 LLM 时调用方一定用 await。
   * @param {{keepRecent?: number, keepFirstUser?: number, summarize?: Function, now?: number}} [options]
   */
  function compact(options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    const plan = planCompaction(state.messages, {
      keepRecent: toInt(settings.keepRecent, DEFAULT_KEEP_RECENT, 0, state.messages.length),
      keepFirstUser: toInt(settings.keepFirstUser, DEFAULT_KEEP_FIRST_USER, 0, state.messages.length),
    });
    if (!plan.covered.length) {
      return { compacted: false, reason: 'too-few-messages', coveredMessages: [], summaryBlock: '', archive: [], source: null };
    }

    let outcome = null;
    if (typeof settings.summarize === 'function') {
      try {
        outcome = settings.summarize(plan.covered.map((entry) => ({ ...entry.message })));
      } catch {
        outcome = null;
      }
    }

    if (outcome && typeof outcome.then === 'function') {
      return Promise.resolve(outcome)
        .then((result) => commit(plan, result, settings))
        .catch(() => commit(plan, null, settings));
    }
    return commit(plan, outcome, settings);
  }

  /**
   * 分页读原文（字符偏移，逐字一致）。越界一律 `{error:'invalid-range'}`，不抛异常，
   * 这样工具层可以直接把结果回给模型。
   * @param {{offset?: number, limit?: number}} [range]
   */
  function read(range = {}) {
    const request = range && typeof range === 'object' ? range : {};
    const offset = request.offset === undefined ? 0 : request.offset;
    const limit = request.limit === undefined ? DEFAULT_READ_LIMIT : request.limit;
    if (!Number.isInteger(offset) || !Number.isInteger(limit)) return { error: 'invalid-range' };
    if (offset < 0 || limit < 1 || offset >= sourceText.length) return { error: 'invalid-range' };
    const size = Math.min(limit, MAX_READ_LIMIT);
    const end = Math.min(sourceText.length, offset + size);
    return {
      text: sourceText.slice(offset, end),
      offset,
      limit: size,
      total: sourceText.length,
      nextOffset: end < sourceText.length ? end : null,
      done: end >= sourceText.length,
    };
  }

  return {
    /** 六层当前内容（L1..L6 顺序），组 payload 时直接用。 */
    get layers() {
      const texts = layerTexts();
      const rows = layerRows();
      return LAYER_IDS.map((id, index) => ({ id, name: LAYER_NAMES[id], text: texts[id] || '', tokens: rows[index].tokens }));
    },
    /** 当前窗口里的消息（已被压缩的不会在这里，但 read 仍能读到原文）。 */
    get messages() {
      return state.messages.map((message) => ({ ...message }));
    },
    status,
    compact,
    read,
    stats,
  };
}
