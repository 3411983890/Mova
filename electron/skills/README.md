# 本地能力技能包（electron/skills）

> 结论：这里是**本地能力的单一事实源**——一个能力 = 一个技能包（pack），由 manifest 声明、由 handlers 实现，再由适配器分别暴露给模型和 MCP。
> 本 README 只做占位与指路，**不重复规范**：目录布局、命名、头注释、模块边界、安全底线全部以 [`docs/conventions.md`](../../docs/conventions.md)（§1 目录布局、§2 文件级规范、§3 安全底线）为准。
> 架构论证与取舍见 [`docs/plans/Mova本地能力技能化与MCP暴露方案.md`](../../docs/plans/Mova本地能力技能化与MCP暴露方案.md)。

## 怎么加一个新能力

1. 新建 `packs/<kebab-id>/`，里面两个文件：`manifest.mjs`（声明：id、标题、参数 schema、能力位/权限要求、是否需要审批）与 `handlers.mjs`（实现）。
2. 纯逻辑（校验、归一化、打分、事件映射）单独成模块且**不 import electron**，这样测试能直接跑。
3. 需要宿主能力时从入口拿到注入实例（`sender`、`browser`、`designRuntime`、`approvals`…），不要自己 `require('electron')`。
4. 写文件类能力要在事件里带 `diff`，让前端能预览；超长文本按 `MAX_TEXT_CHARS = 8192` 截断并说明已截断。
5. 新能力必须同时给出三条测试路径：正常、拒绝（权限/审批）、畸形或超长输入。

## 不要做的事

- 不新增 npm 依赖（硬约束）。
- 不在 `.mjs` 里 `require('../x.cjs')`（只能由 `.cjs` 发起 require）。
- 不把同一件事实现两遍：先查是不是已经有 pack 或 `electron/agent-tools.cjs` 里的工具能做。
- 不在 `handlers.mjs` 里直接 `console.log`：主进程用 `getLogger(scope)`（`electron/logging/index.mjs`）。
