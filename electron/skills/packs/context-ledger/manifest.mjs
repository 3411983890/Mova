/**
 * 负责：`context-ledger` 技能包的纯数据声明——上下文台账 3 个工具（用量查询 / 压缩 / 原文回查）
 *   的名字、MCP 名、风险分级与 JSON Schema；零 IO、零宿主 import。
 * 不负责：台账口径与压缩算法（electron/context/ledger.mjs / budget.mjs / summarize.mjs）、
 *   参数语义（electron/context/tools.mjs 的 createContextTools）。
 * 被谁调用：electron/skills/packs/index.mjs（DEFAULT_PACKS）、electron/skills/registry.mjs、
 *   tests/skills-packs.test.mjs。
 *
 * 三个工具全部 `exposure.mcp: 'on_demand'`：上下文是长任务里偶尔才问一次的能力，
 * 塞进 tools/list 只会白占 token。风险等级一律 read：它们只读台账 + 排一条「下次请求生效」的压缩项，
 * 不碰文件、不执行命令；真正的分级由 ledger 与 pending 决定。
 */

const READ_APPROVAL = Object.freeze({ mode: 'none' });
/** 单次回查上限：与 context/tools.mjs 的 MAX_READ_LIMIT 保持一致。 */
const MAX_READ_LIMIT = 6_000;

export const manifest = Object.freeze({
  apiVersion: 1,
  id: 'context-ledger',
  version: '1.0.0',
  title: '上下文台账',
  summary: '查看本会话的上下文用量、把旧消息压成摘要，并按字符范围回查被压缩的原文。',
  capabilities: ['context.read', 'context.compact'],
  dependencies: ['contextTools'],
  permissions: {
    fs: 'none',
    exec: false,
    net: false,
    desktop: false,
    browser: false,
    canvas: false,
    memory: 'none',
  },
  sessionPolicy: { allowTemporary: true, allowBrowserOnly: true },
  deprecation: null,
  tools: [
    {
      name: 'context_status',
      mcpName: 'mova_context_status',
      aliases: [],
      label: '上下文用量',
      mcpSummary: '报告本会话已用的 token、六层分层、还能压多少条旧消息、是否已有待生效的压缩。',
      description: 'Report how much of the context window this conversation already uses: total tokens, the six '
        + 'layers, how many older messages can still be compressed, and whether a compaction is already queued for '
        + 'the next request. These numbers are free to read, never guess them.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 10_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      examples: [
        { title: '查一下当前用量', arguments: {} },
      ],
    },
    {
      name: 'context_compact',
      mcpName: 'mova_context_compact',
      aliases: [],
      label: '压缩上下文',
      mcpSummary: '把旧消息压成一段摘要并排进队列（下一次请求生效），最新消息与目标永不被压。',
      description: 'Compress older turns of this conversation into one summary block so the window stops filling up. '
        + 'The newest turns, the current goal and the explicit user constraints are never compressed, and the '
        + 'original text stays readable with context_read. It costs one model call: do not call it while the '
        + 'conversation is still short.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 120_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          keepRecent: {
            type: 'integer',
            minimum: 4,
            maximum: 30,
            description: '保留最近多少条消息原文（4–30，默认 8）；最近几轮还很关键时调大',
          },
          reason: { type: 'string', maxLength: 200, description: '一句话说明为什么现在要压' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '留 10 条原文，压掉更早的', arguments: { keepRecent: 10, reason: '读了三个大文件，窗口快满了' } },
      ],
    },
    {
      name: 'context_read',
      mcpName: 'mova_context_read',
      aliases: [],
      label: '回查被压缩的原文',
      mcpSummary: '按 offset/limit 逐页读回被摘要取代的原文（单次最多 6000 字符），摘要不能当证据。',
      description: 'Read the original messages behind a compaction summary, verbatim and page by page (offset/limit, '
        + `up to ${MAX_READ_LIMIT} characters per call). A summary is a derived note, not evidence. The first line of `
        + 'the reply gives the range and nextOffset; pass nextOffset back as offset to continue.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 15_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0, description: '字符偏移，默认 0' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_READ_LIMIT,
            description: `最多返回多少字符（1–${MAX_READ_LIMIT}），默认 4000`,
          },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '从头读回 2000 字符', arguments: { offset: 0, limit: 2_000 } },
      ],
    },
  ],
});
