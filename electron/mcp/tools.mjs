/**
 * Mova 工具表（MCP 侧的单一事实源）。
 *
 * 负责：12 个核心工具的名字 / 两行内描述 / JSON Schema，按需发现（mova_tools_search），
 *   以及调用结果的归一（content 数组、超 8K 截断）与错误收敛。
 * 不负责：任何真正的 IO —— 每个工具的实现由 createToolTable({ handlers }) 注入，
 *   由接线层接到 agent-tools.cjs / 长期记忆 / 联网搜索 / 会话状态上；参数校验也在 handler 里。
 * 被谁调用：electron/mcp/server.mjs（tools/list、tools/call），以及 tests/mcp-tools.test.mjs。
 */

import { errorResult, messageOf, normalizeResult } from './normalize.mjs';

const PREFIX = 'mova_';
const SEARCH_LIMIT = 8;
const DISCOVER_LIMIT = 8;

const RISK = Object.freeze({ READ: 'read', WRITE: 'write', NONE: 'none' });

const DISCOVER_TOOL = 'mova_tools_search';

/**
 * 默认暴露给 CLI 的 12 个工具：多了会吃掉几万 token 并让模型乱选（文档 §11.3b）。
 * 12 = 11 个能力工具 + 发现入口 mova_tools_search（它没有对应 handler，必须默认给，
 * 否则模型拿不到「还有别的工具」这条路）。
 */
export const CORE_TOOL_NAMES = Object.freeze([
  'mova_read_file',
  'mova_list_files',
  'mova_write_file',
  'mova_apply_patch',
  'mova_web_search',
  'mova_web_read',
  'mova_memory_search',
  'mova_memory_write',
  'mova_ask_user',
  'mova_set_goal',
  'mova_update_plan',
  'mova_tools_search',
]);

// list() 的顺序就是模型看到的顺序，固定下来（稳定 = 提示缓存可复用）。
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** 目录顺序 = list() 顺序，不要为了好看重排。 */
const TOOL_DEFS = Object.freeze([
  {
    name: 'mova_read_file',
    core: true,
    risk: RISK.READ,
    description: '读取项目内文件，返回文本内容与行数。Read a text file inside the project folders.',
    inputSchema: schema({
      path: { type: 'string', minLength: 1, maxLength: 400, description: '相对项目根的路径，可带项目名前缀' },
    }, ['path']),
  },
  {
    name: 'mova_list_files',
    core: true,
    risk: RISK.READ,
    description: '列出项目文件夹里的文件与子目录。List files and folders inside the project folders.',
    inputSchema: schema({
      path: { type: 'string', maxLength: 400, description: '相对目录路径；省略表示所有项目根' },
      depth: { type: 'integer', minimum: 1, maximum: 3, description: '下探层数，默认 1' },
    }),
  },
  {
    name: 'mova_write_file',
    core: true,
    risk: RISK.WRITE,
    description: '写入或覆盖项目内文件，写前走审批与 diff 预览。Write or overwrite a file inside the project folders.',
    inputSchema: schema({
      path: { type: 'string', minLength: 1, maxLength: 400, description: '相对项目根的路径' },
      content: { type: 'string', description: '完整的新文件内容' },
    }, ['path', 'content']),
  },
  {
    name: 'mova_apply_patch',
    core: true,
    risk: RISK.WRITE,
    description: '对项目内文件应用文本补丁，写前走审批与 diff 预览。Apply a text patch to a file inside the project folders.',
    inputSchema: schema({
      path: { type: 'string', minLength: 1, maxLength: 400, description: '相对项目根的路径' },
      patch: { type: 'string', description: '统一 diff 格式的补丁文本' },
    }, ['path', 'patch']),
  },
  {
    name: 'mova_web_search',
    core: true,
    risk: RISK.READ,
    description: '联网搜索，返回标题、链接与摘要。Search the web and return titles, URLs and snippets.',
    inputSchema: schema({
      query: { type: 'string', minLength: 1, maxLength: 400, description: '搜索词' },
      maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '结果条数，默认 8' },
    }, ['query']),
  },
  {
    name: 'mova_web_read',
    core: true,
    risk: RISK.READ,
    description: '读取一个网页的正文（仅 http/https）。Read the main text of one web page.',
    inputSchema: schema({
      url: { type: 'string', minLength: 1, maxLength: 2_000, description: '要读取的网页地址' },
    }, ['url']),
  },
  {
    name: 'mova_memory_search',
    core: true,
    risk: RISK.READ,
    description: '在 Mova 长期记忆里检索相关条目。Search Mova long-term memory for relevant notes.',
    inputSchema: schema({
      query: { type: 'string', minLength: 1, maxLength: 400, description: '检索词' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '条数上限，默认 10' },
    }, ['query']),
  },
  {
    name: 'mova_memory_write',
    core: true,
    risk: RISK.WRITE,
    description: '把一条事实写入 Mova 长期记忆。Save one note into Mova long-term memory.',
    inputSchema: schema({
      text: { type: 'string', minLength: 1, maxLength: 4_000, description: '要记住的内容' },
      kind: { type: 'string', maxLength: 40, description: '记忆类型，如 preference / fact' },
    }, ['text']),
  },
  {
    name: 'mova_ask_user',
    core: true,
    risk: RISK.NONE,
    description: '向用户提问并等待回答，可带最多 4 个选项。Ask the user and wait for their answer.',
    inputSchema: schema({
      question: { type: 'string', minLength: 1, maxLength: 400, description: '问题正文' },
      options: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string', maxLength: 60 },
        description: '可选项；省略表示自由回答',
      },
    }, ['question']),
  },
  {
    name: 'mova_set_goal',
    core: true,
    risk: RISK.NONE,
    description: '设置本轮会话目标卡的内容。Set the session goal shown to the user.',
    inputSchema: schema({
      title: { type: 'string', minLength: 1, maxLength: 120, description: '一句话目标' },
      detail: { type: 'string', maxLength: 400, description: '补充说明' },
    }, ['title']),
  },
  {
    name: 'mova_update_plan',
    core: true,
    risk: RISK.NONE,
    description: '整表替换会话计划卡的步骤。Replace the session plan steps.',
    inputSchema: schema({
      steps: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 120, description: '步骤描述' },
            status: { type: 'string', enum: ['pending', 'active', 'done'], description: '步骤状态' },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
    }, ['steps']),
  },
  {
    name: DISCOVER_TOOL,
    core: true,
    risk: RISK.NONE,
    description: '发现未默认暴露的 Mova 工具并查回参数 schema。Discover Mova tools that are not exposed by default.',
    inputSchema: schema({
      query: { type: 'string', maxLength: 200, description: '按能力描述搜索，如「浏览器」「git」' },
    }, ['query']),
  },
]);

const BY_NAME = new Map(TOOL_DEFS.map(tool => [tool.name, tool]));

function descriptor(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** 允许注入时省略前缀（'read_file'）也允许写全（'mova_read_file'），拼错则原样带回用于报错。 */
function normalizeName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.startsWith(PREFIX) ? raw : `${PREFIX}${raw}`;
}

/* 结果归一（截断 / error 形状）已抽到 ./normalize.mjs：技能包适配器要复用同一套语义。 */

/** 名称命中权重高于描述：模型多半按「名字里有没有那个词」判断。 */
function scoreOf(tool, terms) {
  const name = tool.name.toLowerCase();
  const spaced = name.replace(/_/g, ' ');
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 6;
    else if (spaced.includes(term)) score += 5;
    if (description.includes(term)) score += 3;
    else if (term.length > 1) {
      // 「文件读取」这类整词不在描述里时按字符命中给 1 分，避免中文多字查询全空。
      let hits = 0;
      for (const ch of term) if (description.includes(ch) || name.includes(ch)) hits += 1;
      if (hits) score += 1;
    }
  }
  return score;
}

function rank(query, pool) {
  const text = typeof query === 'string' ? query.trim() : '';
  // 空查询给「目录前 8 个」：既是 tools/list 的稳定前缀，也让模型不带 query 时也有东西可选。
  if (!text) return pool.slice(0, SEARCH_LIMIT);
  const terms = text.toLowerCase().split(/[\s,，、/|]+/).filter(Boolean);
  const scored = pool
    .map((tool, index) => ({ tool, index, score: scoreOf(tool, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, SEARCH_LIMIT).map(item => item.tool);
}

/**
 * handlers: { [name]: (args, ctx) => Promise<result> }，name 可省 mova_ 前缀。
 * 只按 handlers 决定「可用」：实现了才进 list()，避免把一个必定报错的工具暴露给模型。
 */
export function createToolTable({ handlers } = {}) {
  const impl = new Map();
  for (const [key, fn] of Object.entries(handlers ?? {})) {
    if (typeof fn !== 'function') continue;
    const name = normalizeName(key);
    // 未知名字直接忽略：注入侧拼错一个名字不该让整张表起不来。
    if (BY_NAME.has(name)) impl.set(name, fn);
  }

  const isAvailable = tool => tool.name === DISCOVER_TOOL || impl.has(tool.name);
  const availableTools = () => TOOL_DEFS.filter(isAvailable);

  /** 未默认暴露但已实现的工具（留给浏览器 / 桌面 / 项目等分组接入；当前构建为空）。 */
  const hiddenTools = () => availableTools().filter(tool => tool.name !== DISCOVER_TOOL && !CORE_TOOL_NAMES.includes(tool.name));

  function discover(input) {
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    const pool = availableTools().filter(tool => tool.name !== DISCOVER_TOOL);
    const hidden = hiddenTools();
    const picked = query ? rank(query, pool) : hidden.slice(0, DISCOVER_LIMIT);
    return {
      query,
      hidden: hidden.map(tool => tool.name),
      matches: picked.slice(0, DISCOVER_LIMIT).map(tool => ({
        ...descriptor(tool),
        exposed: CORE_TOOL_NAMES.includes(tool.name),
      })),
      ...(hidden.length ? {} : { note: '本构建没有额外工具：12 个核心工具已全部默认暴露，matches 仅用于查回参数 schema。' }),
    };
  }

  return {
    list() {
      return availableTools().map(descriptor);
    },

    search(query) {
      return rank(query, availableTools().filter(tool => tool.name !== DISCOVER_TOOL)).map(descriptor);
    },

    has(name) {
      const tool = BY_NAME.get(normalizeName(name));
      return Boolean(tool && isAvailable(tool));
    },

    /** 永不抛：MCP 里抛异常会中断会话，而模型自己换路通常更快。 */
    async call(name, args, ctx) {
      const wanted = normalizeName(name);
      const tool = BY_NAME.get(wanted);
      if (!tool || !isAvailable(tool)) {
        return errorResult('unknown_tool', `未知或未启用的工具：${wanted || String(name)}；可用工具见 tools/list。`);
      }
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      try {
        const raw = tool.name === DISCOVER_TOOL ? discover(input) : await impl.get(tool.name)(input, ctx ?? {});
        return normalizeResult(raw);
      } catch (error) {
        return errorResult('tool_failed', `${tool.name} 执行失败：${messageOf(error)}`);
      }
    },
  };
}

/** 供文档 / 设置页 / 诊断包用：一份不带实现的完整目录（含风险等级与是否默认暴露）。 */
export function describeAll() {
  return TOOL_DEFS.map(({ name, description, risk, inputSchema, core }) => ({
    name, description, risk, core, inputSchema,
  }));
}
