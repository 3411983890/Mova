/**
 * 负责：把技能运行时投影成 electron/mcp/server.mjs 认的 `{ list, search, has, call }` 工具表——
 *   `tools/list` 只给核心集（`exposure.mcp === 'core'`）+ 可选的本轮置顶工具（`pinned`）+ 两个元工具，
 *   其余工具通过 `mova_skill_search` 发现、`mova_skill_call` 执行（两步元技能模式）。
 *   另外导出 `pickPinnedTools`（按场景挑最多 3 个工具/包，产出与 core 同形的描述符）。
 * 不负责：HTTP 传输与鉴权（mcp/server.mjs）、结果截断算法（mcp/normalize.mjs）、
 *   结果预算的取值规则（manifest-schema.mjs 的 resultBudgetOf：工具声明的 maxResultChars 优先，
 *   没声明才退到本适配器的 maxTextChars）、工具实现与事件（index.mjs）、pi-ai 通道（adapters/pi-ai.mjs）、
 *   「用户现在是不是在用浏览器/画板/桌面」的判定（那是调用方的事，见 skills/turn-runtime.mjs 的
 *   `pinnedSkillsFor`）。
 * 被谁调用：electron/skills/turn-runtime.mjs（装配出每轮的 toolTable）、
 *   tests/skills-adapters.test.mjs、tests/skills-pinning.test.mjs。
 *
 * 为什么不让全部工具直出 tools/list：50+ 工具会白烧几万输入 token 并让模型选错工具，
 * 而 CLI MCP 客户端未必支持运行中响应 tools/list_changed（方案 §3.2）。
 * 置顶（pinning）是有上限的例外：用户正在用右侧浏览器 / 设计画板 / 桌面操控时，
 * 该组最常用的几个工具直接进 tools/list，省掉「先 mova_skill_search 再调用」这一跳（方案 §3.1）。
 *
 * 三条边界纪律（改这个文件前先读）：
 * 1) `exposure.mcp === 'off'` 的工具在 MCP 边界**完全不可达**：list / search / has / call
 *    与 mova_skill_call 一律当它不存在。这类工具只给 pi-ai 进程内链路用。置顶同样不能破这条。
 * 2) `ctx` 由上层（server.mjs 传 `{ transport:'http' }`）决定：本层只补默认值，
 *    不覆盖已有 transport，并且必须把 `signal` 原样透传下去（长任务要能取消）。
 * 3) `tools/list` 的**总数硬上限 20**（见 MAX_LIST_TOOLS）：13 个既有条目 + 最多 7 个置顶。
 *    传进来的 `pinned` 再多也按顺序截断，绝不因为「用户同时开着浏览器和画板」把工具表撑爆。
 */

import { MAX_TEXT_CHARS, errorResult, normalizeResult } from '../../mcp/normalize.mjs';
import { resultBudgetOf } from '../manifest-schema.mjs';
import { searchSkills } from '../discover.mjs';

/** 发现入口的规范名；旧名 `mova_tools_search` 继续作为别名接受（历史 prompt / CLI 记忆）。 */
export const SKILL_SEARCH_TOOL = 'mova_skill_search';
export const SKILL_SEARCH_ALIAS = 'mova_tools_search';
/** 按需执行入口。 */
export const SKILL_CALL_TOOL = 'mova_skill_call';

const META_NAMES = new Set([SKILL_SEARCH_TOOL, SKILL_SEARCH_ALIAS, SKILL_CALL_TOOL]);

/**
 * `tools/list` 的硬上限：13 个既有条目（11 个 core 能力 + 2 个元工具）+ 7 个场景置顶 = 20。
 * 这个数字是「模型还看得过来」的经验上限，也是本轮实测的预算线：置顶是为了省一次搜索，
 * 不是为了把按需工具一次倒出来（那会退回改造前的 token 浪费）。
 */
export const MAX_LIST_TOOLS = 20;
/** 一轮最多置顶 7 个（= MAX_LIST_TOOLS - 13）；再多按优先级截断。 */
export const MAX_PINNED_TOOLS = 7;
/** 单个技能包最多置顶 3 个工具：真需要第 4 个时，mova_skill_search 一次就能拿到。 */
export const MAX_PINNED_PER_PACK = 3;

const SEARCH_DESCRIPTOR = Object.freeze({
  name: SKILL_SEARCH_TOOL,
  description: '发现未默认暴露的 Mova 技能工具，默认返回精简参数签名（必填带 *，可直接照签名调用）。Discover Mova skills not exposed by default; each result carries a compact signature.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 200, description: '按能力描述搜索，如「画板」「浏览器」' },
      skillId: { type: 'string', maxLength: 40, description: '技能包 id，如 design-canvas' },
      tool: { type: 'string', maxLength: 60, description: '工具名或别名，如 design_apply / mova_design_apply' },
      includeSchema: { type: 'boolean', description: '返回完整 inputSchema 与 examples（默认结果已带精简签名）' },
      includeExamples: { type: 'boolean', description: '同时返回调用示例（等价于 includeSchema）' },
      includeDeprecated: { type: 'boolean', description: '包含已弃用条目（默认过滤）' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数上限，默认 8' },
    },
    additionalProperties: false,
  },
});

const CALL_DESCRIPTOR = Object.freeze({
  name: SKILL_CALL_TOOL,
  description: '调用一个按需技能工具（参数见 mova_skill_search 返回的精简签名）。Call one on-demand Mova skill tool.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 60, description: '工具名或别名（如 design_apply）' },
      arguments: { type: 'object', additionalProperties: true, description: '该工具的参数，见 mova_skill_search 返回的签名或 schema' },
    },
    required: ['name'],
    additionalProperties: false,
  },
});

function describe(entry) {
  const def = entry.def;
  return {
    name: def.mcpName ?? `mova_${def.name}`,
    description: def.mcpSummary ?? def.description,
    inputSchema: def.inputSchema,
  };
}

/** 按 name / mcpName / 别名解析条目（runtime.resolve 优先，瘦 fake 里退化成扫一遍）。 */
function entryFor(entries, runtime, name) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted) return null;
  const resolved = typeof runtime?.resolve === 'function' ? runtime.resolve(wanted) : null;
  if (resolved) return resolved;
  return entries.find(row => row?.def?.name === wanted
    || row?.def?.mcpName === wanted
    || (Array.isArray(row?.def?.aliases) && row.def.aliases.includes(wanted))) ?? null;
}

function isMetaTool(name) {
  return typeof name === 'string' && META_NAMES.has(name.trim());
}

/** `exposure.mcp === 'off'` 判定：缺 exposure（畸形 manifest）按「不可达」处理，宁可少暴露。 */
function isMcpOff(entry) {
  return !entry || entry.def?.exposure?.mcp === 'off';
}

/**
 * 按场景挑本轮置顶的工具（方案 §3.1 的「按场景动态置顶」）。
 *
 * `pinnedPacks` 里每一项二选一：
 * - **技能包 id**（如 `browser-automation`）→ 取该包**声明顺序**的前 `MAX_PINNED_PER_PACK` 个工具；
 * - **工具名 / mcpName**（如 `desktop_screenshot`）→ 只置顶这一个（顺序就是调用方给的顺序）。
 * 认不出的项、以及 `exposure.mcp === 'off'` 的工具一律跳过——置顶不是绕过 exposure 的后门。
 * 结果按名字去重，总数硬截到 `MAX_PINNED_TOOLS`。
 *
 * 纯函数、只读 runtime：不判定「用户是不是正在用浏览器」，那是调用方的口径（见 turn-runtime）。
 * @param {{ listEntries?: Function, resolve?: Function }} runtime
 * @param {{ pinnedPacks?: string[] }} [options]
 * @returns {Array<{ name: string, description: string, inputSchema: object }>} 与 core 同形的描述符
 */
export function pickPinnedTools(runtime, { pinnedPacks = [] } = {}) {
  const entries = typeof runtime?.listEntries === 'function' ? runtime.listEntries() : [];
  const requested = Array.isArray(pinnedPacks) ? pinnedPacks : [];
  const picked = [];
  const seen = new Set();
  for (const item of requested) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (!key) continue;
    // 包 id 优先：一个包里的工具一起置顶才有意义（导航 + 读取 + 快照是一组动作）。
    // off 的条目先剔掉再取前 3 个，否则一个不可达的工具会占掉名额。
    const byPack = entries.filter(entry => entry?.pack?.id === key && !isMcpOff(entry));
    const candidates = byPack.length ? byPack.slice(0, MAX_PINNED_PER_PACK) : [entryFor(entries, runtime, key)];
    for (const entry of candidates) {
      if (isMcpOff(entry)) continue;
      const descriptor = describe(entry);
      if (seen.has(descriptor.name)) continue;
      seen.add(descriptor.name);
      picked.push(descriptor);
      if (picked.length >= MAX_PINNED_TOOLS) return picked;
    }
  }
  return picked;
}

/**
 * @param {{ listEntries: () => Array<{ def: object }>, resolve: Function, invoke: Function,
 *   search: Function }} runtime
 * @param {{ maxTextChars?: number, pinned?: Array<{ name: string }> }} [options]
 *   `maxTextChars` 只是**没声明预算的工具**的兜底上限；工具自己声明了 `maxResultChars` 时以声明为准
 *   （否则 browser_snapshot 的 24000 又被砍回 8192）。
 *   `pinned` 是本轮要直出的置顶工具（由 `pickPinnedTools` 产出，见 turn-runtime.mjs）：
 *   只认里面的 `name`，描述符一律用运行时里的真定义重算——外部传进来的字段不作数。
 *   不传 / 传空数组时 `list()` 与改造前**逐字一致**。
 * @returns {{
 *   list: () => Array<{ name: string, description: string, inputSchema: object }>,
 *   search: (query: string) => Array<{ name: string, description: string, inputSchema: object }>,
 *   has: (name: string) => boolean,
 *   call: (name: string, args?: object, ctx?: object) => Promise<object>,
 * }}
 */
export function toMcpToolTable(runtime, { maxTextChars = MAX_TEXT_CHARS, pinned = [] } = {}) {
  const limit = Number.isFinite(maxTextChars) && maxTextChars > 0 ? Math.floor(maxTextChars) : MAX_TEXT_CHARS;
  const entries = typeof runtime?.listEntries === 'function' ? runtime.listEntries() : [];

  /** 单个条目的结果预算：声明优先，未声明退到本适配器的全局上限（数字来自 manifest-schema）。 */
  function budgetFor(entry) {
    return resultBudgetOf(entry?.def, limit);
  }

  /** 只暴露「MCP 可见」的条目：off 的工具当作不存在。 */
  function visibleEntry(name) {
    const entry = entryFor(entries, runtime, name);
    return isMcpOff(entry) ? null : entry;
  }

  function visible(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter(match => visibleEntry(match?.name ?? match?.mcpName));
  }

  /** 检索统一走这里：把预算传给检索侧（由它降级，而不是让 normalizeResult 把 JSON 截半）。 */
  function runSearch(input) {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const payload = typeof runtime.search === 'function'
      ? runtime.search({ ...args, maxChars: limit })
      : searchSkills(runtime, { ...args, maxChars: limit });
    const matches = visible(payload?.matches);
    const dropped = Array.isArray(payload?.matches) ? payload.matches.length - matches.length : 0;
    const scoped = {
      ...payload,
      matches,
      ...(dropped > 0 ? { total: Math.max(0, (Number(payload?.total) || matches.length) - dropped) } : {}),
    };
    return normalizeResult(scoped, { maxTextChars: limit });
  }

  /** 上层 ctx 优先：server.mjs 传 transport:'http'，不能在适配层被改写成 'mcp'。 */
  function callContext(ctx) {
    const base = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
    return {
      ...base,
      transport: typeof base.transport === 'string' && base.transport ? base.transport : 'mcp',
      signal: base.signal,
    };
  }

  async function call(name, args, ctx = {}) {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (!wanted) return errorResult('unknown_tool', 'tools/call 需要工具名');
    if (wanted === SKILL_SEARCH_TOOL || wanted === SKILL_SEARCH_ALIAS) return runSearch(args);
    if (wanted === SKILL_CALL_TOOL) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const target = typeof input.name === 'string' ? input.name.trim() : '';
      if (!target) return errorResult('invalid_arguments', 'mova_skill_call 需要 name（先用 mova_skill_search 查）');
      // mova_skill_call 是唯一「按名字转发」的入口：off 的工具必须在这里就被挡住，
      // 否则它成了 MCP 边界上绕过 exposure 的后门。
      const entry = visibleEntry(target);
      if (!entry) {
        return errorResult('unknown_tool', `未知或未在 MCP 暴露的技能：${target}；可用清单见 ${SKILL_SEARCH_TOOL}。`);
      }
      const inner = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
        ? input.arguments
        : {};
      const result = await runtime.invoke(target, inner, callContext(ctx));
      // 与 pi-ai 适配器同一份预算：按目标工具声明取值，而不是全表一个数字。
      return normalizeResult(result, { maxTextChars: budgetFor(entry) });
    }
    const entry = visibleEntry(wanted);
    if (!entry) {
      return errorResult('unknown_tool', `未知或未在 MCP 暴露的技能：${wanted}；可用清单见 ${SKILL_SEARCH_TOOL}。`);
    }
    const result = await runtime.invoke(wanted, args ?? {}, callContext(ctx));
    return normalizeResult(result, { maxTextChars: budgetFor(entry) });
  }

  /**
   * 置顶行：只认 `pinned` 里的名字，描述符一律按运行时定义重算（off / 未知一律丢弃），
   * 再去重、按名额截断。名额同时受两条约束：**置顶 ≤ MAX_PINNED_TOOLS**、
   * **tools/list 总数 ≤ MAX_LIST_TOOLS**（core 少了也不许把置顶当补充池用）。
   */
  function pinnedRows(coreRows) {
    const used = new Set([...coreRows.map(row => row.name), ...META_NAMES]);
    const room = Math.max(0, Math.min(MAX_PINNED_TOOLS, MAX_LIST_TOOLS - coreRows.length - 2));
    const rows = [];
    for (const item of Array.isArray(pinned) ? pinned : []) {
      if (rows.length >= room) break;
      const entry = visibleEntry(item?.name);
      if (!entry) continue;
      const descriptor = describe(entry);
      if (used.has(descriptor.name)) continue;
      used.add(descriptor.name);
      rows.push(descriptor);
    }
    return rows;
  }

  return {
    list() {
      const coreRows = entries.filter(entry => entry?.def?.exposure?.mcp === 'core').map(describe);
      // 顺序纪律：core（逐字稳定，提示缓存可复用）→ pinned（随场景变化）→ 元工具。
      // pinned 追加在 core 之后、元工具之前，既不打断 core 的稳定前缀，也不会挡在发现入口前面。
      return [...coreRows, ...pinnedRows(coreRows), { ...SEARCH_DESCRIPTOR }, { ...CALL_DESCRIPTOR }];
    },

    /** 与 createToolTable().search 同形：{ name, description, inputSchema } 数组。 */
    search(query) {
      const args = typeof query === 'string' ? { query, includeSchema: true } : { ...(query ?? {}), includeSchema: true };
      const payload = typeof runtime.search === 'function'
        ? runtime.search({ ...args, maxChars: limit })
        : searchSkills(runtime, { ...args, maxChars: limit });
      return visible(payload?.matches).map(match => ({
        name: match.mcpName,
        description: match.summary,
        inputSchema: match.inputSchema,
      }));
    },

    has(name) {
      if (isMetaTool(name)) return true;
      return Boolean(visibleEntry(name));
    },

    call,
  };
}
