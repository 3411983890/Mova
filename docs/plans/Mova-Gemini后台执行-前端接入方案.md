# Gemini 后台执行 + Mova 前端全量接入（可行性方案）

> 前提：接受 Gemini 以「后台 CLI / ACP 执行器」形式运行（不在 Mova 进程内直连模型）。
> 问题：它的**思考、目标、计划、提问卡片、审批卡片、工具过程、改动 diff**，能不能全部接到 Mova 现有前端？
> 答案：**能。** 其中「思考 / 计划 / 工具 / 改动 / 审批 / 提问」有 1:1 的 ACP 通道（t3code 已经逐项实现过，见文末证据）；**唯一真正缺的是「目标」**，ACP 没有这个概念，需要 Mova 在会话层自己维护（或通过 MCP 反向注入工具让它写）。

---

## 0. 先分清两种「后台用 Gemini」

这两种理解的工作量差 10 倍，必须先确认是哪一种：

| | **形态 A：Gemini 当模型**（后台直连） | **形态 B：Gemini 当执行器**（后台 CLI/ACP） |
| --- | --- | --- |
| 谁拥有 agent 循环 | **Mova**（`chat-agent.mjs` 的 tool loop） | **Gemini CLI** |
| 目标 / 计划 / 提问 / 审批从哪来 | Mova 自己的 `set_goal`/`set_plan`/`ask_user`/`request_approval` 工具 | ACP 事件（CLI 产生），Mova 只做翻译 |
| 前端改动 | **零**（现有事件/卡片天然就有） | 需要事件翻译层 + 三处组件扩展（本文重点） |
| 能否稳定 | ❌ 要直连 `cloudcode-pa` 内部 API（无公开承诺） | ✅ 官方 CLI 行为 |
| Mova 自有工具（项目/浏览器/桌面/记忆/MCP） | ✅ 模型直接可调 | ❌ 默认不可用，需经 MCP 暴露 |
| 审批闸门 | ✅ 在 Mova 的 `permissions.cjs` 里 | ⚠️ 必须由 Mova 实现 ACP 的 `fs/*`、`terminal/*` 回调才能拦住 |

本文按 **形态 B** 写——因为你说"可以后台使用 gemini"，且 CLI 路线才是长期可维护的。

---

## 1. ACP 能给出什么（逐项对照 Mova 现有前端）

Mova 的事件契约（`src/services/mova-client.ts:38-81`）只有这些成员：`text / thinking / image / search / read / memory / tool / memory-used`（ReplyEvent）+ `usage / goal / plan`（StateEvent）。ACP 的 session update 与反向请求，映射如下：

| ACP 通道 | 内容 | → Mova 事件 / 组件 | 可行性 |
| --- | --- | --- | --- |
| `agent_thought_chunk` / `agent_thought` | 流式思考文本 | `{type:'thinking', id, round, text}` → `thinking-block.jsx` | ✅ 直接 |
| `agent_message_chunk` / `agent_message` | 正文增量 | `{type:'text', id, text}` | ✅ 直接 |
| `tool_call` / `tool_call_update`（`kind: read/edit/execute/search/fetch/other`，`status: pending/in_progress/completed/failed`） | 工具过程 | `{type:'tool', id, name, label, status, detail}` → 轨迹行 | ✅ 直接（status 四态要归一） |
| `tool_call.content[]` 里的 `{type:'diff', path, oldText, newText}` | 文件改动 | `tool.diff` / `path` → `approval-bar` 预览、`changes-panel` | ✅ 直接（Mova 已有 diff 渲染） |
| `tool_call.content[]` 里的 `{type:'content', content:{type:'text'|'image'}}` | 命令输出、截图 | `tool.output[]` / `{type:'image'}` | ✅ 直接 |
| `plan` / `plan_update` / `plan_removed` | 步骤清单 | `{type:'plan', plan:{steps[{label,status}]}}` → 计划组件 | ✅ 需状态映射（见 §3.2） |
| `session/request_permission`（普通权限） | 审批 | `approval-bar`：`{message, detail, allowSession, preview}` + `decide('once'\|'session'\|'deny')` | ⚠️ 选项需动态化（见 §3.3） |
| `session/request_permission`（**Antigravity 把"提问"也走这个通道**） | 选择题 | `ask-card`：`{question, options[{label,value,description}]}` | ✅ 有现成提取器（见 §3.4） |
| `elicitation/create` | JSON-Schema 表单 | 新增「表单卡」 | ⚠️ 需新组件（见 §3.5） |
| `PromptResponse.usage`（含 `thoughtTokens`/`cachedReadTokens`） | token 用量 | `{type:'usage'}` | ✅ 直接（注意 Gemini 口径） |
| `compaction_update` / `compaction_summary_chunk` | 上下文压缩 | 无对应 → 折叠成一条 notice | ⚠️ 降级 |
| 子 agent（Antigravity child sessions） | 子任务 | Mova 无 subagent UI → 折叠成一条 tool 行 | ⚠️ 降级 |
| **`goal`** | — | — | ❌ **ACP 没有，必须 Mova 自己维护** |

结论：**7 项直接可接，4 项需扩展/降级，1 项（目标）需要新机制**。

---

## 2. 关键设计：Mova 变成「渲染器 + 权限闸门」

形态 B 下职责边界必须钉死，否则权限、diff、审批会失控：

```
Mova 主进程
├── acp-client.mjs        stdio JSON-RPC：initialize / session/new / session/prompt / session/cancel
│                         ▲ 同时响应 CLI 发来的「反向请求」（这是闸门所在）
├── acp-gate.mjs          反向请求 → Mova 的 permissions.cjs / approvals.cjs / 项目根白名单
│                         fs/read_text_file  → 校验路径在 projectRoots 内
│                         fs/write_text_file → 走 approval-bar（带 diff 预览）
│                         terminal/create|output|wait_for_exit|kill → 走 run_command 的权限与审计
│                         session/request_permission → approval-bar / ask-card
│                         elicitation/create → 表单卡
├── acp-translate.mjs     ACP update → StreamEvent（翻译层，纯函数、可单测）
└── chat-agent.mjs        路由：provider.kind==='acp' 时走上面这条链，否则走原 pi-ai 链
```

**为什么闸门必须在这里**：ACP 的 `fs/*`、`terminal/*` 是**客户端实现**的（CLI 请求，客户端执行）。也就是说，Gemini 自己不碰磁盘——它请求，Mova 执行。所以「所有写操作都过 Mova 审批」在架构上是天然成立的，不需要信任 CLI 的权限模式。t3code 正是这么做的（`provider-acp/src/server/clientPolicy.ts`、`clientTerminals.ts`、`AntigravityClientFiles.ts`）。

反过来，如果偷懒让 CLI 直接读写磁盘（不实现 `fs/*`），Mova 就退化成"看板"，`changes-panel` 的 diff 也就只能靠事后 `git diff` 猜——这是必须避免的降级。

---

## 3. 四个缺口与解法

### 3.1 目标（goal）：ACP 没有

Mova 的 goal 是"模型通过工具写的会话级状态"（`chat-agent.mjs:859-903`：`set_goal`/`update_goal` → `emit({type:'goal'})`）。ACP 没有对应通道。三种解法：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **G-a 会话层自维护**（推荐先做） | Mova 用首条用户消息 + 会话标题生成一个只读 goal，卡片标注"会话目标（Mova 维护）" | 零依赖、永不缺失；但**不是 Gemini 的意图**，不能声称是模型目标 |
| **G-b 经 MCP 反向注入** | 在 profile 的 `config/mcp_config.json` 里注册 Mova 自己的 MCP server，暴露 `set_goal` / `update_plan` / `ask_user` | Gemini（支持 MCP）会像用普通工具一样调用它们，从而"主动"写 goal；代价：MCP 工具能干活 → 必须限制成"只回传状态、无副作用"的三个工具 |
| G-c 提示词约束 | 在 system prompt 里要求它先输出一段 `<goal>…</goal>` 再干活，翻译层解析 | 最脏，模型不一定遵守，不建议 |

**建议**：G-a 做兜底永远显示；G-b 做增强（有就覆盖，没有就用 G-a）。注意 t3code 的经验：profile 里一旦有全局 `hooks.json`/`mcp_config.json`，他们的"纯文本生成"就直接拒绝——说明 MCP 会带副作用，注入的工具必须是白名单的纯状态回传。

### 3.2 计划（plan）：结构不同，需要归一

- Mova：`PlanStep = {label, status:'pending'|'active'|'done', meta?}`，**只允许一个 active**（`chat-agent.mjs:936-941` 强制）。
- ACP：`plan.entries[] = {content, priority, status}`，status 是 `pending|in_progress|completed|failed`，可出现多个 `in_progress`。

映射规则（写在 `acp-translate.mjs` 里，纯函数）：

```
in_progress → 'active'（若已有 active，后来的降级为 'pending'）
completed   → 'done'
failed      → 'done' + meta:'失败'
pending     → 'pending'
label ← content（截断 60 字符，超长进 meta）
```

风险：CLI 的 plan 是"它自己的 todo"，可能非常频繁地整表替换，导致前端计划卡闪烁。建议**节流**（同帧合并 + 至少 200ms 间隔），并只在 `plan` 实质变化时 emit。

### 3.3 审批（approval）：选项必须动态化

Mova 现在：`ApprovalBar` 收 `{message, detail, allowSession, preview}`，按钮固定为「允许一次 / 本次会话允许 / 拒绝」（`approval-bar.jsx:456-500`）。

ACP 给的是**选项列表**，且不同工具给的选项不同（t3code `AntigravityProtocol.ts:77-102`）：

```
allow_once   → 允许一次       → Mova 'once'
allow_always → 允许本会话     → Mova 'session'（注意：有的选项带 _meta 安全警告，要显示成 warning 文案）
reject_once  → 拒绝           → Mova 'deny'
reject_always / cancel → 拒绝并结束本轮
```

改造：`ApprovalBar` 增加可选 `options: [{id, label, kind, warning?}]`，有就按它渲染（回填 `optionId`），没有就走现有固定三键。**不要**试图把 CLI 的选项改写成 Mova 的三键——`reject_always` 与 `reject_once` 语义不同，改写了会出"拒绝一次却永久记住"的错。

### 3.4 提问卡（ask-card）：有现成通道，但要注意上限

Antigravity 把"要用户选一个"这类提问走 `session/request_permission` 通道，选项就是答案（t3code `isAntigravityUserInputRequest` + `extractAntigravityUserInputQuestion`，`AntigravityProtocol.ts:115-165`）。它已经把 ACP 请求翻译成 `{id, header, question, multiSelect, allowCustomAnswer, options:[{value,label,description}]}` —— **和 Mova 的 `AskQuestion` 结构几乎同构**。

两处必须处理：

1. **上限**：Mova 的 `ask-card.jsx` 硬限制 4 个选项、label ≤26、description ≤56（超出直接 `clip`）。ACP 可能给 6–8 个长选项 → 翻译层先截断（保留唯一 `optionId`，label 超长截断并去重），否则用户选了个"看起来一样"的选项，回填会错。
2. **回填**：用户选择 → `{outcome:{outcome:'selected', optionId}}`；用户点「跳过」→ `cancelled`。**绝不能**把自定义文本塞进 optionId（CLI 会拒绝），自定义回答只能走 `elicitation` 或"取消后由 Mova 补一句用户消息"。

### 3.5 elicitation：要新增一个「表单卡」

`elicitation/create` 是 JSON-Schema 表单（t3code 有 `elicitationForm.ts` 专门做 schema→字段）。Mova 只有 ask-card（选择）与 approval-bar（确认），**没有表单**。

最小可用做法：把 schema 降维成一个受限表单卡，只支持 `string`（含 enum→下拉）、`boolean`（开关）、`number`，超过 6 个字段或出现 `object/array` 就显示"该步骤需要你在终端里确认"并附原文 JSON（可折叠）。这是**产品级妥协**，要写进文档让用户知道。

---

## 4. 前端改动清单（按文件）

| 文件 | 改动 | 量级 |
| --- | --- | --- |
| `src/services/mova-client.ts` | `ReplyEvent` 增加 `{type:'notice'}`（压缩/子 agent/降级提示）；`ChatRequest` 增加 `engine:'acp'`；`ApprovalRequest` 增加可选 `options` | 小 |
| `src/features/approvals/approval-bar.jsx` | 支持 `options` 动态渲染 + `warning` 展示 | 中 |
| `src/features/ask/ask-card.jsx` | 选项上限从"截断"改为"截断 + 去重 + 标记被截断"，允许 `header` | 小 |
| `src/features/chat/chat-transcript.tsx` | 新 `notice` 行；`tool` 行支持 `kind:'mcp'\|'subagent'` 图标 | 中 |
| 新增 `src/features/ask/form-card.jsx` | elicitation 表单卡 | 中 |
| `src/features/chat/*` 计划/目标组件 | plan 状态映射后的展示不变（翻译层已归一） | 零 |
| `electron/chat-agent.mjs` | 增加 `engine==='acp'` 分支：不建 pi-ai 流，改为 `acp-client` 驱动，事件走 `emit()` | 大 |
| 新增 `electron/acp/*.mjs` | client / gate / translate | 大 |

后端工作量估算（最小可用，不含子 agent 可视化）：

- ACP 客户端 + 会话生命周期：**500–700 行**
- 反向请求闸门（fs/terminal/permission/elicitation → Mova permissions）：**400–600 行**
- 翻译层（纯函数）+ 单测：**300–400 行**
- 前端：**300–400 行**

对比 t3code：它的 `AcpSessionRuntime.ts`(115 KB) + `adapter.ts`(414 KB) 是因为要支持多线程、断线恢复、子 agent、多 provider 共用 ACP；Mova 只做单会话单 provider，**不需要那个体量**。

---

## 5. 分阶段落地

| 阶段 | 目标 | 验收 |
| --- | --- | --- |
| **G1-a 只读渲染** | 跑通 ACP 会话：正文、思考、工具行、plan、usage 全部进 Mova 时间线；`fs/*` 全部拒绝（只读） | 让 Gemini 读一个项目并解释，前端能看到完整思考+计划+读文件轨迹，且没有任何写入 |
| **G1-b 审批闸门** | 接 `session/request_permission` + `fs/write_text_file` + `terminal/*`；审批卡带 diff 预览；「允许一次/本会话/拒绝」写回 ACP | 让 Gemini 改一个文件：Mova 弹审批卡 → 允许后落盘 → `changes-panel` 能看到 diff；拒绝后 CLI 收到 reject 并继续/结束 |
| **G1-c 提问与表单** | Antigravity 提问 → ask-card；elicitation → 表单卡；「跳过」写回 cancelled | 提问 4 选项 + 超长选项截断、表单 3 字段，都能正确回填 |
| **G1-d 目标 + MCP 增强** | goal 兜底（会话层）+ MCP 注入 `set_goal`/`update_plan`；plan 节流 | Gemini 主动调用 `set_goal` 时前端目标卡更新；不调用时显示兜底目标 |
| **G1-e 降级项** | 子 agent 折叠、compaction notice、取消/中断语义 | 中断后工具行变 `denied/cancelled`，不留 running |

---

## 6. 必须提前知道的 5 个坑（都有 t3code 的对应实现）

1. **`fs/*` 是客户端责任**：不实现就等于把磁盘交给 CLI，审批、diff、项目根白名单全部失效。
2. **提问与审批共用 `session/request_permission`**：必须先用 `isAntigravityUserInputRequest` 判别，否则会把"选哪个方案"渲染成"是否允许执行"——语义完全错。判别依据是 `toolCall` 的 meta（t3code 用 `toolCall.rawInput`/kind 区分）。
3. **`allow_always` 可能带安全警告**（`_meta` 里的 `security_warning`）：必须在按钮上显示，这是阻止"永久放行 shell"的唯一机会。
4. **plan 会整表替换且可能多 `in_progress`**：必须归一 + 节流，否则前端计划卡抖动。
5. **Gemini 的 usage 口径不同**：`inputTokens` 不含 `cachedReadTokens`，`outputTokens` 不含 `thoughtTokens`（`adapter.ts:259-290` 的 `geminiUsage` 分支）。Mova 的用量统计若直接相加会少算，token 成本显示要按这个口径修。

---

## 7. 证据索引（t3code，仓库 `apps/server/src` 与 `packages/provider-acp/src/server`）

| 主题 | 位置 |
| --- | --- |
| ACP update 全集（含 `plan`/`plan_update`/`plan_removed`/`compaction_*`） | `packages/provider-acp/src/server/adapter.ts:1442-1463` |
| `PlanUpdated` → 计划事件 | `adapter.ts:5582-5601` |
| Gemini 用量口径 | `adapter.ts:255-290` |
| 审批选项映射 allow_once/allow_always | `provider/acp/AntigravityProtocol.ts:77-102` |
| 提问（走 permission 通道）→ 问题结构 / 回填 | `AntigravityProtocol.ts:115-165` |
| 审批请求处理与 `closeTextStreams` | `adapter.ts:5617-5640` |
| 客户端 fs 读修复 | `provider/acp/AntigravityClientFiles.ts` |
| 终端由客户端执行 | `packages/provider-acp/src/server/clientTerminals.ts` |
| 客户端策略（路径白名单等） | `packages/provider-acp/src/server/clientPolicy.ts` |
| elicitation → 表单 | `packages/provider-acp/src/server/elicitationForm.ts` |
| 子 agent 折叠 | `provider/acp/AntigravityChildWork.ts` |
| 会话只取文本、拒掉一切工具（反例，说明"只读"怎么实现） | `textGeneration/AntigravityTextGeneration.ts:178-234` |
| MCP 注入点（profile 的 `config/mcp_config.json`） | `textGeneration/AntigravityTextGeneration.ts:73-93` |
