/**
 * 上下文预算：token 估算 + 档位判定（纯函数，零 IO、零 Electron 依赖）
 *
 * 负责：把 system / messages / tools 折算成「估算 token」，给出 ok/soft/hard/overflow 四档，
 *       并用滞回判断「这一轮到底该不该压缩」；以及一轮内**工具输出**的 token 预算
 *       （`toolRunBudget()`，按模型上下文窗口缩放，取代过去写死的 200k 字符）。
 * 不负责：调用模型、读取 provider 的 usage、决定压哪一段、写归档——那些在 ledger/summarize 里。
 * 口径：本模块输出的一切都是 estimated（本地估算），不是 provider 回报的 actual usage；
 *       两者不得相减、不得相除、不得混进同一张表的同一列（方案 §8.4）。
 * 被谁调用：electron/context/ledger.mjs、chat-agent 的 transformContext、context_status 工具、tests。
 */

// 估算系数：宁可高估，也不要等到 provider 报错才发现。
//   CJK 1.5 token/字 —— 主流分词器中文约 1–1.5 字/token，pi-ai 的 chars/3.5 会低估 3 倍以上；
//   ASCII 0.28/字符  —— 相当于 3.6 字符/token；
//   代码块 0.3/字符 —— 符号密集，比普通 ASCII 略贵；
//   图片 800/块     —— 本地无法测真实像素 token，按固定开销计（pi-ai 用 4800 字符折算，同量级）。
const TOKENS_PER_CJK = 1.5;
const TOKENS_PER_ASCII = 0.28;
const TOKENS_PER_CODE_CHAR = 0.3;
const IMAGE_TOKENS = 800;
// 每条消息的结构开销（role 标记、字段名、分隔符），方案 §6 的 ≈4。
const MESSAGE_OVERHEAD = 4;

// 滞回：同一次压缩后已用量没回落满 10 个百分点，就不再触发第二次（防抖 + 防止压不动的东西反复烧钱）。
const HYSTERESIS = 0.10;
// 校准系数上下限：超出这个范围说明估算口径已经失效，宁可夹住也不要让阈值失真。
const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 3;
const CALIBRATION_ALPHA = 0.3;

const DEFAULT_SOFT = 0.7;
const DEFAULT_HARD = 0.85;

// ── 工具输出预算（一轮内所有工具结果累加）────────────────────────────────
// 以前写死 200,000 **字符**，有两个问题：
//   1) 对 272k / 500k 窗口的模型，这只占窗口的 5–10%，长任务（设计循环、浏览器快照）动不动撞线；
//   2) 单位是字符，中文严重低估——20 万汉字约 30 万 token，能直接把窗口顶爆。
// 现在按 estimateTokens() 计 token，再按窗口比例给预算，上下限夹住。
const TOOL_BUDGET_SHARE = 0.25;          // 工具输出最多占窗口的 1/4
/** 不低于旧实现的实际容量（200k 英文 ≈ 55k token）：小窗口模型不许变得更紧。 */
const TOOL_BUDGET_MIN_TOKENS = 55_000;
/** 上限：再大就只是给死循环发燃料。 */
const TOOL_BUDGET_MAX_TOKENS = 150_000;

const CJK_CHARS = /[\u3000-\u9fff\uff00-\uffef]/gu;
const FENCED_CODE = /```[\s\S]*?```/g;
const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image', 'image_data']);

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // 循环引用等异常结构不该让预算崩掉：算 0，宁可低估结构、也不要让整轮对话失败。
    return '';
  }
}

/**
 * 中英混排文本的保守估算。
 * @param {unknown} text 任意值（非字符串按 String 处理）
 * @returns {number} 估算 token（整数）
 */
export function estimateTokens(text) {
  if (text === null || text === undefined) return 0;
  const value = typeof text === 'string' ? text : String(text);
  if (!value.trim()) return 0;
  let codeChars = 0;
  // 先摘掉围栏代码块再数 CJK：代码块按 0.3/字符单独计价，避免同一批字符被数两遍。
  // 代码块里的中文注释会因此略微低估，属于可接受的保守方向之外的误差（远小于按 1.5 计）。
  const prose = value.replace(FENCED_CODE, block => {
    codeChars += block.length;
    return ' ';
  });
  const cjk = (prose.match(CJK_CHARS) || []).length;
  const ascii = Math.max(0, prose.length - cjk);
  const raw = cjk * TOKENS_PER_CJK + ascii * TOKENS_PER_ASCII + codeChars * TOKENS_PER_CODE_CHAR;
  // 先归一到 1e-6 再向上取整：100×0.28 在浮点下是 28.000000000000004，直接 ceil 会白多算 1 token，
  // 也会破坏「同类内容线性增长」这个可测性质。
  return Math.ceil(Math.round(raw * 1e6) / 1e6);
}

/**
 * 一轮内「所有工具结果累加」的 token 预算，随模型上下文窗口缩放。
 *
 * @param {number} contextWindow 模型上下文窗口（**token**，与 providers 的 `contextWindow` 同口径）
 * @returns {number} 估算 token 上限，落在 [TOOL_BUDGET_MIN_TOKENS, TOOL_BUDGET_MAX_TOKENS]
 *
 * 窗口缺失或非法时退回下限（= 旧实现的实际容量），**绝不**因为读不到窗口就把预算放大。
 */
export function toolRunBudget(contextWindow) {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return TOOL_BUDGET_MIN_TOKENS;
  const share = Math.floor(window * TOOL_BUDGET_SHARE);
  return Math.min(TOOL_BUDGET_MAX_TOKENS, Math.max(TOOL_BUDGET_MIN_TOKENS, share));
}

/**
 * 工具输出预算用超了之后该怎么办（纯判定，不碰 IO）。
 *
 * 为什么不是「超了就立刻停」：硬停时模型连一句「我已经做完什么、还差什么」都没机会说，
 * 用户看到的是一次没有结论的中断。所以第一次超预算返回 `'wrap-up'`——把真实的工具结果换成
 * 「预算已用尽，别再调工具，说说现在的状态」这条指令，让模型**在本轮正常收尾**；
 * 如果它收了指令还继续调工具，下一次才返回 `'stop'`（有界，不会无限续）。
 *
 * @param {{ tokens: number, budget: number, wrapUpSent?: boolean }} input
 *   `tokens` 是累加到本次调用之后的估算 token，`wrapUpSent` 表示是否已经给过收尾指令
 * @returns {'ok'|'wrap-up'|'stop'}
 */
export function toolBudgetVerdict({ tokens, budget, wrapUpSent = false } = {}) {
  const used = Number(tokens);
  const limit = Number(budget);
  // 读不出数字时按「没超」处理：宁可不拦，也不要因为一个 NaN 掐断整轮。
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used <= limit) return 'ok';
  return wrapUpSent === true ? 'stop' : 'wrap-up';
}

// 统一走一遍内容块：文本计入 token，图片只登记个数（固定开销最后一次性加），
// 未知块按 text 兜底，避免新协议字段被静默漏算。
function contentTokens(value, stats) {  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTokens(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const part of value) total += contentTokens(part, stats);
    return total;
  }
  if (typeof value !== 'object') return estimateTokens(String(value));
  const type = typeof value.type === 'string' ? value.type : '';
  if (IMAGE_PART_TYPES.has(type)) {
    stats.images += 1;
    return 0;
  }
  if (type === 'text') return estimateTokens(value.text);
  if (type === 'tool_use' || type === 'toolUse' || type === 'tool_call' || type === 'toolCall') {
    return estimateTokens(value.name ?? '') + estimateTokens(safeJson(value.arguments ?? value.input ?? {}));
  }
  if (type === 'tool_result' || type === 'tool_result_error' || type === 'toolResult') {
    return contentTokens(value.content ?? value.text, stats);
  }
  if (typeof value.text === 'string') return estimateTokens(value.text);
  if (value.content !== undefined) return contentTokens(value.content, stats);
  return 0;
}

/**
 * 单条消息的估算，含图片块固定开销。
 *
 * 同时接受两种形态：Mova 历史（`{role, text, images:[id]}`）与送给 provider 的请求形态
 * （`{role, content:[{type:'text'|'image'|...}]}`）。同一条消息常常两份表示同时存在，
 * 所以文本取较大值、图片数取较大值——宁可少算一次重复，也不能把同一段内容计两遍。
 */
export function estimateMessageTokens(message) {
  if (message === null || message === undefined) return 0;
  if (typeof message === 'string') return estimateTokens(message) + MESSAGE_OVERHEAD;
  if (typeof message !== 'object') return estimateTokens(String(message)) + MESSAGE_OVERHEAD;
  const stats = { images: 0 };
  const fromContent = contentTokens(message.content, stats);
  const fromText = estimateTokens(message.text);
  let tokens = MESSAGE_OVERHEAD + Math.max(fromContent, fromText);
  const calls = message.toolCalls ?? message.tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) tokens += contentTokens(call, stats);
  }
  const imageIds = Array.isArray(message.images) ? message.images.length : 0;
  tokens += Math.max(stats.images, imageIds) * IMAGE_TOKENS;
  return Math.ceil(tokens);
}

/**
 * 一份请求（system + messages + tools）的估算总量。工具声明按序列化后的字符估，
 * 因为真正发出去的就是那段 JSON。
 */
export function estimateRequestTokens({ system, messages, tools } = {}) {
  const stats = { images: 0 };
  let total = 0;
  if (system !== null && system !== undefined) {
    total += typeof system === 'string' ? estimateTokens(system) : contentTokens(system, stats);
  }
  if (Array.isArray(messages)) {
    for (const message of messages) total += estimateMessageTokens(message);
  }
  if (Array.isArray(tools)) {
    for (const tool of tools) total += estimateTokens(safeJson(tool));
  }
  total += stats.images * IMAGE_TOKENS;
  return Math.ceil(total);
}

// lastUsed 允许两种口径：直接给 ratio（≤1.5 视为比例），或给 token 数（用预算换算成比例）。
// 名字叫 lastUsed，但比较的是「用量占比」，所以两种都能接受。
function asRatio(value, toRatio) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number > 1.5 ? toRatio(number) : number;
}

function clampCalibration(value) {
  return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, value));
}

/**
 * 校准：用 provider 回报的 usage.input 与本地估算的比值修正系数。
 * 例：usage.input=18400，本地估 16000 → ratio 1.15 → calibrate(1.15, {previous})。
 *
 * @param {number} factor 观测比值（actual / estimated）
 * @param {{ previous?: number, alpha?: number }} [options] previous 是当前系数（默认 1）
 * @returns {number} 新的估算系数，clamp 在 [0.5, 3]
 */
export function calibrate(factor, { previous = 1, alpha = CALIBRATION_ALPHA } = {}) {
  const prior = Number.isFinite(Number(previous)) ? clampCalibration(Number(previous)) : 1;
  const observed = Number(factor);
  const weight = Number.isFinite(Number(alpha)) ? Math.min(1, Math.max(0, Number(alpha))) : CALIBRATION_ALPHA;
  if (!Number.isFinite(observed) || observed <= 0) return prior;
  return clampCalibration(prior * (1 - weight) + observed * weight);
}

/**
 * 建一份预算。所有档位都以 usable（窗口减去输出预留）为分母：
 * 用整个窗口当分母会把阈值定得太乐观，最后一段输出没地方放就溢出了。
 *
 * @param {{ contextWindow: number, reserveOutput?: number, thresholds?: {soft?: number, hard?: number} }} input
 */
export function createBudget({ contextWindow, reserveOutput, thresholds } = {}) {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) {
    throw new TypeError('contextWindow 必须是正数：缺少模型窗口时不能按默认值静默估算');
  }
  const reserve = reserveOutput === undefined || reserveOutput === null
    ? Math.floor(window * 0.3)
    : Number(reserveOutput);
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= window) {
    throw new TypeError('reserveOutput 必须小于 contextWindow（否则可用预算为 0）');
  }
  const soft = thresholds?.soft === undefined ? DEFAULT_SOFT : Number(thresholds.soft);
  const hard = thresholds?.hard === undefined ? DEFAULT_HARD : Number(thresholds.hard);
  if (!Number.isFinite(soft) || !Number.isFinite(hard) || soft <= 0 || hard <= soft) {
    throw new TypeError('thresholds 必须满足 0 < soft < hard');
  }
  const usable = window - reserve;

  const ratio = used => {
    const value = Number(used);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value / usable;
  };
  const level = used => {
    const current = ratio(used);
    if (current > 1) return 'overflow';
    if (current >= hard) return 'hard';
    if (current >= soft) return 'soft';
    return 'ok';
  };

  return {
    contextWindow: window,
    reserveOutput: reserve,
    usable,
    thresholds: { soft, hard },
    // 面板要展示「还差多少 token 到下一次自动压缩」，所以把换算结果一起给出。
    softAt: Math.floor(soft * usable),
    hardAt: Math.floor(hard * usable),
    ratio,
    level,
    // 剩余可用预算，不返回负数：UI 显示负数没有意义，溢出由 level==='overflow' 表达。
    remaining: used => {
      const value = Number(used);
      if (!Number.isFinite(value) || value <= 0) return usable;
      return Math.max(0, usable - value);
    },
    /**
     * 这一轮该不该压缩。
     *
     * 滞回规则：同一次压缩后，已用量没回落满 10 个百分点，就认为「上一次压缩基本没腾出空间」，
     * 在 soft 档不再重复触发（重复压缩只是白烧一次模型调用）；真的压不动时会由 hard/overflow 兜底。
     * lastUsed 记的是压缩发生时的用量，不是压缩后的用量——记录压缩后的值会让阈值永久卡死。
     */
    shouldCompact(used, { lastCompactAt, lastUsed } = {}) {
      const current = ratio(used);
      const now = level(used);
      // hard / overflow 不受滞回限制：再不让位就装不下了。
      if (now === 'hard' || now === 'overflow') return true;
      if (now === 'ok') return false;
      // 没有压缩史：这就是第一次触发。
      if (lastCompactAt === null || lastCompactAt === undefined) return true;
      const base = asRatio(lastUsed, ratio);
      // 有压缩史但没记下当时的用量：按首次处理，避免永久卡死。
      if (base === null) return true;
      // 减去 1e-9：0.84-0.74 这类十进制差值在浮点下可能略小于 0.1，不能因此拒绝「刚好回落满」。
      return base - current >= HYSTERESIS - 1e-9;
    },
  };
}
