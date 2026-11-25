# Mova 上下文压缩与 Agent 上下文工程实施方案

> 状态：设计稿（未改动任何代码）
> 依据：`新建 文本文档 (2).txt` 的调研结论 + 对当前代码的逐条复核
> 复核口径：只认代码事实。凡文中标注「证据」的地方都可按 `文件:行号` 复查。
> 关键前提：客户已确认四项决策 —— ①每次压缩都调用一次 LLM 摘要；②本次只交付方案文档；③被压缩的原文完整保留并可用工具回查；④自动压缩默认开启（阈值 70%），目标协议改为按复杂度启用。

---

## 0. 结论先行

1. **Mova 真正缺的不是提示词长度，而是「上下文的分层契约」**：目前所有内容被拼成一个 `systemPrompt` 字符串（`electron/chat-agent.mjs:1194-1225`），常量与每轮变量混在一起，既无法按来源解释，也无法稳定复用前缀。
2. **压缩能力应该做成「可观察的台账 + 三个工具 + 一个自动触发器」**，而不是藏在提示里的一段话。底层 `@earendil-works/pi-agent-core` **已经提供了正确的接入点**（`transformContext`、`prepareRequest`、`prepareNextTurn`），并且明确把 `transformContext` 文档化为「上下文窗口管理 / 裁剪旧消息」的位置；但它本身**没有任何内建压缩实现**（证据见 §2.3）。也就是说：能力要从 Mova 自己写，接入点是现成的。
3. **txt 的 6 条缺陷全部成立，其中 3 条比 txt 描述的更严重**（见 §3 校正表）：`memory_search` 不只是缺 `source`，`memory_read_source` 还缺 `mode`；Edge 的 `download`/`time` 不是「枚举漏了两项」，而是扩展侧根本不支持这两种等待；渲染端 `buildContextHistory` 算完即丢弃（`app.js:2706` vs `:2719`），UI 提示与实际发送内容并不一致。
4. **另外发现 6 条 txt 没有覆盖的缺陷**（§5 中标 ★），其中「单轮内工具结果无压缩通路」和「测试注入点缺失前的一次性模型调用」对压缩能力是硬约束，必须在设计里先解决。
5. 交付物是这份方案：包含数据结构、工具 Schema、摘要提示词全文、预算公式、逐文件改动点、契约测试用例、分阶段实施顺序与回滚点。按 §7 的 P0→P1→P2 推进即可。

---

## 1. 证据等级说明

本方案的所有断言分三档，文中用标记区分：

| 标记 | 含义 | 例 |
|---|---|---|
| **【代码】** | 已直接读到实现，附 `文件:行号` | `buildContextHistory` 默认 60,000 字符（`src/features/chat/context-budget.mjs:2`） |
| **【API】** | 来自依赖包的类型声明/实现，附行号 | `transformContext` 用于裁剪旧消息（`pi-agent-core/dist/types.d.ts:187-207`） |
| **【设计】** | 本方案提出的新约定，尚无代码 | `context_compact` 工具、`CompactRecord` |

---

## 2. 现状：一次请求究竟组成了什么

### 2.1 端到端链路（已复核）

```text
渲染进程 sendMessage()                                app.js:2558
  ├─ messages[]（UI 记录：text / imageIds / reply.timeline）
  ├─ history = 映射成 {role,text,model,reasoning,images}   app.js:2670-2682
  ├─ budget = buildContextHistory(history)               app.js:2706  ←← 只用来弹一句提示
  └─ request = { messages: history, aim, projectInstructions, ... }   app.js:2708-2728
        ↓ IPC model:complete（preload.cjs:245）
主进程 model-ipc.cjs:344  重试循环（最多 5 次）· checkpoint 记录  model-ipc.cjs:330-407
        ↓
chat-agent.mjs runChatAgent()
  ├─ portable = buildContextHistory(request.messages)     chat-agent.mjs:778
  │     └─ 最近 ≤100 条 / ≤60,000 字符 + 首尾 4/8 条各 250 字符摘录  context-budget.mjs:2-29
  ├─ prepareMessages() → 校验 + 最多 4 张历史图              chat-agent.mjs:680-726
  ├─ 组装 systemPrompt = [设计/身份/项目/规则/记忆/MCP/目标/aim/resume/浏览器/桌面/摘录/搜索].join(' ')  chat-agent.mjs:1194-1225
  ├─ new Agent({ initialState: { model, messages, tools, systemPrompt } })   chat-agent.mjs:1191
  │     └─ Agent 把 systemPrompt + 工具声明写成首条 system 消息  agent.js:33-35
  ├─ afterToolCall：单个结果 >40,000 字符截断；累计 >200,000 直接 terminate  chat-agent.mjs:1230-1250
  └─ agent.prompt(input) → 每轮请求前调用 transformContext（**当前未传入**）  agent-loop.js:267-273
        ↓
provider（OpenAI 兼容 / Anthropic），cacheRetention:'none'   chat-agent.mjs:752
```

### 2.2 五个必须先知道的事实（它们决定了方案形状）

**事实 A：渲染端的预算计算是死代码。**
`app.js:2706` 算完 `budget`，只在 `:2707` 用来弹一句「长对话处理：…」的提示；`:2719` 发出去的仍然是完整 `history`。真正的截断只发生在主进程 `chat-agent.mjs:778`。
→ 后果：UI 告诉用户「已保留最近上下文」，但实际裁剪口径由另一处代码决定，两份逻辑（`context-budget.mjs` 被两侧调用）会漂移。

**事实 B：单轮之内的工具结果完全没有压缩通路。**
跨轮有 `buildContextHistory`，但一轮内部的增长（读文件、抓网页、批量浏览器 diff）只有两个硬闸门：单条 40,000 字符截断、累计 200,000 字符直接 `tool_limit` 失败（`chat-agent.mjs:23-24, 1238-1247`）。
→ 后果：长任务不是「撞上下文窗口」，而是先撞 Mova 自己的 200k 字符闸门，然后整轮报废。txt 只讨论了跨轮，这一条更致命。

**事实 C：`Agent` 早就提供了压缩接入点，Mova 没有用。**【API】
- `transformContext?: (messages, signal) => Promise<AgentMessage[]>`：每轮请求前被调用，是官方文档化的「裁剪旧消息 / 上下文窗口管理」入口（`pi-agent-core/dist/types.d.ts:187-207`，调用点在 `agent-loop.js:267-273`）。
- `prepareNextTurn` / `prepareRequest` 可以替换下一轮的完整上下文（`agent-loop.js:98-111`、`:128-144`）。
- `agent.state.messages` 可读写，但**运行中的那一轮用的是自己的数组副本**（`agent.js:300-305`、`agent-loop.js:51-54`）；因此「运行中改历史」必须走 `transformContext`/`prepareNextTurn`，不能靠改 `state.messages`（这一点很容易踩错，`reset()`/`prompt()` 在运行中会直接抛错，`agent.js:234-249`）。

**事实 D：依赖包没有内建压缩，但有分词与溢出检测。**【API】
- 无任何 compact/summarize/prune 实现（两个包全文检索只有注释与文档示例）。
- `@earendil-works/pi-ai/utils/estimate` 导出 `estimateTextTokens`、`estimateMessageTokens`、`estimateContextTokens`、`calculateContextTokens`（已实测可导入）。
- `@earendil-works/pi-ai/utils/overflow` 导出 `isContextOverflow(message, contextWindow)`、`isRecoverableLength(message, desiredMaxOutput)`；文档明确说「交给调用方做一次有界的 compact-and-retry」。
- 唯一的自动上下文压力处理是把**输出上限**按剩余窗口下调（`api/simple-options.js:5-10`），历史一条都不裁。

**事实 E：Mova 已经有「压缩点」的持久化契约，只差生产者。**【代码】
`electron/services/session-store.cjs:31` 的合法事件类型里已经包含 `compaction`；`rebuildConversation()`（`:188-208`）会把最后一个 `compaction` 事件变成 `{role:'system', kind:'summary'}` 消息并**砍掉压缩点之前的历史**。`Mova服务版接口约定.md` §10 也写了「保存模型切换和压缩点」。
→ 这是重要的架构红利：压缩能力不需要新发明持久化层，只要**开始写 compaction 事件**，服务端的重建路径立刻生效。

### 2.3 依赖注入点（决定了「LLM 摘要」怎么实现才可测）

`main.cjs:241-309` 已经有一个成熟的一次性模型调用样板 `groundModel()`：`providers.resolveActive()` 解析 provider/model → `loadProviderKey()` 取 key → `sdk.streamSimple(model, { messages }, { apiKey, maxTokens, maxRetries: 0, signal })` → `stream.result()` 配 `Promise.race` 硬超时 → 抽 `text` 块。
摘要器应当复刻这个形状，但**必须接受注入的 `fetchModel`**，否则 `tests/chat-context.test.mjs` 那套「拦截请求体断言」的测试无法覆盖压缩路径。本方案把摘要器设计为 `summarize(span, deps)`，`deps = { streamFn, model, apiKey, signal, timeoutMs }`，`streamFn` 由 `runChatAgent` 已有的 `streamFn` 传入（它内部已经处理了 `guardedFetch` 的 baseUrl 白名单，`chat-agent.mjs:1171-1185`）。

---

## 3. 对 txt 六条判断的校正

| # | txt 的说法 | 复核结果 | 需要修正/补充的地方 |
|---|---|---|---|
| 1 | `memory_search` 提示里有 `source=history`，工具参数没有 | **成立**：提示 `chat-agent.mjs:1205`，Schema `:1109-1117`（仅 query/scope/limit），`execute` 只传 `{query, scope, limit}` `:1122`，底层支持 `source` `services/agent-memory-search.cjs:66,73,77` | ★ 同一处的**孪生缺陷**：`memory_read_source` 同样缺参数。提示写「Follow nextOffset with the same mode」「request the full conversation only when needed」（`:1205`），但 Schema 只有 `id/offset/limit`（`:1139-1145`），而底层 `readSource` 支持 `mode: 'message'\|'around'\|'conversation'`（`agent-memory-search.cjs:139,143`）。模型的「看整段对话」能力实际不可达 |
| 2 | Edge 等 `download` / `time` 参数不在枚举里 | **成立且更严重**：`edge-bridge.cjs:793-798` 枚举无这两个值；`edge-extension/page.js:300-337` 的 `wait` 只实现 selector/text/text-change/url/load/settle/idle/animation/frame，**没有 download 也没有 time**，文件末尾还明确「Downloads require manual control」（`:350-351`） | 不是「补两个枚举」就能修好，而是「提示承诺了扩展根本做不到的能力」。修复方向应是**按能力生成提示**（详见 §5-P0-3），而不是补枚举 |
| 3 | 长对话是「截取」而不是任务压缩；字符预算 ≠ token 预算 | **成立** | 补充：`contextWindow` 确实已存在于模型描述（`chat-agent.mjs:109`，来源是设置项 `app.js:1499`），但除传给 pi 之外**没有任何预算代码读它**；另外渲染端那份预算是死代码（事实 A） |
| 4 | 恢复检查点只记工具名 | **成立**：`model-ipc.cjs:363-366` 按 name 聚合成 `{name, status}`，`:386-390` 只存最近 40 条 + 最后 4000 字文本；提示只列名字 `chat-agent.mjs:1215` | ★ 渲染端有同一缺陷的副本：`app.js:2661-2668` 的 `interruptedNote()` 同样按名字去重（`[...new Set(tools)]`），把它写进下一轮历史。两个副本要一起改 |
| 5 | 项目规则与运行状态混在系统提示里 | **成立**：`projectRules` 上限 4000 三处（`index.html:526` maxlength、`project-data.js:17`、`chat-agent.mjs:799`）；目标、摘录、恢复全部 join 进同一字符串 `:1212-1219` | 补充：工具声明也在这条 system 消息里（`agent.js:33-35`）。因此**只要目标摘要变化，整条 system 消息连带工具声明一起变**，前缀缓存必然失效 |
| 6 | 「多步骤必须立目标」增加简单任务往返 | **成立**：`chat-agent.mjs:1211` 的 Goal protocol 无条件出现（`goalTools` 恒在 tools 列表 `:1023`） | 补充：`set_goal` 的 description 本身也写「Use it when the user asks for an outcome that takes several steps, or when you decide a multi-step result is needed」（`:912-915`），两处叠加会放大该行为 |
| 附 | `cacheRetention:'none'` 影响缓存 | **成立**：`chat-agent.mjs:752`。OpenAI 路径下该值会关掉 `prompt_cache_key`、`prompt_cache_retention:'24h'`、session 亲和头、`cache_control` 标记（`openai-completions.js:185-187, 526-537, 562-566, 781-787`）；Anthropic 路径同样关掉 `cache_control`（`anthropic-messages.js:24-43, 917-934, 1205-1225, 1313`） | 结论应更硬：**不是「可能有缓存」，而是「Mova 显式关掉了两家的缓存」**。这对压缩设计有直接影响：压缩省下的 token 才是唯一的成本收益来源，前缀复用必须先修 |

---

## 4. 设计总览：上下文台账（Context Ledger）

### 4.1 一句话

把「发给模型的上下文」当成一份**有账目的、可回查的**资产：哪些内容是常驻规则、哪些是本轮状态、哪些是被压缩成摘要的旧历史、哪些是原文，各自有预算、有来源、有失效条件；模型自己可以查账（`context_status`）、发起压缩（`context_compact`）、回查原文（`context_read`）。

### 4.2 六个分层（替代现在的单串 systemPrompt）

| 层 | 内容 | 载体（发给 provider 的形态） | 预算 | 变化频率 | 缓存性质 |
|---|---|---|---|---|---|
| **L1 产品基础** | 身份、语言、Markdown、`[[file:]]` 语法、工具诚实性、审批不可绕过 | 首条 `system`（`initialState.systemPrompt` 前半段） | 硬上限 1,200 tokens | 几乎不变 | 稳定前缀 |
| **L2 当前能力** | 本轮实际给了哪些工具族、每族的边界（浏览器/桌面/设计/项目/MCP/搜索/记忆） | 同一条 `system` 的后半段；**文案由工具清单生成**（§5-P0-3） | ≤ 1,800 tokens | 仅当能力集变化 | 半稳定（一轮内不变） |
| **L3 用户与项目规则** | CodeMova 项目规范、偏好、目录约定；带来源与作用域标签 | `system` 内 `<project-instructions>` 段（保留现状封装，加 scope 属性） | ≤ 4,000 字符（沿用），超限改为**显式提示用户**而非静默截断 | 用户修改时 | 半稳定 |
| **L4 摘要锚点** | 历次压缩产物，按时间顺序，每段带 `span` 与覆盖区间 | 首条 assistant/user 之前的独立 `system` 消息（**位置在 L1 之后、原文之前**） | ≤ 15% 窗口 | 每次压缩时 | 稳定直到下次压缩 |
| **L5 最近原文** | 未压缩的最近对话（含工具回执的裁剪版） | `messages` 数组主体 | 目标 55%–65% 窗口 | 每轮增长 | 增长式前缀，可复用 |
| **L6 本轮状态** | 目标/计划摘要、恢复信息、重试说明、临时开关 | **末尾**一条独立 `system` 消息 `<run-state>` | ≤ 800 tokens | 每轮 | 只在尾部变化，不影响前面 |

要点说明：

- **为什么 L4 放在原文之前而不是最后**：摘要描述的正是「前面被删掉的那段历史」，位置必须与语义一致；同时它只在下一次压缩时变化，属于稳定前缀的一部分。
- **为什么 L6 必须放最后**：前缀缓存是按「从头到第一次差异」计算的。现在 goal 变化会把整条 system（含工具声明）推翻重建；移到尾部后，goal 每轮变化只影响最后一段。
- **中间态 system 消息是安全的**【API】：`pi-ai` 在 `anthropic-messages.js:380, 1034-1048` 对转录中的后续 system 消息做了兼容处理（不支持中途 system 的模型会把这些内容转成合适的用户轮文本），OpenAI 路径同理。因此 L4/L6 用 `role:'system'` 是跨 provider 可移植的。
- **消息角色必须走适配层，不要在 Mova 侧硬判断**：不同接口对 `system` 的数量/位置、`tool` 轮的必需性、assistant 思考块的签名要求都不同（Mova 已经踩过：`chat-agent.mjs:709-712` 只对非 Anthropic replay `thinking`，因为 Anthropic 需要 provider 签名）。分层组装只负责「这一段是什么」（`layer:'rules'|'summary'|'run-state'`），**由 pi-ai 的适配层决定它映射成哪个角色**——绝不写 `if (provider === 'anthropic')` 这类分支来降级上下文。

### 4.3 数据结构

```jsonc
// 一次压缩产生的记录；渲染端持久化（跟随 chatAims 的模式），主进程同时写 session-store 的 compaction 事件
CompactRecord = {
  "id": "ctx_01J...",                 // ULID，稳定可引用
  "kind": "compact",
  "version": 1,
  "createdAt": 1763000000000,
  "trigger": "auto" | "model" | "user" | "overflow",   // 谁发起
  "covered": { "from": 12, "to": 148 },  // history 索引区间，左闭右开；渲染端可映射回 message.id
  "coveredMessages": 136,
  "tokens": { "before": 184213, "after": 23104, "saved": 161109, "ratio": 0.875, "estimated": true },
  "summary": {                        // 结构化摘要（§4.5 的 schema）
    "goal": "把设置页拆成独立面板",
    "constraints": ["不要改数据库结构", "保持 4000 字符上限"],
    "decisions": [{ "what": "先做只读面板", "why": "用户要求先看效果", "at": "msg-8f2" }],
    "done": [{ "what": "拆出 chat-usage.js", "evidence": "write 成功，tests/chat-usage 未跑" }],
    "open": ["未跑 npm test"],
    "artifacts": [{ "path": "app.js", "change": "edited", "note": "新增 bindChatContext" }],
    "facts": [{ "claim": "上下文窗口默认 1,000,000", "source": "app.js:1499" }],
    "rejected": ["尝试复用 composer-usage.jsx，未接入"],
    "nextStep": "补面板并跑测试"
  },
  "summaryText": "（渲染给模型的最终文本，已脱敏；由 LLM 精修或程序回退生成）",
  "source": "llm" | "deterministic",  // 摘要由谁产出，写进提示让模型知道可信度
  "model": "deepseek-v4-pro",
  "usage": { "input": 8123, "output": 742, "cost": 0.0 },   // 摘要调用本身的用量，进 usage 面板
  "archive": { "file": "ctx_01J....jsonl", "bytes": 482113, "sha256": "…" }
}
```

**归档（让「完整保留 + 可回查」成立）**：被压缩的原文写入 `<userData>/memory/context/<convKeyHash>/<id>.jsonl`，每行一条 `{index, id, role, model, text, images, at}`。目录与 `memory-ipc.cjs:20` 的 `userData/memory` 同源，便于备份/迁移复用（`object-storage.cjs` 的既有备份逻辑覆盖 memory 目录即可带上）。

**索引口径**：`covered.from/to` 用 history 索引。渲染端 history 是 `messages` 的确定性映射（`app.js:2670-2682`），所以索引可逆映射回 `message.id`，UI 高亮「这段已被压缩」不需要额外约定。

### 4.4 压缩算法

不是在原文上「砍」，而是**把一段连续区间替换为「一个摘要锚点」**，并保证若干内容永不进入压缩区间。

```text
输入：history[]（渲染端给的全量）、records[]（已有压缩记录）、model、预算
输出：messages[]（真正发给 provider 的）、records'[]（可能需要新增一条）

① 计算预算
   window   = model.contextWindow
   reserve  = min(model.maxTokens, 0.30 * window)      # 输出预留
   usable   = window - reserve
   trigger  = 0.70 * usable                            # 自动压缩阈值（已决策）
   hard     = 0.85 * usable                            # 硬上限
   tokenOf(x) = estimateMessageTokens(x) * calib(model) # §6 校准系数

② 划出不压缩区（pinned）
   P1 最近 keepLast 条（默认由预算反推，下限 6 条 / 800 tokens）
   P2 最新 1 条用户消息（永远逐字发送；超长仍走 input_too_long 报错，不静默截断）
   P3 当前 goal/plan 快照（走 L6，本来就在窗口外）
   P4 用户显式钉住的事实（P2 阶段的 context_pin，先留数据结构）

③ 判断是否需要压缩
   used = tokenOf(L1..L6 全部)
   need = used > trigger（auto）| 模型调用 context_compact | used > hard（强制）| 溢出恢复
   且有新内容：距上次压缩新增 ≥ 8 条消息 或 ≥ 4000 tokens（滞回，防抖）
   否则只做「中途紧急裁剪」③b，不做摘要
   ③b 紧急裁剪：把 L5 中较早的 tool 结果消息替换为
       "[工具结果已释放，span=<id>，用 context_read 可回查最后 6000 字符]"
       不生成摘要、不调模型（延迟敏感），并在本轮结束时补一次正式压缩

④ 选区间：span = [上次覆盖终点, 起点 of P1) 里最老的一段
   目标：压缩后 used ≤ 0.55 * usable（一次压够，避免连续触发）

⑤ 生成摘要（一次 LLM 调用，§4.5）
   输入 = 上一段 summaryText（若有）+ 本段原文（脱敏后、图片转占位、reasoning 剔除）
   输出 = 严格 JSON（§4.5 的 schema）→ 校验 → 失败重试 1 次 → 仍失败走确定性回退

⑥ 落账
   写 archive jsonl；生成 CompactRecord；emit {type:'context', record}；
   session-store 追加 compaction 事件（可用时）

⑦ 组装
   [L1+L2+L3 system] + [L4 各段 system(带 span)] + [span 之后的原文] + [L6 system]
```

**几个硬性规则（写进代码注释与测试）**：

1. 被压缩的区间必须连续，且不得跨越「未压缩的更新区间」——避免摘要顺序错乱。
2. 摘要可以叠加：第 N 次压缩的输入包含第 N-1 次的 `summaryText`，形成滚动摘要；每段都保留自己的 `span` 与 `covered`，回查不受影响。
3. 摘要永不替代「事实」：任何 `facts[].claim` 必须带 `source` 指针（消息索引/工具名/文件路径）。没有来源的断言不允许进 `facts`，只能进 `open`。
4. 摘要生成失败是**一等公民**：允许回退到确定性摘要，并把 `source:'deterministic'` 明写在提示里，让模型知道「这段是程序抽取，细节请回查」。

### 4.5 LLM 摘要器

**调用形态**：仿 `main.cjs:241-309` 的一次性调用，但走 `runChatAgent` 注入的 `streamFn`（这样 `fetchModel` 注入的测试能拦到请求体）。

```js
// electron/context/summarize.mjs
export async function summarizeSpan({ span, previousSummary, focus, model, streamFn, signal, timeoutMs = 45_000 }) {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SUMMARIZER_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: buildSpanInput({ span, previousSummary, focus }) }] },
  ];
  const stream = streamFn(model, { messages }, { maxTokens: 2_500, maxRetries: 0, signal, cacheRetention: 'none' });
  // 硬超时 + 结果抽取，与 groundModel 同形
}
```

**提示词全文**（英文，与现有工具描述语言一致；输出强制 JSON）：

```text
You compress an older slice of a working conversation into a structured handover note.
The note is read later by another assistant that can no longer see the original messages,
so it must be faithful, specific and free of speculation.

Rules:
- Report only what the transcript states. Never infer a file change, a command result or a
  user decision that is not literally present.
- Keep every explicit user constraint and prohibition verbatim (they outrank everything else).
- Name concrete artifacts (paths, tool names, error codes, URLs) instead of describing them.
- Put unverified or speculative content in "open", never in "done" or "facts".
- A fact without a pointer is not allowed: point to the message index or the tool name.
- If the earlier summary is provided, carry its still-valid content forward instead of dropping it;
  drop only what later evidence contradicts.
- Do not mention credentials, tokens, cookies or ID numbers. Replace them with «redacted».
- Output ONLY a JSON object with these keys and no prose:
{
  "goal": string,                       // ≤200 chars
  "constraints": string[],              // ≤12, each ≤160 chars, user's words where possible
  "decisions": [{"what": string, "why": string, "at": string}],
  "done": [{"what": string, "evidence": string}],
  "open": string[],
  "artifacts": [{"path": string, "change": "created|edited|deleted|read", "note": string}],
  "facts": [{"claim": string, "source": string}],
  "rejected": string[],
  "nextStep": string
}
```

**输出后处理**（顺序固定）：
1. `JSON.parse` 失败 → 重试一次（追加一句「Output JSON only」）→ 仍失败 → 确定性回退。
2. 逐字段限长裁剪（`constraints≤12×160`、`done≤20` 等）。
3. 对 `summaryText` 跑 `redactSensitive()`（复用 `services/memory-redaction.cjs`），防止摘要把凭据抄进上下文。
4. 渲染成最终 `summaryText`（模板见下），并附 `source` 与 `span`。
5. 把摘要调用自身的 usage 通过 `emit({type:'usage', phase:'compact', ...})` 上报，**用量面板要能区分「正文用量」与「压缩用量」**（现在 `chat-usage.js:82-117` 只统计一种）。

**确定性回退**（`digest.mjs`，无模型调用，纯抽取）：
- 逐条扫用户消息，抓取含否定/约束词的句子（「不要」「别」「必须」「只能」「保持」「禁止」/ `don't` / `must` / `keep`）→ `constraints`
- 抓路径、`文件:行号`、URL → `artifacts`/`facts`
- 抓本轮已收集的动作记录（与 P0-5 的恢复记录同源：`{type:'tool', id, name, status, detail}`）→ `done`（status=done）/ `rejected`（status=error）/ `open`（status=unknown）
- 未完成的 `plan.steps`（`goal-state.mjs:98-103`）→ `open`
- 最后 1 条助手文本的末句 → `nextStep`

> 你选择了「每次压缩都调用一次 LLM 摘要」，所以确定性路径只在**摘要失败/超时/上下文溢出恢复**时启用；它同时是 LLM 输出的校验骨架（字段必须齐全才接受）。

### 4.6 暴露给模型的三个工具

命名与现有风格一致（英文 description、中文 label、`additionalProperties:false`）。

#### ① `context_status` — 查账

```jsonc
{
  "name": "context_status", "label": "上下文用量",
  "description": "Report how much of this model's context window the current conversation uses, broken down by layer (rules, summary, recent messages, tool results), and how much headroom is left before compaction is needed. Call it before a long read, a big tool batch, or when a tool result says context is running out.",
  "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
}
```

返回（JSON 字符串）：

```json
{
  "model": "deepseek-v4-pro", "contextWindow": 1000000, "reserveForOutput": 128000,
  "used": { "tokens": 412300, "ratio": 0.47, "estimated": true, "calibration": 1.12 },
  "layers": [
    { "name": "rules", "tokens": 2210 }, { "name": "project", "tokens": 980 },
    { "name": "summary", "tokens": 2310 }, { "name": "recent", "tokens": 401200, "messages": 42 },
    { "name": "toolResults", "tokens": 180000, "messages": 12 }
  ],
  "autoCompactAt": 0.7, "nextAutoCompactAtTokens": 610400,
  "compactions": [{ "id": "ctx_01J...", "coveredMessages": 136, "savedTokens": 161109, "at": 1763000000000 }],
  "canCompact": true
}
```

#### ② `context_compact` — 主动压缩

```jsonc
{
  "name": "context_compact", "label": "压缩上下文",
  "description": "Compress older turns of this conversation into a structured summary so the window stops filling up. The newest messages, the current goal and the user's explicit constraints are never compressed, and the original text stays readable with context_read. Use it before a long reading or browser task, after finishing a phase, or when context_status shows the window is more than about 70% full. It costs one extra model call, so do not call it when the conversation is still short.",
  "parameters": {
    "type": "object",
    "properties": {
      "focus": { "type": "string", "maxLength": 200, "description": "What the summary must preserve above all, e.g. a path, a constraint or an open question." },
      "keepLast": { "type": "integer", "minimum": 2, "maximum": 200, "description": "How many of the newest messages to keep verbatim. Defaults to what the budget allows." },
      "reason": { "type": "string", "maxLength": 200, "description": "One short sentence on why compaction is needed now." }
    },
    "additionalProperties": false
  }
}
```

返回：

```json
{ "ok": true, "record": { "id": "ctx_01J...", "covered": { "from": 12, "to": 148 }, "coveredMessages": 136 },
  "tokens": { "before": 412300, "after": 110400, "saved": 301900 },
  "source": "llm",
  "note": "Older turns were compressed. The original text is still available: call context_read with span=\"ctx_01J...\"." }
```

失败/不可压缩时返回 `isError:true` + 明确原因（`too-few-messages`、`already-compacted`、`summarizer-failed`、`user-disabled`）。

#### ③ `context_read` — 回查原文（这是「摘要不可信」的保险）

```jsonc
{
  "name": "context_read", "label": "回查被压缩的原文",
  "description": "Read the original messages behind a compaction summary. Use it whenever a summary is too coarse to act on, when you need the exact wording of an earlier instruction, or before retrying something the summary marks as done. Paging works with offset/nextOffset; mode \"grep\" searches the whole span for a literal string.",
  "parameters": {
    "type": "object",
    "properties": {
      "span": { "type": "string", "description": "Compaction record id from context_status or a summary block." },
      "mode": { "type": "string", "enum": ["messages", "grep"], "description": "messages returns text by index/offset, grep searches the whole span. Defaults to messages." },
      "from": { "type": "integer", "minimum": 0, "description": "First history index to read (mode=messages)." },
      "to": { "type": "integer", "minimum": 0, "description": "Exclusive upper history index (mode=messages)." },
      "query": { "type": "string", "maxLength": 200, "description": "Literal text to search for (mode=grep)." },
      "offset": { "type": "integer", "minimum": 0, "description": "Character offset inside the result. Defaults to 0." },
      "limit": { "type": "integer", "minimum": 1, "maximum": 6000, "description": "Max characters to return. Defaults to 4000." }
    },
    "required": ["span"], "additionalProperties": false
  }
}
```

返回形状复用 `agent-memory-search.cjs:36-56` 的分页契约（`{messages:[{...}], nextOffset}`），保证模型对两套工具的学习成本一致。

> 三个工具都只在**非临时会话**提供（`request.temporary !== true`），因为临时会话不落盘、无法归档原文，压缩后不可回查——这一点必须与现有临时会话边界一致（`memory-ipc.cjs:316`、`app.js:2686`）。

**提示里对应的那一段（放在 L2「当前能力」，由工具清单生成，不要手写）**：

```text
Context: this conversation is compacted into a summary when it fills up. context_status reports
the real usage; context_compact compresses older turns yourself (one extra model call);
context_read re-reads the original messages behind any summary — prefer it over guessing when a
summary looks too coarse. A summary is a derived note, not evidence: never claim a file change,
a page state or a command result from a summary alone.
```

最后一句是关键：**摘要是「派生物」，不是「证据」**。这与现有 `:1213` 「重建上一轮发生了什么」的措辞同源，避免压缩机制反过来鼓励模型编造。

### 4.7 自动触发

```js
// 主进程，runChatAgent 内部
const ledger = await prepareLedger({                     // 阻塞，允许一次摘要调用
  history: request.messages, records: request.ledger?.records ?? [], model,
  ledgerSettings,                                        // 用户设置：enabled / threshold / keepLast
  summarize: span => summarizeSpan({ ...span, streamFn, signal, model }),
});
// transformContext 每轮复用同一份台账，不再生成摘要（避免一轮内多次计费）
const agent = new Agent({
  initialState: { systemPrompt: stablePrompt, messages: ledger.messages, tools, model, thinkingLevel },
  transformContext: (messages, sig) => applyLedger(messages, ledger, { emergencyTrim: true }),
  ...
});
```

- **阈值 70%（已决策）**，硬上限 85%，滞回：距上次压缩新增 ≥8 条消息或 ≥4000 tokens 才再次触发。
- **一次压缩一次摘要调用**；一轮之内即使多次越过阈值，也只做紧急裁剪（占位替换），不再调模型。
- **用户可以关**：`设置 → 上下文` 新增 `enabled`、`threshold(50–90%)`、`keepLast`、`summaryProvider/model`（默认跟随当前模型）；关闭后仅保留 `context_status` / `context_read`。
- **提示必须告知状态**：L6 的 `<run-state>` 里带一行 `context: 47% used, 1 compaction (ctx_01J…, 136 messages)`，并把自动压缩事件作为一条 `context` 事件渲染在时间线上（复用 `mergeReplyEvent`，`app.js:2748`）。

### 4.8 溢出恢复（最后一道闸）

`isContextOverflow()` / `isRecoverableLength()` 已可导入（§2.2 事实 D）。在主循环里：

```js
if (lastStop === 'error' || lastStop === 'aborted') {
  if (isContextOverflow(lastAssistantMessage, model.contextWindow)) throw new ModelError('context_overflow');
  ...
}
```

`model-ipc.cjs` 的重试循环（`:330-407`）新增分支：收到 `context_overflow` → 强制压缩（`trigger:'overflow'`，忽略滞回）→ 重新尝试；每个 attempt **最多触发一次溢出恢复**，避免无限循环；仍失败则按现有 `attempt===5` 的逻辑收尾并给出可操作文案（「上下文已压缩到 xx%，请重试」）。同时把 `empty`/`protocol` 之外新增 `context_overflow` 加入 `RETRYABLE`（`:319`），但排除在「5 次上限」之外更合理：单独 1 次额度。

### 4.9 与既有能力的关系

| 既有机制 | 关系 | 必须遵守的约束 |
|---|---|---|
| `aim`（goal/plan） | 压缩时 `plan.steps` 的未完成项直接进摘要 `open`；压缩不改变 goal 状态 | 摘要不得替代 `set_plan`，`goal-state.mjs` 仍是唯一事实源 |
| `resume`（中断恢复） | 检查点升级为结构化动作记录（§5-P0-5），压缩时把「未确定」的动作强制钉住 | 「可能已执行但未确认」的动作永不进压缩区间 |
| `memory_search` | 压缩摘要与长期记忆是两套，不互相写入 | 摘要不落长期记忆；避免记忆污染 |
| 临时会话 | 不压缩（或只在内存中压缩、不可回查） | 建议：临时会话提供 `context_status`，不提供 `context_compact` |
| `session-store` | 每次压缩写 `compaction` 事件（`content.summary`） | 事件 id 由 `eventIdFor` 确定性生成，重投递幂等（`session-store.cjs:156-169`） |

---

## 5. 缺陷清单与修复方案

优先级沿用 txt 的口径，但★标记的是本次复核新增、txt 未覆盖的项。

### P0 — 契约不一致 / 直接影响可用性

#### P0-1 `memory_search` 缺 `source`（txt §3.1）

- **证据**：提示 `chat-agent.mjs:1205`；Schema `:1109-1117`；execute 只传三个字段 `:1122`；底层支持 `source: 'auto'|'history'`（`agent-memory-search.cjs:66,73,77`）。
- **影响**：模型按提示写 `source:"history"` 会被 Schema 拒绝（`additionalProperties:false`）；它只能靠「记忆没命中时底层自动回退历史」这条隐式路径，行为不可控。
- **修复**：
  ```js
  source: { type: 'string', enum: ['auto', 'memory', 'history'],
    description: 'auto searches saved memories first and falls back to chat history; memory searches only saved memories; history searches only earlier conversations.' },
  ```
  `execute` 签名改为 `({ query, scope = 'current', limit = 8, source = 'auto' })` 并透传。同时补一处语义漏洞：底层的历史回退发生在「记忆零命中」时（`agent-memory-search.cjs:106`），只判了 `!selected.length`，没有判 `source`；新枚举里 `source:'memory'` 的语义是「只搜记忆、不回退」，因此该处需加 `source !== 'memory'` 守卫，否则新的枚举值一上线就是错的。
- **验收测试**（`tests/chat-context.test.mjs` 扩一条）：断言 tools 里 `memory_search` 的 `parameters.properties.source.enum` 含 `history`；再以 `fetchModel` 让模型发 `source:"history"` 的工具调用，断处理器把 `source:'history'` 传到底层（用 stub 记录入参）。

#### P0-2 `memory_read_source` 缺 `mode`（★ 新增）

- **证据**：提示「Follow nextOffset with the same mode」「request the full conversation only when needed」（`chat-agent.mjs:1205`）；Schema 只有 `id/offset/limit`（`:1139-1145`）；底层 `readSource` 支持 `mode: 'message'|'around'|'conversation'`（`agent-memory-search.cjs:139,143,150`）。
- **影响**：模型永远只能读单条消息，「看前后几轮」「看整段对话」两类最常用的取证手段不可达；而提示明说了它可以。
- **修复**：Schema 增 `mode`（enum 三项，默认 `message`，描述各模式的成本），execute 透传；提示里的措辞改为与枚举一致（`mode="around"` / `mode="conversation"`）。
- **测试**：断言 enum 存在；以 stub 断言 `mode:'conversation'` 时传给 `readSource` 的入参含该值。

#### P0-3 Edge 等待条件与扩展真实能力不符（txt §3.1，修法升级）

- **证据**：`EDGE_BROWSER_PROMPT` 要求 `for=frame/download` 与 `for=time`（`chat-agent.mjs:31`）；Edge 参数枚举无这两项（`edge-bridge.cjs:797`）；扩展实现只有 9 种条件，**没有 download、没有 time**，且明确「Downloads require manual control」（`edge-extension/page.js:300-337, 350-351`）；对照内置浏览器确实支持 `download` 与 `time`（`electron/browser/tools.cjs:193`，`target.cjs:257-277`）。
- **影响**：模型会反复尝试一个不存在的条件，每次失败都在烧一轮。
- **修复（推荐）**：**停止手写能力句，改为从工具枚举生成**。
  ```js
  // electron/browser/prompt.cjs（新）
  export function capabilitySentence(tools) {
    const wait = tools.find(t => t.name === 'browser_wait')
      ?.parameters?.properties?.for?.enum ?? [];
    ...生成 "wait conditions available here: selector, text, url, settle, idle, animation, frame."
  }
  ```
  `chat-agent.mjs:31` 的 Edge 提示与 `:1217` 的内置浏览器提示都改为「固定前半段 + 由枚举生成的能力句」。这样以后任何一侧新增/删除条件，提示自动跟随。
- **同时**：在 `edge-extension/page.js` 补 `time`（纯前端 `setTimeout` 等待即可，成本低、与内置浏览器语义对齐）；`download` 明确写入提示的「不可用」清单，并指引「用 browser_read 读下载页/或让用户手动下载」——**不要**假装支持。
- **验收测试**（新建 `tests/browser-prompt-contract.test.mjs`）：对三种组合（Edge / 内置 / 无浏览器）分别断言「提示中出现的每个 `for=` 值都在该轮 browser_wait 的 enum 里」；反向断言 Edge 提示不含 `download`。

#### P0-4 MCP 工具「搜得到但不会用」（txt §3.2）

- **证据**：`mcpCatalog` 只保留 `id/server/name/description`（`chat-agent.mjs:800-803`），而 `inputSchema` **已经存在磁盘上**（`mcp-manager.cjs:87`）；`mcp_search` 返回 `{...item, score}`（`:1081-1085`）；`mcp_call` 收开放 `arguments` 且无校验（`:1088-1102`）。
- **修复**（三步，保留按需加载的省 token 优点）：
  1. `mcpCatalog` 增加 `inputSchema`（不发给模型，只留在进程内）。
  2. `mcp_search` 返回项加 `hasSchema:boolean` 与 `required:string[]`（只给字段名，几十字节），并在描述里写「call `mcp_tool_info` before the first call」。
  3. 新增工具 `mcp_tool_info { id }` → 返回该工具当前 `inputSchema`（截断到 6000 字符）；`mcp_call` 在调用前按 `inputSchema.required` 做**最小校验**（缺字段立即返回 `Missing required argument: xxx`，不发起 IPC）；校验通过的 schema 以 `(id, schemaHash)` 缓存，`row.tools` 变化时失效（`mcp-manager.cjs:118` 的开关/刷新路径可复用）。
- **测试**：`tests/mcp-*.test.mjs` 或新增：断言 `mcp_search` 结果不含完整 schema（体积守卫）；`mcp_tool_info` 返回 schema；缺必填参数时 `mcp_call` 不发 IPC 并返回字段名。

#### P0-5 中断恢复只有工具名（txt §3.4）

- **证据**：`model-ipc.cjs:362-366` 按 `name` 聚合为 `{name, status}`；`:386-390` 只保留末 40 条 + 末 4000 字；提示只列名字 `chat-agent.mjs:1215`。
- **修复**：把 `actions` 升级为**动作记录**。关键发现：**信息在 emit 层就已经存在**——工具执行层发的是 `{type:'tool', id, name, label, status, detail, ...extra}`（项目工具 `agent-tools.cjs:501,504`，记忆原文工具 `chat-agent.mjs:1151`），而 `model-ipc.cjs:362-366` 只取了 `name` 和 `status`，把 `id`、`label`、`detail` 全丢了。所以这一条**不需要改工具层，只需要改记录层**：
  ```jsonc
  ActionRecord = {
    "actionId": "tool-call-id",        // 来自工具调用 id，天然区分同一工具的多次调用
    "tool": "browser_act",
    "target": "登录按钮 @e12",          // 由工具自己上报的 label/target 摘要，≤120 字符
    "result": "done" | "failed" | "unknown",
    "evidence": "diff: 表单 3 项已填",   // ≤200 字符，来自工具返回的关键结果
    "nextStep": "点击提交"              // 可选，由模型在下一轮补
  }
  ```
  - 敏感字段：`detail` 先过 `redactSensitive`，且**永不保存**密码/验证码/页面全文/参数原值（只保存动作摘要）。
  - `result:"unknown"` 的动作在恢复提示里单列，并强制模型「先观察再决定」，与 `chat-agent.mjs:1217` 里 `outcome:"unknown"` 的既有约定一致。
  - 恢复提示从「Tools already run: a, b, c」改为分三组的紧凑清单（✅完成 / ❌失败 / ❓未确定），总数上限 20 条、每行 ≤160 字符。
  - ★ 渲染端副本 `app.js:2661-2668` 同步改造（同样三组、同样脱敏），否则两条通道行为不一致。
- **测试**：`tests/chat-context.test.mjs` 新增：模拟两次同名工具调用（一次 done 一次 unknown），断言 resume 提示里出现两条不同记录且文案命中「未确定」。

#### P0-6 ★ 渲染端预算计算是死代码

- **证据**：`app.js:2706` 计算 → `:2707` 只用于提示 → `:2719` 发送完整 history。
- **影响**：UI 文案与实际发送不一致；两份 `buildContextHistory` 调用点（渲染端/主进程）容易漂移；用户看到「已保留最近上下文」却无法验证。
- **修复**：删除渲染端这次调用，改为**由主进程回报真实口径**：`runChatAgent` 完成后 `emit({type:'context', report:{ sentMessages, omittedMessages, tokens, compactions }})`；渲染端把 `:2707` 的提示改为对该事件的渲染。这也顺手成为「上下文面板」的数据源（§4.7、P2-1）。

### P1 — 上下文工程

#### P1-1 字符预算 ≠ token 预算（txt §3.3）

- **证据**：`context-budget.mjs:2` 固定 `maxChars=60_000 / maxMessages=100`；`chat-agent.mjs:109` 有 `contextWindow` 但预算代码不读；`limits.text = 4_000_000` 与 60,000 相差两个数量级，等于窗口信息完全没用上。
- **修复**：新增 `electron/context/budget.mjs`，以 token 为主单位、字符为兜底：
  ```js
  export function planBudget({ contextWindow, maxTokens, toolsTokens, rulesTokens, model }) {
    const reserve = Math.min(maxTokens ?? 8192, Math.floor(contextWindow * 0.30));
    const usable = contextWindow - reserve;
    return {
      usable, trigger: usable * 0.70, hard: usable * 0.85,
      summary: Math.floor(usable * 0.15),
      recent: Math.floor(usable * 0.60),        // 剩余给原文，工具结果再占一部分
      safety: Math.floor(usable * 0.05),
    };
  }
  ```
  保留 `buildContextHistory` 的**兜底角色**：当 provider 未报 `contextWindow`（`entry.contextWindow` 为空 → 默认 1,000,000，`chat-agent.mjs:109`）时仍按字符预算工作，并打标 `estimated:true`。旧函数不删，改名为 `legacyCharBudget`，由新模块在缺 token 信息时调用——这样现有 `tests/context-budget.test.mjs` 的 3 条断言继续有效。

#### P1-2 旧消息首尾摘录丢失中段关键决定（txt §3.3，本方案核心）

- **证据**：`context-budget.mjs:23-28` 取前 4 + 后 8 条、每条 250 字符。
- **修复**：由 §4 的台账取代；摘录逻辑退化为「无 token 信息时的降级路径」。验收标准就是 txt 举的例子：第 30 轮说的「不要改数据库」在第 120 轮仍必须出现在上下文里（因为它属于 `constraints`，永远钉住）。

#### P1-3 ★ 单轮内工具结果无压缩通路

- **证据**：`TOOL_RESULT_LIMIT = 40_000`、`TOOL_RUN_LIMIT = 200_000`（`chat-agent.mjs:23-24`），`afterToolCall` 超限直接 `terminate`（`:1244-1247`）。按 §6 的估算，200,000 字符中文 ≈ 180k tokens；对一个 128k 窗口的模型，这个闸门比窗口还大，等于「要么没闸门、要么整轮报废」。
- **修复**：
  1. `afterToolCall` 的截断改为**可回查的截断**：返回 `…[结果已截断，完整内容可用 context_read mode=messages from=<index> 回查]`，并把完整文本写入本轮 archive（不落盘也可，存内存 LRU，容量 20 MB）。
  2. 单条上限从固定字符改为 `min(40_000, 8% * usable tokens 换算字符)`；`TOOL_RUN_LIMIT` 改为 `0.45 * usable`，且超限时**触发紧急裁剪**而不是 `terminate`；真的还不够才失败，并在正文里告诉用户「本轮工具输出过多，已压缩，可继续」。
  3. `transformContext` 每轮把「较早的工具结果」替换成占位符（§4.4 ③b），这是唯一能在轮内真正降 token 的手段。

#### P1-4 系统提示单串拼接、前缀不稳定（txt §3.5）

- **证据**：`chat-agent.mjs:1194-1225` 单个 `.join(' ')`；`aimDigest`（`:56-72`）、`portable.summary`（`:1219`）、`resume`（`:1214-1216`）都是每轮变量；工具声明与 system 同批（`agent.js:33-35`）；`cacheRetention:'none'`（`:752`）。
- **修复**：按 §4.2 拆成 L1/L2/L3（稳定 `systemPrompt`）+ L4（摘要锚点 system 消息）+ L6（`<run-state>` 尾部 system 消息）。并把 `cacheRetention` 从硬编码 `'none'` 改为按 provider 能力：
  ```js
  // provider 能力表（providers.cjs 增加 promptCache: 'auto'|'keyed'|'none'）
  cacheRetention: supportsPromptCache(provider) ? 'long' : 'none',
  sessionId,          // 仅为支持会话亲和的服务商传
  ```
  逐家验证 `usage.cacheRead` 是否由 0 变正；不支持的 provider 保持 `'none'` 回退（符合 txt §5 的谨慎口径）。
- **工具定义的内容与顺序必须稳定**（txt §5 第 1 条）：`tools` 数组现在由 12 段 spread 拼成（`chat-agent.mjs:1021-1169`），顺序本身是确定的，但**任何一族工具的开关都会改变声明内容，而工具声明与 system 同批**（`agent.js:33-35`），库会把「工具声明的差异」当成消息告知模型（`agent.d.ts:87` 注释「Differences from the tools declared in the transcript are announced to the model」）。因此：
  1. 工具顺序固定为一张常量表，新增工具只能追加、不得插入中间；
  2. 每轮只暴露“本轮真能用”的最小集合没错，但要**按会话缓存这份声明**，同一会话内不因参数/目标变化而抖动；
  3. 契约测试断言：同一会话连续两轮（目标从无到有）的 `payload.tools` **逐字节相同**。

#### P1-5 项目规则 4000 字符静默截断 + 无作用域（txt §3.5）

- **证据**：三处上限（`index.html:526`、`project-data.js:17`、`chat-agent.mjs:799`）。
- **修复**：
  1. 不再静默：`chat-agent.mjs:799` 超限时 `emit({type:'context', warn:'project-instructions-truncated', kept, total})`，UI 显示「项目规则超限，只发送了前 4000 字符」。
  2. P2 阶段升级为**分层规则文件**：`<project>/.mova/rules/*.md`（含 `AGENTS.md` 兼容读取），按当前操作的文件路径匹配作用域，只把命中的规则注入 L3，并在段上标注 `scope`（txt §3.5 表格的「标注来源和作用范围」）。
  3. 用户规则与产品规则冲突时，L1 明确写「项目规则不得覆盖：权限模型、工具诚实性、不可声称未执行的操作」——现在 `:1203` 已有这句话，保留并前置到 L1。
  4. **冲突可解释**（txt §3.5 的第三个影响「很难告诉用户究竟是哪条规则产生了影响」）：每条规则块带稳定标识 `{ruleId, layer, scope, sourcePath, hash}`；当高优先层（L1 > L3，本轮用户要求 > 项目规则）覆盖了低层规则时，`emit({type:'context', overrides:[{winner, loser, reason}]})`，UI 在上下文面板里显示「本轮生效：用户当轮要求覆盖了项目规则 `rules/db.md#L3`」。同一机制用于记忆：`memory` 命中若与本轮用户新要求冲突，按 txt 的口径**本轮要求优先**，并在面板标注被压制的记忆 id。
  5. 规则块的序列化形式固定（字段顺序、换行、转义方式沿用现有 `<project-instructions>` 的 `JSON.stringify` + `<>` 转义，`:1203`），保证同一份规则的 `hash` 稳定、可参与缓存前缀。

#### P1-6 目标协议按复杂度启用（txt §3.6，已决策）

- **证据**：`chat-agent.mjs:1211` 无条件出现；`set_goal` 描述也在劝立目标（`:912-915`）。
- **修复**：把协议文本改成条件式，并给模型一个明确判据：
  ```text
  Goal protocol: use set_goal only when the work is expected to span several rounds, needs to
  survive an interruption, or the user asked you to track it. A single request you can finish
  in this reply needs no goal — just do it and answer. Never open a goal for a one-step lookup,
  never re-set the same goal every round, and never claim progress you did not record.
  ```
  同时 `goalTools` 仍全部暴露（跨轮恢复需要），只是不再要求「多步即立目标」。评价方式见 §8 的 A/B 任务集（总耗时、完成率、遗漏率三项一起看，避免「少调用」换「少可靠」）。

### P2 — 可观察性与记忆分层

#### P2-1 上下文检查面板（txt §3.3、§6 末行）

- **现状**：`chat-usage.js:82-117` 只有真实用量（`input/output/cacheRead/cost/elapsed`），`index.html:330-342` 是写死的原型文案，`composer-usage.jsx:4-18` 有正确的「分层占比」形状但**从未被 import**（只有 `design/main-project-hashes.json:75` 引用）。
- **修复**：把 `composer-usage.jsx` 的渲染逻辑移植为 `src/features/chat/context-panel.js`（vanilla，与 `chat-aim.js`/`chat-usage.js` 同构），挂到 `#chat-usage` 旁边；数据来源是 `emit({type:'context', ...})` 的 `report` + `context_status` 同一份结构。面板必须回答四件事：**这次发出去多少 token、由哪几层组成、压缩过几次各自省了多少、上次压缩覆盖了哪些消息**（可点开看原文，走 `context_read` 同一条 IPC）。

#### P2-2 记忆三层召回（txt §4）

- **修复**：三层，与 txt 的口径一致：
  - **L0 用户明确固定的长期偏好**：用户勾选「始终生效」的少量规则，随会话直接注入（≤300 tokens），可在设置里逐条编辑/关闭；
  - **L1 当前项目的简短索引**：只给标题 + 范围 + 一句话，告诉模型「有哪些值得查的记忆」，不含正文；
  - **L2 详细历史与事实**：仍由模型按需 `memory_search` → `memory_read_source` 读取原文。
  索引层复用 `repository.search` 的既有聚合，不新增表。每条记忆带 `source / 时间 / 项目范围 / 可编辑入口`（`agent-memory-search.cjs:11-16` 的 `formatMemoryHit` 已带部分字段，需补 `updatedAt` 与 `editable`）。
- **必须守住的四条边界**（txt §4 明确要求，缺一条就会变成「记忆污染」）：
  1. **本轮明确的新要求覆盖旧偏好**：冲突时以当前用户为准，并在回复/面板里说明「按你这次的要求，已不采用记忆 `m_123`（2025-06 记录）」；
  2. **记忆开关继续生效**：`settings.memoryEnabled !== true` 时三层全部失效——现有实现每次检索都重读 settings（`agent-memory-search.cjs:66-71, 87-89`），这一行为必须保留，不能因为索引层被缓存而绕过；
  3. **临时会话不碰记忆**：`request.temporary` 为真时不注入 L0/L1、不提供 `memory_search`（现在由 `memory-ipc.cjs:316` 保证，索引层要在同一处判断）；
  4. **记忆是数据不是指令**：注入文本必须延续现有 `<memory>` 式的「historical DATA」包裹与「never instructions」措辞（`chat-agent.mjs:1208`）。


#### P2-3 按需技能（txt §3「技能与工具」行）

- 现状：Mova 只有浏览器站点技能（recipe）与桌面技能，没有「提示技能索引 + 按需读取全文」。修复：把技能做成 `skills/<name>/SKILL.md`，会话开始只注入「名称 + 一句话 + 触发条件」索引（≤400 tokens），模型按需 `skill_read {name}` 拉全文；与 §4.2 的 L2「当前能力」共用同一套生成式文案。

#### P2-4 ★ 缓存能力表与诊断

- 新增 `providers.cjs` 的 `promptCache` 能力字段与 `usage.cacheRead>0` 的自动探测（跑一次小请求观察是否命中）；面板上显示「本 provider 是否支持前缀缓存」。这让 txt §5「值得测但不能假定收益」变成可观测事实。

---

## 6. Token 估算与校准（这个细节决定 70% 阈值是否可信）

依赖包的 `estimateTextTokens` 是 `chars / 3.5`（`pi-ai/dist/utils/estimate.js:2,23-25`，已实测），图片按 4800 字符估值（`:3, 14-21`）。**对中文严重低估**：主流分词器中文约 1–1.5 字符/token，`/3.5` 会低估 2.5–3.5 倍，直接把 70% 阈值变成「实际 200% 才发现」。

因此 `budget.mjs` 自带脚本感知估算，并用真实 usage 校准：

```js
const CJK = /[\u3000-\u9fff\uff00-\uffef]/g;
export function estimateText(text) {
  const cjk = (text.match(CJK) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.1 + rest / 3.6);       // 中文≈0.9 token/字，其余≈0.28
}
export function estimateMessage(m) {
  // 文本 + 每次消息的固定开销（role/结构≈4）+ 图片按依赖包口径 4800 字符
  ...
}
// 校准：每次 provider 回报 usage.input 后
// ratio = usage.input / estimatedTotal；calibration = EMA(ratio, 0.3)，clamp [0.5, 3]
```

校准值按 `provider+model` 存（不按会话，避免冷启动抖动），存在 `providers.cjs` 的既有 settings 结构里；`context_status` 必须把 `estimated:true` 与当前 `calibration` 一起返回，让模型与用户都知道这是估算。

**验收**：在一段含 60% 中文、30% 代码、10% JSON 的 300k 字符样本上，估算值与真实 `usage.input` 偏差 ≤ 15%；校准 3 次后 ≤ 8%。

---

## 7. 实施顺序（每阶段都可单独发布与回滚）

| 阶段 | 内容 | 改动文件 | 回滚方式 | 预计工作量 |
|---|---|---|---|---|
| **S0** | 契约测试基建：`prompt ↔ tool schema` 一致性检查器（读 chat-agent 源码 + 实际 payload），先让它**红** | `tests/browser-prompt-contract.test.mjs`、`tests/tool-schema-contract.test.mjs`（新） | 纯新增，删文件即回滚 | 0.5 天 |
| **S1（P0）** | 修 `memory_search.source`、`memory_read_source.mode`、Edge 等待能力生成化、MCP `mcp_tool_info` + 最小校验、恢复记录结构化、渲染端死代码下线 | `chat-agent.mjs`、`edge-bridge.cjs`、`browser/prompt.cjs`(新)、`mcp-manager.cjs`、`model-ipc.cjs`、`app.js` | 每个缺陷独立 commit，可按文件回退；无数据结构变更（除 `ActionRecord`，读取端向后兼容旧格式） | 2–3 天 |
| **S2（P1 基础设施）** | `electron/context/{budget,ledger,digest,summarize,archive}.mjs` + 三个工具的 Schema 与实现 + `transformContext` 接线 + `request.ledger` 契约；**先只做 `context_status`/`context_read`**（只读，零风险） | 新增 `electron/context/*`、改 `chat-agent.mjs`、`preload.cjs`、`mova-client.ts` | 关闭 flag `contextLedger.enabled=false` 即回到现状 | 4–5 天 |
| **S3（P1 压缩）** | 自动触发（70%/85%/滞回）、`context_compact`、LLM 摘要器、归档落盘、`compaction` 事件写 session-store、`context` 事件与提示 | 同上 + `memory-ipc.cjs`、`session-store` 调用点 | flag 关闭 + 保留已写 archive（不影响对话） | 4–6 天 |
| **S4（P1 提示分层）** | L1/L2/L3/L4/L6 拆分、能力句生成、目标协议条件化、缓存能力表 | `chat-agent.mjs`（重构 system 组装，抽出 `electron/prompt/*.mjs`） | 保留旧 `buildSystemPrompt` 作为 `legacy` 分支，按 provider 灰度 | 3–4 天 |
| **S5（P2）** | 上下文面板、记忆三层、技能索引、缓存诊断 | `src/features/chat/context-panel.js`(新)、`index.html`、`app.js`、`chat-usage.js` | UI 面板可整块隐藏 | 4–5 天 |

**顺序理由**：S0 先把「提示承诺 vs 工具实现」做成自动检查，S1 才不至于改完又漂移；S2 的只读工具先上线，可以在不影响任何对话的前提下积累真实用量数据，用来校准 §6 的系数，再开 S3 的自动压缩——否则 70% 阈值是拍脑袋的。

---

## 8. 测试与验收

### 8.1 契约测试（防回归，必须自动化）

现有 `tests/chat-context.test.mjs` 的 `fetchModel` 拦截模式是现成范本（`:19-22` 直接拿 `payload.messages` / `payload.tools` 断言）。新增用例：

| 用例 | 断言 |
|---|---|
| `prompt-tool-consistency` | 从发出的 payload 里取所有 `tools[].function.parameters`，对提示文本里出现的每个 `参数名=` / `for=` / `mode=` 值做存在性检查；不匹配即失败 |
| `edge-wait-conditions` | Edge 组合下，`browser_wait.parameters.properties.for.enum` 与提示里列出的条件集合**双向相等** |
| `memory-search-source` | Schema 含 `source`，且 `source:'history'` 能透传到底层 |
| `memory-read-mode` | Schema 含 `mode`，`conversation` 能透传 |
| `mcp-schema-on-demand` | `mcp_search` 结果不含 `inputSchema`；`mcp_tool_info` 含；`mcp_call` 缺必填字段时不发 IPC |
| `resume-action-records` | 同名工具两次调用产生两条记录；含「未确定」分组；凭据不出现 |
| `no-silent-truncation` | 项目规则超限时发出 `warn` 事件；用户输入超限仍报 `input_too_long`（保持 `:74-78` 现有行为） |

### 8.2 压缩功能测试（主进程，注入 `fetchModel`）

| 用例 | 构造 | 断言 |
|---|---|---|
| `compact-by-tool` | 60 轮历史，模型发 `context_compact` | 下一次 payload 里旧消息消失、出现带 `span` 的摘要块、`coveredMessages` 与预期一致 |
| `compact-never-drops-pinned` | 第 3 条用户消息写「不要改数据库」 | 压缩后该句仍在 payload（在 `constraints` 里） |
| `compact-llm-output-invalid` | 摘要器返回非 JSON | 重试 1 次；仍失败则回退确定性摘要，`source:'deterministic'`，对话不中断 |
| `compact-emergency-trim` | 一轮内连续 30 次大工具结果 | 不出现 `tool_limit` 终止；较早结果变占位符；正文注明可回查 |
| `overflow-recovery` | 第一次请求返回上下文溢出错误 | 触发强制压缩并重试一次成功；总尝试次数不超限 |
| `hysteresis` | 压缩后立即再要压缩 | 返回 `already-compacted`，不产生第二次模型调用 |
| `context-read-paging` | 压缩后 `context_read` 分页 | 原文逐字一致、`nextOffset` 正确、越界返回 `invalid-range` |
| `temporary-no-compact` | `temporary:true` | 不提供 `context_compact`，不落 archive |
| `compact-usage-reported` | 任意压缩 | 发出 `phase:'compact'` 的 usage 事件，数值与摘要器返回一致 |

### 8.3 真实评测集（行为验证，不只看字面）

**先立一条纪律**（txt §7 最后一段）：字符串级契约测试只用来判定**结构性**问题（工具是否存在、参数是否在枚举里、两轮 payload 是否逐字节相同），它们**不能**证明模型会照着做。凡涉及「模型是否遵守」的，一律用真实模型跑任务集，不能以「提示里有这句话」作为通过依据。§8.1/§8.2 的用例全部属于结构判定；下面的七项属于行为判定。

按 txt §7 建立固定任务集，每个模型/入口（ChatMova、CodeMova、Edge）分别跑基线与改进版：

| # | txt 指标 | 怎么测（可执行口径） | 通过标准 |
|---|---|---|---|
| 1 | **规则遵循** | 预置冲突场景：项目规则写「不要改 schema」，当轮用户说「改一列」；再反向一次 | 按设计优先级处理（当轮要求覆盖项目规则）且**在回复中说明覆盖了哪条规则**；不出现静默违反 |
| 2 | **长对话保持** | 20/50/100 轮三个长度，第 3 轮埋一条约束（「不要改数据库」），中途不再重复 | 最后一轮仍遵守；压缩开启/关闭各跑一次，差异即压缩的损失 |
| 3 | **记忆召回** | 12 个探针任务：6 个与已存记忆强相关、6 个无关 | 相关召回率 ≥ 基线；无关任务**不**出现记忆注入（避免「到处搜」） |
| 4 | **工具准确率** | 每类工具 20 次调用（`memory_search`/`memory_read_source`/`mcp_call`/MCP 参数/Edge 等待） | 首次调用成功率；参数错误率；P0 修复后 Edge 等待与 MCP 的失败应趋近 0 |
| 5 | **浏览器行动率** | 10 个「明确要求操作网页」的任务（打开/搜索/填表/比价）+ 10 个「只问信息」的任务 | 前者必须真的调用浏览器工具（不能拿链接代替）；后者不得无谓操作 |
| 6 | **恢复正确率** | 在工具调用中途强杀（超时/断网），点重试 | 不重复已完成的副作用动作；`unknown` 动作先观察再决定；恢复后继续而非重来 |
| 7 | **速度和成本** | 首字时间、总轮时长、模型调用次数、实报 token（input / cacheRead / output / cost） | 压缩开启后长任务的 input token 明显下降；**压缩自身开销单独计一列**，不得摊进正文 |

记录表必须分列 `estimated` 与 `actual`（见 §6 与 §8.4），否则会重犯 txt 指出的口径错误。

按阶段分组跑：
1. **S1 后**：只跑第 4、5 项（契约修复的直接收益）。
2. **S3 后**：跑第 2、7 项（压缩的效果与代价）。
3. **S4 后**：跑第 1、3、6 项（分层与目标协议的行为影响）。

### 8.4 口径纪律（避免重犯 txt 指出的对比错误）

项目里已有 `Mova上下文注入实测.md`，方法是拦截 Mova 发出的请求体、用字符估算 token。这个口径**只能用来分析 Mova 自身的组成比例**，不能用来与其它产品的实报值比倍数——txt 已明确指出「口径不同，不宜据此认定 Mova 实际成本或速度领先多少」。

本方案据此定三条规矩：

1. 任何 token 数字必须标注来源：`estimated`（本地估算 / 校准后估算）或 `actual`（provider 返回的 `usage.*`）。**两者不得相减、不得相除、不得混入同一张表的同一列。**
2. 跨产品比较只用 `actual`，且必须同模型、同任务集、同输出长度档位；比较不出结论时就写「不可比」。
3. 那份实测脚本里已经出现过「全能力模拟 ≈58,225 字符 / 58 个工具」的数字，它描述的是**模拟配置下的请求体积**，不是任何真实用户的开销，也不代表 token。后续文档引用时必须带上这句限定，或干脆只报比例不报绝对值。

---

## 9. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 摘要把关键约束压没 | 长任务、约束分散 | 约束永不进压缩区间（§4.4 P3 + `constraints` 钉住）；`context_read` 可回查；S3 先在内部会话跑一周再默认开启 |
| 摘要调用本身烧钱/拖慢首字 | 长任务每轮逼近阈值 | 每次压缩一次调用 + 滞回；摘要输入只含被淘汰段；`maxTokens:2500`；超时 45s 降级确定性 |
| 压缩引入新延迟尖峰 | 首字时间突增 | 压缩在**发送前**执行一次，之后一轮内只做占位裁剪；面板显示「本轮压缩耗时」，可关 |
| 归档占盘 | 超长会话 | 每会话 archive 上限 20 MB / 30 天，超限按 span 淘汰最旧；备份沿用 memory 目录策略 |
| 前缀缓存收益不达预期 | provider 不支持 | `promptCache` 能力表 + `cacheRetention:'none'` 回退；压缩省下的 token 本身已是收益 |
| 提示分层破坏既有断言 | S4 重构 | 旧 `buildSystemPrompt` 保留为 legacy 分支；`tests/agent-prompt.test.mjs`、`edge-browser-prompt.test.mjs` 必须继续通过（可新增断言，不可删除） |
| 运行中替换上下文踩库的坑 | 误用 `state.messages` | 只用 `transformContext` / `prepareNextTurn`（§2.2 事实 C），禁止运行中改 `state.messages`；代码评审红线 |

---

## 10. 决策记录与仍需确认的点

### 已确定（本轮答复）

1. **摘要生成**：每次压缩调用一次 LLM 摘要；确定性抽取作为失败回退与校验骨架。
2. **交付范围**：本次只交付本方案文档，不改代码。
3. **被压缩原文**：完整保留（UI + archive），并提供 `context_read` 回查。
4. **自动压缩**：默认开启，阈值 70%（硬上限 85%，滞回 8 条消息 / 4000 tokens）；**目标协议改为按复杂度启用**。

### 仍需你拍板（不影响 S0–S2 开工，但影响 S3/S5）

- **Q1 摘要模型**：默认跟随当前对话模型，还是单独配一个便宜的摘要模型？（默认跟随会多花一份主模型的 token；单独配需要新增一个设置项与 key 校验。）
- **Q2 压缩可见性**：压缩要不要在对话时间线上留一条可折叠的「已压缩 N 条消息 · 点开看摘要/原文」卡片？还是只放进侧面面板？（留卡片更透明，但会让时间线变长。）
- **Q3 自动压缩的默认生效范围**：全部会话默认开，还是先只在 CodeMova（有项目文件、任务更长）开，ChatMova 保持只读提示？
- **Q4 归档保留期**：30 天 / 永久 / 跟随备份策略？（默认按 30 天 + 上限 20 MB。）

---

## 附录 A：与 txt 的对照清单（逐条落地位置）

| txt 条目 | 本方案位置 |
|---|---|
| §3.1 记忆搜索 `source` | P0-1 |
| §3.1 Edge 等待参数 | P0-3 |
| §3.2 MCP 缺 schema | P0-4 |
| §3.3 长对话截取 / 分层压缩 | §4 全章、P1-1、P1-2 |
| §3.4 中断恢复证据 | P0-5（含渲染端副本） |
| §3.5 项目规则与运行状态混杂 | §4.2、P1-4、P1-5 |
| §3.6 目标协议往返 | P1-6 |
| §4 记忆三层召回 | P2-2 |
| §5 缓存 | P1-4、P2-4 |
| §6 优先级表 | §5 与 §7 的两张表 |
| §7 验证方法 | §8 |

## 附录 B：本方案新增的缺陷（txt 未覆盖）

| # | 缺陷 | 位置 | 方案 |
|---|---|---|---|
| ★1 | `memory_read_source` 缺 `mode` | `chat-agent.mjs:1137-1145` vs `agent-memory-search.cjs:139` | P0-2 |
| ★2 | 单轮内工具结果无压缩通路，超限直接终止 | `chat-agent.mjs:23-24, 1244-1247` | P1-3 |
| ★3 | 渲染端预算计算是死代码，UI 与实发不一致 | `app.js:2706` vs `:2719` | P0-6 |
| ★4 | 渲染端中断摘要同样按工具名去重 | `app.js:2661-2668` | P0-5 |
| ★5 | 项目规则三处 4000 上限且静默截断 | `index.html:526`、`project-data.js:17`、`chat-agent.mjs:799` | P1-5 |
| ★6 | `cacheRetention:'none'` 是显式关闭两家缓存，而非「可能有缓存」 | `chat-agent.mjs:752` + 依赖实现 | P1-4、P2-4 |

## 附录 C：txt 逐条自检清单（含每一条「建议」的落点）

这张表是给你核对用的：txt 里每一句「缺陷」和每一个「建议」都在这里，右侧是本方案的落点。若你认为某一行落点不对，直接指出来，我改方案。

### C.1 第一节（对比表）里隐含的能力缺口

| txt 位置 | 原文要点 | 落点 |
|---|---|---|
| §一 项目规则行 | 没有自动发现项目规则文件；只有一段 4000 字符设置文本 | P1-5（第 2 项：`.mova/rules/*.md` + `AGENTS.md` 兼容 + 路径作用域） |
| §一 记忆行 | 主要依赖模型自行决定何时检索 | P2-2（L0/L1 索引层） |
| §一 技能与工具行 | 没有「先给名称描述、相关时再读全文」的技能机制 | P2-3 |
| §一 长对话行 | 只保留最近消息 + 首尾摘录 | §4 全章、P1-1、P1-2 |
| §一 上下文可见性行 | 有模型用量，但没有「本次发给模型了什么」的视图 | P2-1 |

### C.2 第二节（做得比较好的地方）——**这些是保留项，改造时不许改坏**

| txt 原文 | 本方案的约束 |
|---|---|
| 浏览器、桌面、设计等能力按会话条件提供 | §4.2 L2 保留条件注入，只是文案改为由工具清单生成（P0-3） |
| MCP 没有把所有工具完整定义直接放进每次请求 | P0-4 **不能**退化为「全量塞 schema」；必须走 `mcp_tool_info` 按需拉 |
| 长期记忆默认不整批塞进提示，通过工具按需搜索 | P2-2 只加「索引层 ≤300 tokens」，正文仍按需 |
| 当前用户消息超过上限时报错，不悄悄截断 | §4.4 P2 明确「永远逐字发送，超长仍报 `input_too_long`」；§8.1 有 `no-silent-truncation` 用例守住 |

### C.3 第三节 六条缺陷 + 每条内的全部「建议」

| txt 位置 | 原文要点 | 落点 |
|---|---|---|
| §3.1-a | `memory_search` 提示有 `source=history`，参数没有 | P0-1 |
| §3.1-b | Edge `browser_wait` 暴露的参数枚举不含 `download`/`time` | P0-3 |
| §3.1-建议 1 | 以实际工具能力为准修正提示，或把缺失能力接入工具 | P0-3（两手都做：`time` 补进扩展、`download` 明确标为不可用） |
| §3.1-建议 2 | 增加「提示中提到的工具及参数是否真实存在」的契约测试 | S0 + §8.1 `prompt-tool-consistency` |
| §3.1-建议 3 | Edge 与内置浏览器分别维护能力说明，不共享一段不完全适用的提示 | P0-3（按面各自生成，且 §8.1 双向断言） |
| §3.2 现象 | `mcp_search` 不返回 `inputSchema`；`mcp_call` 收开放 `arguments` | P0-4 |
| §3.2-建议 1 | `mcp_search` 保持精简（名称/用途/ID） | P0-4 第 2 步（只加 `required` 字段名，不加全文 schema），并有体积守卫测试 |
| §3.2-建议 2 | 增加按需查看工具详情，返回当前参数 schema | P0-4 第 3 步 `mcp_tool_info` |
| §3.2-建议 3 | 调用前按真实 schema 校验，并返回明确的缺失字段 | P0-4 第 3 步（最小校验：`required`） |
| §3.2-建议 4 | 缓存已确认的工具详情，工具变化时失效 | P0-4（`(id, schemaHash)` 缓存，`mcp-manager.cjs:118` 路径失效） |
| §3.3 现状 | 100 条 / 60,000 字符 / 前 4 后 8 条 / 250 字符 / 4,000 字符摘录 | §2.1 现状图 + §3 校正表 + P1-1 替换口径 |
| §3.3 问题 | 重要决定发生在很早的中间位置，正好被丢掉 | P1-2（验收用例就是 txt 举的「第 30 轮不要改数据库」） |
| §3.3 问题 | 字符预算不是按模型真实 token 窗口分配 | P1-1 + §6（分词校准） |
| §3.3-建议 1 | 固定保留：当前用户需求、明确限制、已批准范围 | §4.2 L6 + §4.4 P2/P3 + P0-5（已批准范围来自审批记录） |
| §3.3-建议 2 | 结构化任务摘要：已完成、验证证据、未完成、待用户决定 | §4.3 `summary` schema 的 `done/open/decisions` + §4.5 提示词 |
| §3.3-建议 3 | 最近对话保留原文 | §4.4 P1（`keepLast`） |
| §3.3-建议 4 | 旧证据保留可回查的引用，而不是零散首尾 | §4.3 `archive` + §4.6 `context_read` + `facts[].source` 强制带来源 |
| §3.3-建议 5 | 按窗口/输出预留/工具结果为各部分设预算 | §4.4 ① + §4.3 分层预算表 |
| §3.3-建议 6 | 接近预算时触发摘要，而不是每次请求都重新摘要 | §4.4 ③ + §4.7（滞回：8 条 / 4000 tokens） |
| §3.3-尾注 | 摘要可能出错，应保留来源并允许回查，不能当事实 | §4.5（`source:'llm'\|'deterministic'` 明写）+ §4.6 提示末句「摘要是派生物，不是证据」+ `context_read` |
| §3.4 现象 | 只记工具名、按名聚合、恢复提示只列名字 | P0-5（并指出 `id/detail` 其实在 emit 层就存在） |
| §3.4-建议 字段 | 动作 ID / 工具名 / 目标摘要 / 结果三态 / 关键结果或验证证据 / 后续步骤 | P0-5 的 `ActionRecord` 六字段逐一对齐 |
| §3.4-建议 安全 | 不默认保存密码、完整页面内容或敏感参数 | P0-5（`redactSensitive` + 只存动作摘要） |
| §3.4-建议 未确定 | 「可能已执行但未确认」的动作，恢复时先检查状态再决定 | P0-5（`unknown` 分组 + 与 `:1217` 的 `outcome:"unknown"` 约定一致） |
| §3.5 现象 | 项目规则 ≤4000 字符；目标/摘录/恢复都拼进同一 system | P1-5、P1-4、§4.2 |
| §3.5-影响 1 | 用户项目规则与产品级规则不容易区分 | §4.2 L1/L2/L3 分层 + P1-5 第 4 项（来源标注） |
| §3.5-影响 2 | 目标/摘录一变，前缀也变，影响缓存 | P1-4 + §4.2「L6 放最末」+ P1-4 工具声明稳定性 |
| §3.5-影响 3 | 冲突时难告诉用户是哪条规则产生的影响 | P1-5 第 4 项（`overrides` 事件 + 面板显示生效规则 id） |
| §3.5 六层表 | 产品基础 / 当前能力 / 用户与项目规则 / 当前任务状态 / 历史与记忆 / 本轮输入 | §4.2 六层一一对应（L1/L2/L3/L6/L4/L5），仅调整了顺序以利于缓存 |
| §3.5 尾注 | 不同模型接口角色能力不同，应通过适配层映射 | §4.2 新增「消息角色必须走适配层」条目 |
| §3.6 现象 | 多步骤即要求 `set_goal`/`accept_goal` | P1-6 |
| §3.6-建议 1 | 简单短时任务直接执行 | P1-6 新提示文案第一句 |
| §3.6-建议 2 | 需要持续推进/跨轮恢复/用户要求跟踪时才启用 | P1-6 新提示文案（三个判据） |
| §3.6-建议 3 | 已有目标继续维护，不重复创建 | 保留现有 `aimDigest`（`chat-agent.mjs:56-72`「do not create it again」），P1-6 不改坏 |
| §3.6-建议 4 | 用真实任务比较总耗时/完成率/遗漏率 | §8.3 第 1、7 项 + §8.3「按阶段分组」 |

### C.4 第四节（记忆）与第五节（缓存）

| txt 位置 | 原文要点 | 落点 |
|---|---|---|
| §4 三层 | 用户固定偏好 / 项目简短索引 / 详细历史按需 | P2-2（L0/L1/L2） |
| §4 每条记忆 | 带来源、时间、项目范围、可编辑入口 | P2-2（补 `updatedAt`/`editable`） |
| §4 覆盖规则 | 当前任务中的明确新要求应能覆盖旧偏好 | P2-2 边界 1（并在回复/面板说明被压制的记忆 id） |
| §4 边界 | 记忆开关和临时聊天的现有边界继续生效 | P2-2 边界 2、3 |
| §5 现状 | `cacheRetention:'none'` | P1-4（并纠正为「显式关闭」，见 §3 校正表末行） |
| §5-建议 1 | 稳定基础指令、工具定义的内容和顺序 | P1-4 新增「工具定义内容与顺序必须稳定」三条 |
| §5-建议 2 | 避免把每轮变化的目标摘要放在稳定前缀中间 | §4.2 L6 放最末 |
| §5-建议 3 | 针对不同服务商分别检查缓存参数与兼容性 | P1-4（`promptCache` 能力表）+ P2-4 |
| §5-建议 4 | 用 `cacheRead`、首字时间、总耗时比较 | §8.3 第 7 项（分列列名） |
| §5-建议 5 | 不支持缓存的服务商保持兼容回退 | P1-4（`'none'` 回退） |
| §5 关于对比报告 | 口径不同，不宜据此认定成本/速度领先；58,225 字符/58 工具是模拟配置体积 | §8.4 口径纪律（三条规矩 + 引用限定语） |

### C.5 第六节（优先级）与第七节（验证）

| txt §六 优先级 | 落点 |
|---|---|
| P0 修 `memory_search source` 与 Edge 等待参数 | P0-1、P0-3 |
| P0 MCP 按需查看参数 schema | P0-4 |
| P0 中断恢复记录区分已完成/失败/未确定 | P0-5 |
| P1 系统提示、项目规则、任务状态、历史分层 | §4.2、P1-4、P1-5 |
| P1 结构化任务摘要替代首尾摘录 | P1-2、§4.4、§4.5 |
| P1 目标协议按复杂度启用 | P1-6 |
| P2 记忆索引 + 按需读取 | P2-2 |
| P2 项目规则文件与目录作用范围 | P1-5 第 2 项（实现排在 P2 阶段执行） |
| P2 上下文检查面板和缓存诊断 | P2-1、P2-4 |

| txt §七 验证指标 | 落点 |
|---|---|
| 规则遵循 | §8.3 第 1 项 |
| 长对话保持（20–100 轮） | §8.3 第 2 项 |
| 记忆召回 | §8.3 第 3 项 |
| 工具准确率 | §8.3 第 4 项 |
| 浏览器行动率 | §8.3 第 5 项 |
| 恢复正确率 | §8.3 第 6 项 |
| 速度和成本（首字/总耗时/调用次数/实报 token/缓存命中） | §8.3 第 7 项 + §8.4 口径纪律 |
| 「不能只检查某句话是否存在」 | §8.3 开头「先立一条纪律」 |

### C.6 覆盖情况小结

- txt 明确列出的**缺陷 6 条**：全部进入 P0（4 条）与 P1（2 条），无遗漏。
- txt 给出的**建议 30 余条**：逐条落在上表，无遗漏；其中 §3.1-建议 1 与 §5-建议 1 属于「加倍执行」（既修实现也建测试/常量表）。
- 本方案**新增** txt 未提的缺陷 6 条（附录 B），其中 ★2、★3 会改变用户可见行为，需在 S1/S2 阶段一并告知。

