# 技能包（Skill Pack）作者契约

一个 pack 就是一个目录 `electron/skills/packs/<kebab-id>/`，**必须**导出两样东西：

1. `manifest` —— `Object.freeze` 的纯数据（零 IO、零函数、零 import 宿主模块）。字段规范见
   `electron/skills/manifest-schema.mjs`（`SKILL_API_VERSION = 1`）与
   `docs/plans/Mova本地能力技能化与MCP暴露方案.md` §2.2。
2. `createHandlers(deps)` —— 纯依赖注入，返回 `{ [toolName]: (args, ctx) => Promise<result> }`。
   `deps` 的键是 manifest 里 `dependencies` 声明的那些（缺任何一个，整个 pack 会被 registry 跳过）。

## 最小可跑示例（20 行以内）

```js
// electron/skills/packs/demo-echo/handlers.mjs
export const manifest = Object.freeze({
  apiVersion: 1, id: 'demo-echo', version: '1.0.0', title: '回声示例',
  summary: '把传入的文本原样返回，用来验证技能包接线。',
  capabilities: ['demo.echo'], dependencies: [], permissions: {
    fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none',
  },
  deprecation: null,
  tools: [{
    name: 'demo_echo', label: '回声', description: 'Echo the given text back.',
    mcpSummary: '原样返回 text 参数。', risk: 'none', approval: { mode: 'none' },
    exposure: { piAi: true, mcp: 'on_demand' },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    examples: [{ title: '回声', arguments: { text: 'hi' } }],
  }],
});
export const createHandlers = () => ({ demo_echo: async ({ text }) => ({ content: [{ type: 'text', text }] }) });
```

## 三条硬规则

1. **manifest 零 IO**：不读文件、不读环境变量、不调 `Date.now()` 生成版本号。它是可被冻结、
   可被序列化、可被 `node --test` 直接断言的数据。需要运行时信息就写进 `dependencies`。
2. **handlers 不做 manifest 校验**：字段合法性统一由 `manifest-schema.mjs` 在注册时校验一次；
   handler 里只校验**用户输入**（参数类型、长度、枚举）并给默认值——这是唯一需要在每次调用时做的事。
3. **新技能包默认 `exposure.mcp: 'on_demand'`**：只有确定「模型每轮都该看见」的少数核心工具才写
   `'core'`（`tools/list` 直出，吃 token）；其余靠 `mova_skill_search` + `mova_skill_call` 两步发现。
   `exposure.piAi: true` 表示同时进进程内 agent 的工具列表。

## 返回值与 ctx

- 返回 `{ content: [{ type: 'text', text }] }`（也接受字符串 / 裸对象，`index.mjs` 会归一）。
  额外可选字段 `{ detail, diff, image }` 会被抽出来挂到前端的 `tool` 事件上：
  `diff` 供变更卡预览，`image: { id, name?, src? }` 供截图内联（**不要**自己发 `{type:'image'}` 事件，
  `app.js:3037` 会把它当成用户附件写进 `turn.imageIds`）。
- 拒绝/失败请抛带 `code` 的 Error：`code: 'denied' | 'approval_denied' | 'permission_denied'` 会让
  时间线显示「已拒绝」，其余 code 显示红色失败。
- `ctx = { callId, transport, signal, emit, chatImages, logger, progress(detail, progress), authorize(def, args) }`：
  `progress` 原地更新同一行（长任务别自己 push 新行）；`authorize` 是统一审批闸门，
  写操作**必须**在真正落盘前 `await ctx.authorize()`，并用它返回的 `allowed` 决定是否继续。

## 自检

```powershell
node --test tests/skills-manifest.test.mjs tests/skills-registry.test.mjs
```

新 pack 的 manifest 直接丢进 `validateManifest()` 就能看到 `{ path, message }` 级错误。
