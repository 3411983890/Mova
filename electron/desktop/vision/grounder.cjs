'use strict';
// 视觉接地：只做“目标在哪”，不做计划、不做多步（Mova桌面操作开发方案.md §8.5）。
//
//   const grounder = createGrounder({ callModel, cacheMs: 5000, budgetFrames: 20 });
//   const hit = await grounder.locate({ buffer, size:[1568,980], marks, goal:'点击“确定”' });
//
// callModel 由外部注入，形如 async ({ image, prompt, schema }) => object | string。
// 输出契约（严格 JSON；允许 ```json 围栏或夹带解释文字，取第一个完整 JSON 对象）：
//   {"action":"click","mark":12,"confidence":0.92}
//   {"action":"click","point":[1236,874],"confidence":0.71}
//   {"action":"cannot_locate","reason":"目标不在当前画面"}
// 失败一律结构化返回 {ok:false, code, message}，不抛异常（一次接地失败不能带崩桌面会话）：
//   bad-grounding | point-out-of-bounds | bad-image-size | cannot-locate
//   | vision-disabled | vision-budget-exhausted | vision-failed | ground-model-failed

const crypto = require('node:crypto');
const { visionAllowed } = require('../policy.cjs');

const DEFAULT_CACHE_MS = 5000;
const DEFAULT_BUDGET_FRAMES = 20;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const MAX_REASON = 200;

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'cannot_locate'] },
    mark: { type: 'integer', minimum: 1, maximum: 99 },
    point: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['action'],
  additionalProperties: false,
});

const SYSTEM_PROMPT = [
  '你是桌面 UI 的视觉接地模型。只负责在截图上定位一个目标，不解释、不规划。',
  '输入顺序：截图 → 候选编号列表（可选）→ 目标。',
  '只输出一个 JSON 对象，不要 markdown，不要多余文字：',
  '{"action":"click","mark":<编号>,"confidence":0..1}  目标有编号框时优先用这个；',
  '{"action":"click","point":[x,y],"confidence":0..1}  没有编号框、或框都不对时用图像像素坐标；',
  '{"action":"cannot_locate","reason":"<一句话>"}      目标不在当前画面时用这个。',
  '图像坐标原点在左上角，x 向右、y 向下，范围就是给出的图像尺寸。',
  '只输出一个动作；多步操作由上层拆。',
].join('\n');

function coded(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeGoal(goal) {
  return String(goal === undefined || goal === null ? '' : goal).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function boxOf(mark) {
  const raw = mark && (mark.box || mark.rect);
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const [x, y, w, h] = raw.map((value) => num(value, NaN));
    return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
  }
  if (typeof raw === 'object') {
    const x = num(raw.x, NaN);
    const y = num(raw.y, NaN);
    const w = num(raw.w !== undefined ? raw.w : raw.width, NaN);
    const h = num(raw.h !== undefined ? raw.h : raw.height, NaN);
    return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
  }
  return null;
}

/** 固定 prompt（图像在前、目标在后，对 prompt cache 友好）。 */
function buildPrompt({ size, marks, goal }) {
  const [width, height] = Array.isArray(size) ? size : [num(size && size.width), num(size && size.height)];
  const lines = [];
  lines.push(`图像尺寸：${Math.round(width)}x${Math.round(height)}（像素）`);
  const list = Array.isArray(marks) ? marks : [];
  if (list.length) {
    lines.push('候选编号（#编号 角色 "名称" [x,y,w,h]）：');
    for (const mark of list.slice(0, 99)) {
      const box = boxOf(mark);
      const label = `#${num(mark.id)} ${mark.role || 'element'}`;
      const name = mark.name ? ` "${String(mark.name).slice(0, 40)}"` : '';
      const rect = box ? ` [${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}]` : '';
      lines.push(`${label}${name}${rect}`);
    }
  } else {
    lines.push('没有候选编号：请直接用 point 返回图像坐标。');
  }
  lines.push(`目标：${sanitizeGoal(goal) || '（未给出目标）'}`);
  return lines.join('\n');
}

/** 从任意文本里抠出第一个完整的 JSON 对象（跳过字符串里的花括号与转义）。 */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function parseModelOutput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') throw coded('bad-grounding', '模型输出既不是对象也不是字符串');
  const text = raw.trim();
  if (!text) throw coded('bad-grounding', '模型输出为空');
  // 依次尝试：整段 → ```json 围栏 → 第一个完整 JSON 对象（模型爱加解释文字）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [text];
  if (fenced) candidates.push(fenced[1].trim());
  for (const source of [text, fenced ? fenced[1] : '']) {
    const objectText = source ? firstJsonObject(source) : '';
    if (objectText) candidates.push(objectText);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 换下一个候选 */ }
  }
  throw coded('bad-grounding', `模型输出不是合法 JSON: ${text.slice(0, 120)}`);
}

function shaOf(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
}

/**
 * @param {object} deps
 * @param {Function} deps.callModel async ({image, prompt, schema}) => object|string
 * @param {number} [deps.cacheMs=5000]
 * @param {number} [deps.budgetFrames=20]
 * @param {number} [deps.minConfidence=0.6]
 * @param {object|Function} [deps.settings] policy 形状设置 {advanced:{vision},budget:{maxVisionFrames}}（或 getter）
 * @param {Function} [deps.now] 注入时钟（测试缓存 TTL 用）
 */
function createGrounder(deps = {}) {
  const { callModel, cacheMs = DEFAULT_CACHE_MS, budgetFrames = DEFAULT_BUDGET_FRAMES, minConfidence = DEFAULT_MIN_CONFIDENCE } = deps;
  if (typeof callModel !== 'function') throw coded('vision-unavailable', 'callModel 未注入');
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const maxFrames = Math.max(1, Math.round(num(budgetFrames, DEFAULT_BUDGET_FRAMES)));
  const ttl = Math.max(0, num(cacheMs, DEFAULT_CACHE_MS));
  // 有 settings 就交给 policy.visionAllowed 判（开关 + 帧预算一套口径）；没有就退回 budgetFrames。
  const readSettings = typeof deps.settings === 'function'
    ? deps.settings
    : (deps.settings && typeof deps.settings === 'object' ? () => deps.settings : null);

  const cache = new Map(); // key -> {at, result}
  const counters = { calls: 0, hits: 0, cacheHits: 0, tokensEstimate: 0 };

  /** 发请求前的闸门：视觉关闭 / 帧预算耗尽都必须直接返回，绝不发请求。 */
  function gate() {
    if (!readSettings) {
      if (counters.calls >= maxFrames) {
        return { ok: false, code: 'vision-budget-exhausted', calls: counters.calls, budgetFrames: maxFrames };
      }
      return null;
    }
    const settings = readSettings() || {};
    if (settings?.advanced?.vision === false) {
      return { ok: false, code: 'vision-disabled', message: '视觉通道已在设置中关闭（设置 → 集成 → 电脑操作 → 高级）' };
    }
    // 每调用一次模型算一帧：已用帧数就是 counters.calls。
    if (!visionAllowed(settings, counters.calls)) {
      return {
        ok: false,
        code: 'vision-budget-exhausted',
        calls: counters.calls,
        budgetFrames: num(settings?.budget?.maxVisionFrames, DEFAULT_BUDGET_FRAMES),
      };
    }
    return null;
  }

  function pruneCache(at) {
    for (const [key, entry] of cache) {
      if (at - entry.at > ttl) cache.delete(key);
    }
  }

  function estimateTokens(width, height, prompt) {
    const image = Math.ceil((Math.max(1, width) * Math.max(1, height)) / 800);
    const text = Math.ceil(String(prompt || '').length / 4);
    return image + text;
  }

  /**
   * @param {object} input
   * @param {Buffer} input.buffer 截图
   * @param {number[]|{width:number,height:number}} [input.size] 图像尺寸（缺省从 marks/调用方给）
   * @param {object[]} [input.marks] SoM 候选
   * @param {string} input.goal
   * @param {string} [input.sha] 复用截图 sha（避免重复 hash）
   */
  async function locate(input = {}) {
    const goal = sanitizeGoal(input.goal);
    if (!goal) throw coded('bad-goal', 'locate 需要 goal');
    const buffer = input.buffer;
    const sha = typeof input.sha === 'string' && input.sha ? input.sha : (Buffer.isBuffer(buffer) ? shaOf(buffer) : '');
    const marks = Array.isArray(input.marks) ? input.marks : [];
    const size = Array.isArray(input.size) ? input.size : [num(input.size && input.size.width), num(input.size && input.size.height)];
    const width = num(size[0]);
    const height = num(size[1]);

    const at = now();
    pruneCache(at);
    // 闸门最先判：关闭/超预算时连缓存都不读，更不发请求。
    const blocked = gate();
    if (blocked) return { ...blocked, sha };

    const cacheKey = `${sha}|${goal}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      counters.cacheHits += 1;
      counters.hits += 1;
      return { ...cached.result, cached: true, sha };
    }

    const prompt = buildPrompt({ size: [width, height], marks, goal });
    if (Buffer.isBuffer(buffer) && buffer.length) {
      counters.tokensEstimate += estimateTokens(width, height, prompt);
    }
    counters.calls += 1;

    let raw;
    try {
      raw = await callModel({
        image: Buffer.isBuffer(buffer) ? buffer.toString('base64') : '',
        prompt,
        system: SYSTEM_PROMPT,
        schema: OUTPUT_SCHEMA,
        size: [width, height],
        marks,
        goal,
        mode: marks.length ? 'som' : 'point',
      });
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'vision-failed', message: (error && error.message) || '模型调用失败', sha };
    }

    const result = (() => {
      try {
        return interpret(parseModelOutput(raw), { marks, width, height, goal });
      } catch (error) {
        // 模型输出不合法：结构化返回，不让一次接地失败把上层（桌面会话）带崩。
        return { ok: false, code: (error && error.code) || 'bad-grounding', message: (error && error.message) || '接地输出不合法' };
      }
    })();
    if (result.ok) {
      counters.hits += 1;
      cache.set(cacheKey, { at, result });
    }
    return { ...result, sha, cached: false };
  }

  function interpret(output, { marks, width, height, goal }) {
    const action = String(output.action || '').toLowerCase();
    const confidence = num(output.confidence, 1);
    const lowConfidence = confidence < minConfidence;

    if (action === 'cannot_locate') {
      const reason = String(output.reason || '').slice(0, MAX_REASON);
      return { ok: false, code: 'cannot-locate', reason, confidence, goal, lowConfidence };
    }

    if (action === 'zoom') {
      // §8.6：模型可以说“大概在这个区域”，上层按原分辨率再抓一次
      const region = Array.isArray(output.region) ? output.region.map((value) => Math.round(num(value))) : null;
      if (!region || region.length !== 4 || region[2] <= 0 || region[3] <= 0) {
        throw coded('bad-grounding', 'zoom 需要 region:[x,y,w,h]');
      }
      if (width > 0 && height > 0) {
        const [x, y, w, h] = region;
        if (x < 0 || y < 0 || x + w > width + 1 || y + h > height + 1) {
          throw coded('bad-grounding', 'zoom region 超出图像范围');
        }
      }
      return { ok: true, action: 'zoom', region, confidence, lowConfidence, goal };
    }

    if (action !== 'click') throw coded('bad-grounding', `未知 action: ${action || '(空)'}`);

    // 1) mark 优先：直接用候选框中心，省一次真实点击（也是 SoM 的价值）
    if (output.mark !== undefined && output.mark !== null) {
      const wanted = Math.round(num(output.mark, NaN));
      const mark = marks.find((item) => Math.round(num(item.id, -1)) === wanted);
      if (!mark) throw coded('bad-grounding', `未知 mark: ${output.mark}`);
      const box = boxOf(mark);
      if (!box) throw coded('bad-grounding', `mark ${wanted} 没有可用矩形`);
      if (!(box.w > 0) || !(box.h > 0)) throw coded('bad-grounding', `mark ${wanted} 的矩形宽高必须大于 0`);
      const point = [Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2)];
      if (width > 0 && height > 0 && (point[0] < 0 || point[1] < 0 || point[0] > width || point[1] > height)) {
        throw coded('point-out-of-bounds', `mark ${wanted} 的中心 ${point[0]},${point[1]} 超出图像 ${width}x${height}`);
      }
      return {
        ok: true,
        action: 'click',
        mark: wanted,
        markInfo: { role: mark.role || '', name: mark.name || '' },
        box,
        point,
        confidence,
        lowConfidence,
        goal,
      };
    }

    // 2) 纯坐标
    if (Array.isArray(output.point) && output.point.length === 2) {
      const x = Number(output.point[0]);
      const y = Number(output.point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw coded('bad-grounding', 'point 不是数字');
      // 截图尺寸必须已知且大于 0，否则“坐标在截图范围内”无从校验。
      if (!(width > 0) || !(height > 0)) throw coded('bad-image-size', `截图尺寸无效: ${width}x${height}`);
      if (x < 0 || y < 0 || x > width || y > height) {
        throw coded('point-out-of-bounds', `point ${x},${y} 超出图像 ${width}x${height}`);
      }
      return { ok: true, action: 'click', point: [Math.round(x), Math.round(y)], confidence, lowConfidence, goal };
    }

    throw coded('bad-grounding', 'click 需要 mark 或 point');
  }

  function stats() {
    // 有 settings 时预算以设置为准（与 gate 里 policy.visionAllowed 的口径一致）。
    const effectiveBudget = readSettings
      ? num((readSettings() || {})?.budget?.maxVisionFrames, DEFAULT_BUDGET_FRAMES)
      : maxFrames;
    return {
      calls: counters.calls,
      hits: counters.hits,
      cacheHits: counters.cacheHits,
      tokensEstimate: counters.tokensEstimate,
      budgetFrames: effectiveBudget,
      cacheMs: ttl,
      cached: cache.size,
    };
  }

  function reset() {
    counters.calls = 0;
    counters.hits = 0;
    counters.cacheHits = 0;
    counters.tokensEstimate = 0;
    cache.clear();
  }

  return { locate, reset, stats, schema: OUTPUT_SCHEMA };
}

module.exports = {
  createGrounder,
  buildPrompt,
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  DEFAULT_CACHE_MS,
  DEFAULT_BUDGET_FRAMES,
  DEFAULT_MIN_CONFIDENCE,
};
