/**
 * 负责：`mova_skill_search` 的核心——技能包/工具的中英文打分检索、skillId/tool 精确定位、
 *   默认结果里的**精简参数签名**（`formatSignature`）、按需附带完整 inputSchema 与 examples、
 *   默认过滤已弃用条目，以及**按 JSON 字符预算自适应收敛**（结果必须能在 `maxChars` 内是合法 JSON）。
 * 不负责：执行工具（index.mjs 的 invoke）、MCP 传输与最终截断（adapters/mcp.mjs、mcp/normalize.mjs）、
 *   注册表构建与依赖裁剪（registry.mjs）。
 * 被谁调用：electron/skills/index.mjs（runtime.search）、electron/skills/adapters/mcp.mjs
 *   （mova_skill_search 工具），tests/skills-discover.test.mjs。
 *
 * 打分思路沿用 electron/mcp/tools.mjs 的 scoreOf（名字命中权重最高），
 * 但修掉了它的两个问题：空 query 明确返回「目录前 N 个」（N 可配），
 * 中文多字查询按单字命中计分（避免「画板」这类整词不在描述里就全空）。
 *
 * 为什么要有预算收敛：`includeSchema` 时一条结果就可能上千字符，把这些 JSON 交给
 * normalizeResult 按字符截断会产出**非法 JSON**（模型解析失败，还浪费一次调用）。
 * 所以由检索侧先缩：逐条把 schema 降级成「只给名字 + 提示再查一次」，再减少条数。
 *
 * 为什么默认结果要带签名（方案 §3.1 的 P0）：检索一次就是为了能直接调用。只给名字的话，
 * 模型还得再传 `includeSchema:true` 查一遍完整 JSON Schema——两跳、两次往返、两份 token。
 * 一行签名（必填带 `*`、enum 折叠、描述取首句）足够发起绝大多数调用；
 * 真要完整 schema 仍然可以 `includeSchema:true`，那条路径的输出格式一个字都没变。
 */

import { isDeprecated } from './registry.mjs';

/** 默认返回条数：与 mova_tools_search 的 8 保持一致，避免一次把上下文塞满。 */
export const DEFAULT_LIMIT = 8;
/** limit 的硬上限：再大就失去「按需发现」的意义。 */
export const MAX_LIMIT = 50;
/** 单条匹配的 description 上限：检索结果不是文档，长描述按需再用 includeSchema 取。 */
const SUMMARY_CHARS = 200;
/** 检索结果 JSON 的默认字符预算：与 mcp/normalize.mjs 的 MAX_TEXT_CHARS 对齐（8192）。 */
export const SEARCH_BUDGET_CHARS = 8_192;
/** 降级后每条只剩名字 + 提示时的固定文案（超预算时用）。 */
const LOOKUP_HINT = '结果超出上下文预算已省略 schema：请用 tool:"<名称>" 或 skillId 单独再查一次。';

/** 精简签名里最多列出的可选字段数：再多一行就装不下，模型也读不完。 */
const SIGNATURE_OPTIONAL_MAX = 6;
/** 签名里 description 的字符上限：检索结果不是文档，首句只用来「认得出来」。 */
const SIGNATURE_DESC_CHARS = 60;
/** 超过这个数量的 enum 直接折成 `enum(N)`：一行签名塞 7 个字面量就没人看了。 */
const SIGNATURE_ENUM_MAX = 4;
/** 允许出现在签名里的类型；其余写法（oneOf / anyOf / $ref）一律显示成 any。 */
const SIGNATURE_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);
/**
 * 签名降级的三个档位（预算不够时按顺序退）：
 * 0 = 必填 + 可选 + 描述，1 = 只留必填 + 描述，2 = 只留必填（无描述），3 = 只给名字（toStub）。
 */
const SIGNATURE_LEVEL = Object.freeze({ FULL: 0, REQUIRED_ONLY: 1, NO_DESCRIPTION: 2, STUB: 3 });

const WEIGHT_NAME = 6;
const WEIGHT_SPACED_NAME = 5;
const WEIGHT_SUMMARY = 3;
/** 中文单字命中上限：再高就会让「描述里凑巧有这几个字」压过真正的名字命中。 */
const MAX_CHAR_HITS = 3;
/** 只有中日韩文字才启用「按单字命中」兜底：英文按字母拆会把任何词都匹配上（tools.mjs 的老 bug）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** runtime（有 listEntries）或 registry（有 entries Map）或裸数组都接受。 */
function entriesOf(source) {
  if (!source) return [];
  if (typeof source.listEntries === 'function') {
    const rows = source.listEntries();
    return Array.isArray(rows) ? rows : [];
  }
  if (source.entries instanceof Map) return [...source.entries.values()];
  if (Array.isArray(source)) return source;
  return [];
}

function aliasOf(source, name) {
  if (source?.aliases instanceof Map) return source.aliases.get(name) ?? name;
  if (typeof source?.resolve === 'function') {
    const entry = source.resolve(name);
    return entry?.def?.name ?? name;
  }
  return name;
}

function haystack(entry) {
  const def = entry?.def ?? {};
  const pack = entry?.pack ?? {};
  const name = typeof def.name === 'string' ? def.name : '';
  const mcpName = typeof def.mcpName === 'string' ? def.mcpName : `mova_${name}`;
  const summary = typeof def.mcpSummary === 'string' && def.mcpSummary
    ? def.mcpSummary
    : (typeof pack.summary === 'string' ? pack.summary : '');
  const description = [def.description, def.label, pack.title, pack.summary]
    .filter(item => typeof item === 'string' && item)
    .join(' ');
  return {
    name: name.toLowerCase(),
    spaced: name.replace(/_/g, ' ').toLowerCase(),
    mcpName: mcpName.toLowerCase(),
    summary: summary.toLowerCase(),
    description: description.toLowerCase(),
  };
}

/** 名字命中 6 / 去下划线名字 5 / 摘要与描述 3 / 中文多字查询逐字命中 1（上限 3）。 */
function scoreOf(fields, terms) {
  let score = 0;
  for (const term of terms) {
    if (fields.name.includes(term) || fields.mcpName.includes(term)) score += WEIGHT_NAME;
    else if (fields.spaced.includes(term)) score += WEIGHT_SPACED_NAME;
    if (fields.summary.includes(term) || fields.description.includes(term)) score += WEIGHT_SUMMARY;
    else if (term.length > 1 && CJK.test(term)) {
      let hits = 0;
      for (const ch of term) {
        if (fields.name.includes(ch) || fields.summary.includes(ch) || fields.description.includes(ch)) hits += 1;
      }
      score += Math.min(hits, MAX_CHAR_HITS);
    }
  }
  return score;
}

function termsOf(query) {
  const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!text) return [];
  return text.split(/[\s,，、/|]+/).filter(Boolean);
}

function clampLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function clampBudget(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return SEARCH_BUDGET_CHARS;
  return Math.max(256, Math.floor(number));
}

function noteOf(deprecation) {
  if (!deprecation || deprecation.deprecated !== true) return '';
  const replacement = typeof deprecation.replacedBy === 'string' && deprecation.replacedBy
    ? `请改用 ${deprecation.replacedBy}`
    : '暂无替代工具';
  const since = typeof deprecation.since === 'string' && deprecation.since ? `（自 ${deprecation.since} 起）` : '';
  const removeIn = typeof deprecation.removeIn === 'string' && deprecation.removeIn ? `，将在 ${deprecation.removeIn} 移除` : '';
  return `该工具已弃用${since}：${replacement}${removeIn}`;
}

/** 一个属性在签名里的「值」：enum 折叠优先，其次类型；认不出的写法一律 any。 */
function signatureValue(property) {
  const values = Array.isArray(property?.enum) ? property.enum : [];
  if (values.length > SIGNATURE_ENUM_MAX) return `enum(${values.length})`;
  if (values.length) return values.map(item => JSON.stringify(item)).join('|');
  const type = typeof property?.type === 'string' ? property.type : '';
  if (SIGNATURE_TYPES.has(type)) return type;
  // 没写 type 但有 items / 有 enum 的写法很常见：按数组 / 字符串兜底，别直接写 any。
  if (Array.isArray(property?.enum)) return 'string';
  if (property?.items !== undefined) return 'array';
  return 'any';
}

/** mcpSummary 的首句（≤ SIGNATURE_DESC_CHARS），超长折出省略号。 */
function firstSentence(summary) {
  const line = typeof summary === 'string' ? summary.split('\n')[0].trim() : '';
  if (!line) return '';
  const match = /^[^。！？!?]*[。！？!?]/.exec(line);
  const sentence = (match ? match[0] : line).trim();
  if (sentence.length <= SIGNATURE_DESC_CHARS) return sentence;
  return `${sentence.slice(0, SIGNATURE_DESC_CHARS - 1).trimEnd()}…`;
}

/**
 * 一行精简参数签名：`mova_browser_navigate(url: string*, timeout?: integer, observe?: "auto"|"full"|"none") — 打开网页`。
 *
 * 规则（方案 §3.1 的 P0，改之前先看 tests/skills-signature.test.mjs）：
 * - 必填字段在前且带 `*`，可选字段按 schema 顺序、最多 `optional` 个（默认 6）；
 * - 类型只取 string/integer/number/boolean/array/object，其余显示 any；
 * - `enum` 折叠成 `"a"|"b"`，超过 4 个值折成 `enum(N)`；
 * - 描述取 `mcpSummary` 首句（≤60 字符），没有就不写 ` — `。
 *
 * 纯函数、零 IO：预算不足时的降级（丢可选字段 → 丢描述 → 只给名字）由 searchSkills 逐档调用它。
 * @param {{ name?: string, mcpName?: string, mcpSummary?: string, inputSchema?: object }} def
 * @param {{ optional?: number, description?: boolean }} [options]
 * @returns {string} 单个工具的一行签名（永远不含换行）
 */
export function formatSignature(def, { optional = SIGNATURE_OPTIONAL_MAX, description = true } = {}) {
  const schema = def?.inputSchema && typeof def.inputSchema === 'object' && !Array.isArray(def.inputSchema)
    ? def.inputSchema
    : {};
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter(key => typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key))
    : [];
  const name = typeof def?.mcpName === 'string' && def.mcpName
    ? def.mcpName
    : `mova_${typeof def?.name === 'string' ? def.name : ''}`;
  const parts = required.map(key => `${key}: ${signatureValue(properties[key])}*`);
  const room = Number.isFinite(optional) && optional > 0 ? Math.floor(optional) : 0;
  let used = 0;
  for (const key of Object.keys(properties)) {
    if (used >= room) break;
    if (required.includes(key)) continue;
    parts.push(`${key}?: ${signatureValue(properties[key])}`);
    used += 1;
  }
  const head = `${name}(${parts.join(', ')})`;
  const sentence = description ? firstSentence(def?.mcpSummary) : '';
  return sentence ? `${head} — ${sentence}` : head;
}

/** 按降级档位取签名；STUB 档返回 null（交给 toStub 只留名字）。 */
function signatureAt(def, level) {
  if (level >= SIGNATURE_LEVEL.STUB) return null;
  return formatSignature(def, {
    optional: level >= SIGNATURE_LEVEL.REQUIRED_ONLY ? 0 : SIGNATURE_OPTIONAL_MAX,
    description: level < SIGNATURE_LEVEL.NO_DESCRIPTION,
  });
}

/** tool 级弃用优先，其次看整包弃用——两者都要能给出迁移提示。 */
function deprecationOf(entry) {
  const toolLevel = entry?.def?.deprecation;
  if (toolLevel?.deprecated === true) return toolLevel;
  const packLevel = entry?.pack?.deprecation;
  if (packLevel?.deprecated === true) return packLevel;
  return null;
}

/** 一条匹配的最小形状；includeSchema 时再补齐调用所需的一切。 */
function toMatch(entry, { includeSchema = false } = {}) {
  const def = entry.def ?? {};
  const pack = entry.pack ?? {};
  const deprecation = deprecationOf(entry);
  const deprecated = Boolean(deprecation);
  const base = {
    name: def.name,
    mcpName: def.mcpName ?? `mova_${def.name}`,
    pack: pack.id,
    packTitle: pack.title,
    label: def.label,
    summary: typeof def.mcpSummary === 'string' ? def.mcpSummary.slice(0, SUMMARY_CHARS) : '',
    risk: def.risk,
    permissions: pack.permissions ?? null,
    deprecated,
    ...(deprecated ? { note: noteOf(deprecation) } : {}),
  };
  // 默认结果直接带一行签名：绝大多数调用照签名就能发，不必再花一跳查完整 schema。
  // `includeSchema` 那条路径刻意**不加**这个字段：它的输出格式保持原样（有完整 schema 就不需要签名）。
  if (!includeSchema) return { ...base, signature: formatSignature(def) };
  return {
    ...base,
    description: def.description,
    dependencies: Array.isArray(pack.dependencies) ? [...pack.dependencies] : [],
    timeoutMs: def.timeoutMs,
    supportsProgress: def.supportsProgress === true,
    imageOutput: def.imageOutput === true,
    inputSchema: def.inputSchema,
    examples: Array.isArray(def.examples) ? def.examples : [],
  };
}

/** 超预算时的降级形状：只留能再次定位的键 + 一句怎么继续查。 */
function toStub(match) {
  return {
    name: match.name,
    mcpName: match.mcpName,
    pack: match.pack,
    risk: match.risk,
    note: LOOKUP_HINT,
  };
}

function jsonChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * @param {object|object[]} registry buildSkillRuntime 的返回值或 buildRegistry 的结果
 * @param {{ query?: string, skillId?: string, tool?: string, includeSchema?: boolean,
 *   includeExamples?: boolean, includeDeprecated?: boolean, limit?: number, maxChars?: number }} [input]
 *   `maxChars` 是结果 JSON 的字符预算（适配器把 normalizeResult 的上限传进来）。
 * @returns {{ query: string, matches: object[], total: number, hiddenDeprecated: number,
 *   filtered: number, note: string }} 默认（非 includeSchema）时每条 match 带一行 `signature`；
 *   `includeSchema` 时带完整 inputSchema/examples，且**不带** signature（那条路径保持原样）。
 */
export function searchSkills(registry, input = {}) {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const limit = clampLimit(input.limit);
  const budget = clampBudget(input.maxChars === undefined ? SEARCH_BUDGET_CHARS : input.maxChars);
  const includeSchema = input.includeSchema === true || input.includeExamples === true
    || Boolean(input.skillId) || Boolean(input.tool);
  const all = entriesOf(registry);
  const available = input.includeDeprecated === true ? all : all.filter(entry => !isDeprecated(entry));
  const hiddenDeprecated = all.length - available.length;

  const pool = narrow(registry, available, input);
  const matched = query ? rank(query, pool) : pool;
  const filtered = all.length - pool.length;

  /**
   * 降级计数（两条路径共用）：
   * - `downgraded`：整条只剩名字（toStub）；
   * - `compacted`：签名被压缩（先丢可选字段、再丢描述）。
   */
  const state = { downgraded: 0, compacted: 0 };

  /** 组装最终 payload（note 依赖条数与降级情况，所以每次都要重算）。 */
  function render(rows) {
    const notes = [];
    if (!query && !input.skillId && !input.tool) {
      notes.push(`未提供 query：按目录顺序返回前 ${rows.length} 个技能工具；用 query / skillId / includeSchema 精确检索。`);
    }
    if (input.skillId && !pool.length) notes.push(`没有名为 ${input.skillId} 的可用技能包（可能缺依赖或已弃用）。`);
    if (input.tool && !pool.length) notes.push(`没有名为 ${input.tool} 的可用工具（可能缺 handler 或已弃用）。`);
    if (hiddenDeprecated > 0) {
      notes.push(`已过滤 ${hiddenDeprecated} 个已弃用条目；确需查看传 includeDeprecated:true，迁移请按弃用条目里的 replacedBy 改名。`);
    }
    if (matched.length > rows.length) notes.push(`共命中 ${matched.length} 条，只返回前 ${rows.length} 条。`);
    if (state.compacted > 0) {
      notes.push(`结果超出 ${budget} 字符预算：${state.compacted} 条参数签名已压缩（已省略可选字段与描述），确需完整参数用 tool:"<名称>" 再查一次。`);
    }
    if (state.downgraded > 0) {
      notes.push(`结果超出 ${budget} 字符预算：${state.downgraded} 条已降级为「只给名字」，请用 tool:"<名称>" 或 skillId 单独再查一次。`);
    }
    if (!rows.length && !notes.length) notes.push('没有匹配的技能工具：换个更短的关键词，或省略 query 看目录。');
    return {
      query,
      matches: rows,
      total: matched.length,
      hiddenDeprecated,
      filtered,
      note: notes.join(' '),
    };
  }

  function overBudget(rows) {
    return jsonChars(render(rows)) > budget;
  }

  /** 把第 index 条签名降到 level 档；`false` 表示这一条已经在这个档位（或该交给 toStub 了）。 */
  function degradeRow(rows, index, level) {
    const def = picked[index]?.def;
    if (!def) return false;
    const next = signatureAt(def, level);
    if (typeof next !== 'string' || next === rows[index].signature) return false;
    rows[index] = { ...rows[index], signature: next };
    return true;
  }

  /**
   * 默认结果的降级顺序（方案 §3.1：签名有预算，不能把检索结果整条吃掉）：
   * **先丢可选字段 → 再丢描述 → 最后才「只给名字」**，每一档都从尾部开始退
   * （排在前面的命中更可能是模型要的那一个）。`toStub` 与 includeSchema 分支共用同一套形状。
   */
  function relaxSignatures() {
    const working = rows.map(row => ({ ...row }));
    const compacted = new Set();
    const sync = () => { state.compacted = compacted.size; };
    for (let index = working.length - 1; index >= 0 && overBudget(working); index -= 1) {
      if (degradeRow(working, index, SIGNATURE_LEVEL.REQUIRED_ONLY)) compacted.add(index);
      sync();
    }
    for (let index = working.length - 1; index >= 0 && overBudget(working); index -= 1) {
      if (degradeRow(working, index, SIGNATURE_LEVEL.NO_DESCRIPTION)) compacted.add(index);
      sync();
    }
    for (let index = working.length - 1; index >= 0 && overBudget(working); index -= 1) {
      if (!Object.prototype.hasOwnProperty.call(working[index], 'signature')) continue;
      working[index] = toStub(working[index]);
      state.downgraded += 1;
    }
    while (working.length > 1 && overBudget(working)) working.pop();
    return working;
  }

  const picked = matched.slice(0, limit);
  let rows = picked.map(entry => toMatch(entry, { includeSchema }));

  if (includeSchema && overBudget(rows)) {
    // 1) 先逐条降级（从尾部开始：排在前面的命中更可能是模型要的那一个）。
    const working = rows.map(row => ({ ...row }));
    for (let index = working.length - 1; index >= 0; index -= 1) {
      if (working[index].inputSchema === undefined) continue;
      working[index] = toStub(working[index]);
      state.downgraded += 1;
      if (!overBudget(working)) break;
    }
    // 2) 还超就减少条数（保留最相关的前几条）。
    while (working.length > 1 && overBudget(working)) working.pop();
    rows = working;
  } else if (!includeSchema && overBudget(rows)) {
    rows = relaxSignatures();
  }

  const payload = render(rows);
  // 3) 兜底：单条 stubbed 结果仍超预算（畸形 schema）时只留名字清单，绝不让上层把 JSON 截半。
  if (jsonChars(payload) > budget && rows.length > 1) {
    const minimal = rows.slice(0, 1).map(toStub);
    state.downgraded += rows.length - 1;
    return render(minimal);
  }
  return payload;
}

/** skillId / tool 的精确定位；tool 接受别名（mova_x → x）。 */
function narrow(registry, pool, input) {
  if (input.skillId) {
    const id = String(input.skillId).trim();
    return pool.filter(entry => entry?.pack?.id === id);
  }
  if (input.tool) {
    const wanted = aliasOf(registry, String(input.tool).trim());
    return pool.filter(entry => entry?.def?.name === wanted);
  }
  return pool;
}

function rank(query, pool) {
  const terms = termsOf(query);
  if (!terms.length) return pool;
  return pool
    .map((entry, index) => ({ entry, index, score: scoreOf(haystack(entry), terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.entry);
}
