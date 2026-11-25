/**
 * 负责：`goal-plan` 技能包的纯数据声明——目标/计划/提问/审批请求 6 个工具的名字、MCP 名、
 *   别名、风险分级与 JSON Schema；零 IO、零宿主 import。
 * 不负责：状态机语义（electron/goal-state.mjs 的 createGoalState）、用户回答的传输
 *   （electron/ask.cjs 的 createAskBroker）、审批弹条（electron/approvals.cjs）。
 * 被谁调用：electron/skills/packs/index.mjs（DEFAULT_PACKS）、electron/skills/registry.mjs、
 *   tests/skills-packs.test.mjs。
 *
 * 为什么 `dependencies` 是空数组：本包的状态从 `deps.aim` 继承，而 `request.aim` 在
 * **首轮/新会话里就是 null**（app.js 的 goalSnapshot 在没有目标时返回 null）。registry 的
 * dependencies 是全有全无语义（缺一个键整包被裁），把 aim 写进去会让「首轮没有目标」直接
 * 等于「模型拿不到 set_goal / ask_user」。因此 aim / asks / sender / approvals 都按可选键处理：
 * 缺哪个，createHandlers 就不暴露依赖它的那一个工具（见 handlers.mjs）。
 */

const NO_APPROVAL = Object.freeze({ mode: 'none' });

export const manifest = Object.freeze({
  apiVersion: 1,
  id: 'goal-plan',
  version: '1.0.0',
  title: '目标、计划与提问',
  summary: '维护会话目标卡与计划卡、向用户提问、以及请用户对某个动作做人工确认。',
  capabilities: ['goal.read', 'goal.write', 'plan.write', 'user.ask', 'user.approve'],
  dependencies: [],
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
      name: 'set_goal',
      mcpName: 'mova_set_goal',
      aliases: [],
      label: '设置目标',
      mcpSummary: '创建或替换本会话唯一的目标卡；新目标需要 accept_goal 才算被接受。',
      description: 'Create or replace the single goal of this conversation. Use it when the user asks for an '
        + 'outcome that takes several steps. A new goal is not accepted yet: call accept_goal to take it on. '
        + 'Update the existing goal instead of opening a second one — there is only ever one.',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'core' },
      timeoutMs: 10_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120, description: '一句话目标（建议 ≤60 字）' },
          detail: { type: 'string', maxLength: 400, description: '范围或验收标准，一两句话' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      examples: [
        { title: '设置一个多步目标', arguments: { title: '把技能包接入两条链路', detail: '先包装核心工具，再补测试' } },
      ],
    },
    {
      name: 'set_plan',
      mcpName: 'mova_set_plan',
      aliases: ['mova_update_plan'],
      label: '更新计划',
      mcpSummary: '整表替换计划卡的步骤（1–12 条），旧名 mova_update_plan 仍然可用。',
      description: 'Write the ordered step list for the current goal and keep it current while working. Send the '
        + 'complete list every time (it replaces the old one). Exactly one step may be "active"; mark steps "done" '
        + 'as soon as they are actually finished. Sending the same list again is treated as no progress.',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'core' },
      timeoutMs: 10_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            description: '完整的有序步骤列表（整表替换）',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 120, description: '一步的具体动作' },
                status: { type: 'string', enum: ['pending', 'active', 'done'], description: '步骤状态，省略按 pending' },
                meta: { type: 'string', maxLength: 120, description: '可选的一行备注' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      examples: [
        {
          title: '三步计划，第二步进行中',
          arguments: {
            steps: [
              { label: '读现有实现', status: 'done' },
              { label: '写 pack', status: 'active' },
              { label: '补测试', status: 'pending' },
            ],
          },
        },
      ],
    },
    {
      name: 'accept_goal',
      mcpName: 'mova_accept_goal',
      aliases: [],
      label: '接受目标',
      mcpSummary: '确认接受当前目标；接受后在目标仍 active 时由应用自动推进下一轮。',
      description: 'Accept the current goal for this conversation: confirm you are taking responsibility for '
        + 'finishing it. After each reply the app starts the next round by itself while the goal is accepted and '
        + 'active, so never ask the user to say "continue".',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 10_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', maxLength: 200, description: '下一步要做什么，一句话' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '接受并按计划推进', arguments: { note: '先写 project-fs 的 handlers' } },
      ],
    },
    {
      name: 'update_goal',
      mcpName: 'mova_update_goal',
      aliases: [],
      label: '更新目标状态',
      mcpSummary: '改目标状态（active/paused/done/blocked）；done 与 blocked 会停掉自动推进。',
      description: 'Change the current goal status. "done" stops automatic continuation — use it only after the '
        + 'work is finished and verified. "blocked" also stops it: use it with a short summary when you cannot '
        + 'proceed (missing permission, missing input, external blocker) instead of repeating attempts.',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 10_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'paused', 'done', 'blocked'], description: '新的目标状态' },
          summary: { type: 'string', maxLength: 300, description: '为什么暂停/受阻，或完成时的核验结果' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      examples: [
        { title: '标记目标完成', arguments: { status: 'done', summary: '5 个 pack 全部通过 node --test' } },
      ],
    },
    {
      name: 'ask_user',
      mcpName: 'mova_ask_user',
      aliases: [],
      label: '向用户提问',
      mcpSummary: '问用户一个短问题并等待回答，可带最多 4 个选项（每个 ≤60 字符）。',
      description: 'Ask the user one short question when a decision is missing, then wait for the answer. Limits: '
        + 'question at most 400 characters, at most 4 options, each option at most 60 characters. Ask the question '
        + 'itself, not a paragraph.',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'core' },
      timeoutMs: 120_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 400, description: '问题正文（≤400 字符）' },
          options: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string', maxLength: 60 },
            description: '可选项（字符串形式）；省略表示自由回答',
          },
          choices: {
            type: 'array',
            maxItems: 4,
            description: '可选项（对象形式，兼容旧 pi-ai 调用）：{label, value?, description?}',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 60, description: '选项展示名' },
                value: { type: 'string', maxLength: 60, description: '选项值，省略则等于 label' },
                description: { type: 'string', maxLength: 60, description: '一行补充说明' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          detail: { type: 'string', maxLength: 400, description: '可选的一句话上下文' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      examples: [
        { title: '让用户在两种方案里选', arguments: { question: '补丁应用失败时怎么处理？', options: ['整包失败', '跳过该 hunk'] } },
      ],
    },
    {
      name: 'request_approval',
      mcpName: 'mova_request_approval',
      aliases: [],
      label: '请求用户审批',
      mcpSummary: '就一个具体动作请用户人工确认；回答不授予文件/系统能力。',
      description: 'Ask for explicit approval of one proposed action. A positive answer does not grant file or system '
        + 'capabilities; the actual action must still pass its own permission checks.',
      risk: 'none',
      approval: NO_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 120_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', minLength: 1, maxLength: 300, description: '要审批的动作，一行说清' },
          detail: { type: 'string', minLength: 1, maxLength: 2_000, description: '影响范围、风险与回滚方式' },
        },
        required: ['action', 'detail'],
        additionalProperties: false,
      },
      examples: [
        { title: '请用户确认删除构建产物', arguments: { action: '删除 dist/ 后重新构建', detail: 'dist/ 是生成物，删掉不会丢源码；重新构建约 20 秒。' } },
      ],
    },
  ],
});
