# MovaBot 服务端运行时（预留）

> 结论：**这个目录现在是空的，是故意留的。** 它只承载一件事——把 Bot 从「渲染层的一堆演示数据」变成主进程里可运行的实体。
> 目录布局与命名规则见 [`docs/conventions.md`](../../docs/conventions.md) §1；产品与架构论证见 [`docs/plans/Mova-Bot开发与调研方案.md`](../../docs/plans/Mova-Bot开发与调研方案.md)。

## 将来放什么

| 关注点 | 计划内容 | 现在在哪 |
| --- | --- | --- |
| Bot 定义解析 | Bot 档案（名字、头像/外观、模型与 effort、能力位、人格指令）的读取、校验与版本 | 渲染层 `src/features/bot/bot-directory.js` 的内存数组（演示数据） |
| 会话编排 | 单聊/群聊的成员解析、发言顺序、上下文拼装、流式事件分发 | 渲染层 `src/features/bot/bot-conversation.jsx` + `app.js` 里的会话状态 |
| 能力挂载 | 一个 Bot 能调哪些本地能力（技能包 / MCP / 浏览器 / 桌面），以及权限与审批入口 | `electron/skills/`（技能包）与 `electron/permissions.cjs`（权限位），Bot 侧尚无绑定 |
| 身份与状态 | 稳定 ID（不能再用名字当身份）、在线/忙碌状态、跨会话记忆作用域 | 无（`bot-directory.js` 只有内存内自增） |

## 硬约束（先把边界写死，免得以后返工）

- 纯逻辑（解析、校验、排序、事件映射）写成不 import electron 的模块，才能被 `node --test` 直接跑：见 `docs/conventions.md` §2.3。
- 所有宿主能力（窗口、审批、权限、浏览器、桌面）一律依赖注入，不在模块顶层 `require('electron')`。
- 需要落盘的 Bot 定义走 `electron/db/` 与 `electron/services/`，不要自己开一套存储。
- 写操作必须过审批与路径白名单，口径与 `electron/agent-tools.cjs` 一致：见 `docs/conventions.md` §3「安全底线」。

## 与渲染层的关系

渲染层只通过 IPC 读写 Bot 状态（preload 暴露的 `window.movaDesktop` 命名空间），**不要**让主进程直接碰 DOM，也不要在渲染层里实现第二份 Bot 身份逻辑。
