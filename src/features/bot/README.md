# Bot 前端（src/features/bot）

> 结论：Bot 的**视图**在这里，Bot 的**数据**暂时也在这里（演示数据），主进程运行时位置见 [`electron/bots/README.md`](../../../electron/bots/README.md)。
> 目录布局与规范见 [`docs/conventions.md`](../../../docs/conventions.md) §1、§2；产品方案见 [`docs/plans/Mova-Bot开发与调研方案.md`](../../../docs/plans/Mova-Bot开发与调研方案.md)。

## 目录里有什么

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `bot-directory.js` | 演示数据与内存集合：`bots` 种子、`MODELS` / `EFFORTS` / `TOOLS` / `USAGE_DAYS`、`createBot` / `deleteBot` / `findBot` / `findBotByName` / `deletionImpact` | 持久化、身份服务、权限；这些将来归 `electron/bots/` |
| `bot-conversation.jsx` | `BotList`（Bot 通讯录列表）与 `BotConversation`（单聊/群聊气泡、发送者身份、`BallAvatar` 群头像） | 会话编排与模型调用（在 `app.js` 与主进程） |
| `bot-builder.jsx` | 新建 Bot 的对话框内容（名字、外观、模型/effort、工具开关） | 落盘与校验规则 |
| `forum.jsx` | MovaCommunity 视图（帖子流、站内搜索、收藏） | 真实网络请求；现在是纯前端演示 |

相邻目录：`src/features/botchat/`（对话信息浮层、群聊编辑、位置选择）、`src/features/contacts/`（通讯录主页，复用 `BallAvatar` 与 `bot-directory.js` 的模型/工具清单）。

## 与 app.js 的桥接方式

- `app.js` 是渲染层主控（根目录，活源码，不是构建产物），由 `src/app/main.tsx` `import '../../app.js'` 引入。
- 这些模块**不自己管状态**：`app.js` 持有 `bots` 集合与当前会话，把 props / 回调传进来；组件只负责渲染与本地临时状态（例如对话框里的草稿）。
- 渲染入口一律经 `app.js` 的静态 import 完成（`./src/features/bot/...`），不要在组件里用动态 `import()` 绕开打包；构建是单文件 IIFE，动态分包不可用。
- 需要主进程能力时只能走 `window.movaDesktop`（见 `src/app/desktop.d.ts` 与 `electron/preload.cjs`），不要新增全局。

## 迁移待办（写给下一次动这里的人）

- `bot-directory.js` 是演示数据，真实身份/持久化落地后它应退化成「读 IPC 的视图模型」；不要在这个文件里继续堆业务逻辑。
- 群成员目前按**名字**匹配，是已知债务：真实实现必须有稳定 ID（见 `docs/plans/Mova-Bot开发与调研方案.md`）。
