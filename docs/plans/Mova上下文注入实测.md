# Mova 新对话上下文注入实测（对比主流 Agent）

测量时间：2026-11-13 · 测量对象：本仓库当前代码（`electron/chat-agent.mjs`）
测量方式：用真实 `runChatAgent()` 跑一次「新对话第一条消息」，用假 `fetchModel` 截获发往 provider 的完整 JSON body。
脚本：`.test-temp/measure-context-v2.mjs`（`node .test-temp/measure-context-v2.mjs`）

## 一、注入点在哪

新对话首包的固定前缀由三块拼成，全部在 `electron/chat-agent.mjs`：

| 组成 | 位置 | 说明 |
| --- | --- | --- |
| 系统提示词 | `chat-agent.mjs:1176-1207` | 一个数组按条件 push 文案，最后 `join(' ')` |
| 工具定义 | `chat-agent.mjs:1003-1151` | goal / 项目 / 浏览器 / 桌面 / 提问 / 审批 / MCP / 搜索 / 记忆 |
| 项目规则 | `chat-agent.mjs:785` | 仅 CodeMova 模式，且 `slice(0, 4000)` 硬上限 |
| 历史 | `src/features/chat/context-budget.mjs:2` | 60,000 字符 / 100 条消息 / 旧消息摘要 4,000 字符 |

**没有**自动注入的东西（比同类工具省的地方）：
- 长期记忆不预注入，只提供 `memory_search` 工具，模型自己决定要不要查（`electron/services/memory-context-selection.cjs`）。
- MCP 不把每个 server 的工具 schema 塞进前缀，只给 `mcp_search` / `mcp_call` 两个入口（`chat-agent.mjs:1057-1085`）。
- 桌面 / 浏览器 / 设计工具按会话能力开关，不开就不占字符。

## 二、实测体积（字符数为精确值，token 为估算 ±15%）

| 场景 | 工具数 | 系统提示 | 工具定义 | 首包合计 | ≈ tokens |
| --- | --- | --- | --- | --- | --- |
| P0 极简（无搜索/记忆/MCP） | 4 | 1,910 | 3,038 | 5,163 | ≈ 1,500 |
| P1 日常（联网 + 记忆 + MCP + 提问/审批） | 14 | 3,904 | 10,554 | 14,673 | ≈ 4,400 |
| P2 P1 + 项目文件夹（读写执行）+ 项目规则 | 27 | 4,737 | 20,277 | 25,232 | ≈ 7,900 |
| P3 全家桶（再 + 桌面 11 + 浏览器 21 + 设计 3） | 55 | 6,124 | 43,188 | 49,537 | ≈ 15,900 |

单个工具平均体积：**785 字节/个**（P3）。作为参照，Claude Code 一份实测配置是 `69 tools · 154,946 tool bytes`，即 **2,245 字节/个**——Mova 的工具描述写得紧凑约 3 倍。

单工具最大的是 `run_command`（2,296 B）、`web_search`（1,686 B）、`browser_batch`（1,686 B）；goal 四件套合计 3,033 B。

## 三、对比主流 Agent（对方为 provider 实报 input tokens）

| 工具 | 新会话固定前缀 | 相对 Mova P1 |
| --- | --- | --- |
| Codex CLI 0.162（空目录，无 MCP） | 14,748 | 3.3× |
| Claude Code 2.1.295（空目录，无 MCP） | 35,776 | 8.1× |
| Claude Code + 30 个 MCP 工具 | 36,167（仅 +391） | — |
| **Mova P1 日常** | **≈ 4,400** | 1× |
| **Mova P3 全家桶（55 工具）** | **≈ 15,900** | 3.6× |

数据来源：<https://tokensave.app/data/claude-code-vs-codex-tokens>（CC BY 4.0，2026-10-18/22 实测）；工具字节数来自 <https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt>。

Cursor 没有公开绝对值，但其 2026-09 官方博客口径是「系统提示裁掉约 66%、内置工具静态描述减 60%、MCP 动态化后省 46.9%」——方向和 Mova 的「薄前缀 + 按需检索」一致：<https://cursor.com/blog/improved-token-efficiency>。

## 四、结论

1. **偏少，而且是数量级上的少。** 日常新对话 ≈4.4k tokens，是 Claude Code 的 1/8、Codex 的 1/3。
2. **最重的配置（55 个工具全开）≈15.9k，也只和 Codex 的裸启动持平**，仍不到 Claude Code 的一半；而这种配置要求同时开桌面操作、侧边浏览器、设计画布、项目文件夹，属于少数场景。
3. **加 MCP server 几乎不涨前缀**（Mova 与 CC/Codex 用的是同一套「工具目录检索」思路），所以 30 个 MCP 工具在 Mova 上约等于 0 额外开销。
4. **真正的上下文大头是历史**：60,000 字符预算（≈100 条消息）比固定前缀大一个量级。要压 token，压长对话比压前缀收益高。
5. **轻薄有代价**：CC/Codex 的前缀里装着 skills、workflow、更细的工具约束；Mova 把这些换成「工具内约定 + 按需检索」，省 token 但把负担转移给了模型的自主判断。是否等价要靠评测，不能只看 token 数。

## 五、口径说明

- Mova 的数字来自 payload 字符数换算（英文 4.2 字符/token、JSON 3.0 字符/token、CJK 1 字/token），**不是** provider 实报，误差约 ±15%。
- 想拿实报值：新对话发一条消息后，Mova UI 里的用量数字直接来自 provider 的 `usage`（`chat-agent.mjs:1241-1252` 只累加模型上报值），可直接和技术栈对照。
- CC / Codex 的数字含各自机器上已安装的 skills / 插件，全新安装可能更低。
