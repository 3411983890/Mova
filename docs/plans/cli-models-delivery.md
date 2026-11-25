# CLI 模型 · 并行开发交付报告（完结版）

> 日期：2026-11-13 ｜ 版本：**三轮并行交付，完结** ｜ 统筹：本会话主持智能体
> 依据：[Mova-CLI模型-开发文档.md](Mova-CLI模型-开发文档.md)、[Mova-Gemini后台执行-前端接入方案.md](Mova-Gemini后台执行-前端接入方案.md)、[Mova上下文压缩与Agent上下文工程方案.md](Mova上下文压缩与Agent上下文工程方案.md)、原型 [cli-models-settings.html](../prototypes/cli-models-settings.html) / [schema-form-card.html](../prototypes/schema-form-card.html)
> 复验入口：`node scripts/accept.mjs`（一条命令跑测试 + 构建 + 类型检查，失败项与基线比对）

---

## 0.000 热修 3：模型现在真的能「压缩上下文」了（2026-11-13 第三次真机反馈）

**现象**：用户问 Mova 里的 Agent「能不能压缩上下文」，Agent 回答「不能」。

**这是对的**——查代码发现三个工具在 `chat-agent.mjs` 里出现 **0 次**：

```
context_status  → 0
context_compact → 0
context_read    → 0
```

压缩引擎（`budget/ledger/digest/summarize`）写好了、有测试，但**只由环境变量开启、且默认 `off`**，模型完全不知道它存在。所以它只能老实说不能。

### 现在补上的东西

| 文件 | 作用 |
| --- | --- |
| `electron/context/pending.mjs` | 会话级「待生效压缩」：一次性、带 TTL、按 key 隔离 |
| `electron/context/tools.mjs` | 三个工具的定义 + 处理器（status / compact / read），description 明确写「何时该调」 |
| `electron/chat-agent.mjs` | 把三个工具注册给模型；每轮开始消费 pending；无会话 key 时不暴露 |

**为什么压缩「下一次请求才生效」**：一次请求的历史在发出前就组装完了，中途改不了已经发出的 payload。所以工具只承诺下一次生效，并在回复里明确告诉用户——比假装当场生效诚实。

**为什么用 `coveredCount` 而不是 `coveredIds`**：`context_compact` 压的永远是**最旧的一段**，而下一轮 `buildHistory` 会按字符/条数预算重新切片，位置 id 会漂移；「替换开头 N 条」在窗口滑动时仍指向更早的历史，语义正确。

**保留边界**：至少留最新两条（一问一答），绝不把整段历史压没。

### 三个工具的分工

- `context_status`：报当前占用/百分比/六层分解/可压缩条数。**免费读**，让模型不用猜。
- `context_compact`：压最旧一段 → 写 pending → 下一次请求生效。允许 `keepRecent` 4–30。
- `context_read`：分页读回原文（最多 6000 字符/次），并在首行给 `nextOffset`。摘要只是笔记，不是证据——工具描述里明确要求「不能只凭摘要断言某次改动」。

### 新增测试（7 个）

模型能看到三个工具、无会话 key 时不暴露、描述含触发条件、`applyPendingCompaction` 的替换与边界、**两次请求验证「压过之后下一轮真的带摘要且只生效一次」**、跨会话隔离。

**验收：1501 例 / 1495 通过 / 失败 3（基线）、构建 32.33s、类型检查通过、启动 13s 存活。**

> 仍需你决定的一项：模型主动压缩现在走**确定性抽取**（`source:'deterministic'`）。若要走 LLM 精修，把 `MOVA_CONTEXT_SUMMARY=llm` 打开即可——但那是**自动通路**；「模型主动 compact」这条线还没接 summarizer（改动很小，tools.mjs 多传一个 `summarize`）。

---

## 0.00 热修 2：登录真的能成功了（2026-11-13 第二次真机反馈）

**现象**：授权后浏览器跳 `127.0.0.1` 显示「拒绝连接」，Mova 面板停在「授权没有完成」。

定位到**两个**独立缺陷，都是我的代码：

### 缺陷 1（致命）：换 token 用错 `client_id`

`completeFlow` 把回调里的 `client_id` 丢掉了：
```js
const { code } = parseCallback(...);                 // ❌ 只取了 code
exchangeCode({ ..., clientId: CHATGPT_CLIENT_ID });  // 恒用 'dynamic_agent_client'
```
而首次登录我们发的是 `dynamic_agent_client`，**OpenAI 会动态注册出 `oaiapp_…` 并在回调里带回来**（t3code 与 harness 插件都用它）。仍拿固定值去换 token → `invalid_client` → 登录必失败。

修复：取回调的 `client_id`（缺失才回退固定值），并落库供刷新复用；`flow` 增加 `clientId` 槽位。

### 缺陷 2：响应被自己的 `closeAllConnections()` 掐断

旧 `onCallback` 在**写响应之前/同时**调 `finishFlow()`，而它内部 `server.closeAllConnections()` 会连带干掉正在写的那条连接：

| 路径 | 旧行为 | 浏览器看到 |
| --- | --- | --- |
| 成功 | `sendHtml` → `finishFlow`（强关） | 可能被截断 |
| 失败 | `failFlow`（强关）→ `sendHtml` | **ECONNRESET** → 「拒绝连接」，真实原因被藏起来 |

实测证据：`scripts/probes/.probe-callback-tcp.cjs` 修复前是 `tcp: connected / http: ECONNRESET / fetch: ECONNREFUSED`，修复后是 `http: 200 + 完整 HTML`。

修复：`closeServer` 默认**不再** `closeAllConnections()`（只有取消/退出才 force）；`onCallback` 改成**先发响应，再在 `res.once('finish')` 里收尾流程**。

### 缺陷 3（顺带补的兜底）：浏览器可能根本到不了 127.0.0.1

系统代理把回环也转发、VPN 接管路由、防火墙拦随机端口时，回调页永远打不开。新增**手动完成登录**：
- 通道 `subscription:login:complete`（`CHANNELS.completeLogin`）
- 登录面板里一个折叠项「浏览器显示「拒绝连接」？手动完成」→ 粘贴地址栏整条链接 → 完成登录
- 同样校验 `state`，安全性不降级；也接受只粘 `code`

### 回归测试（新增 7 个）

| 用例 | 锁住什么 |
| --- | --- |
| 成功响应体完整（含 `</body>`） | 响应不被截断 |
| 失败响应体完整（含「登录失败」） | 失败原因可见 |
| 换 token 用回调返回的 `client_id` | 缺陷 1 |
| 回调没有 `client_id` 时回退固定值 | 兼容性 |
| 手动完成登录成功 + 落盘 | 缺陷 3 |
| 手动完成 state 不符被拒 | 安全性 |
| 无进行中 flow 时手动完成不挂起 | 边界 |

**验收：1469 例 / 1463 通过 / 失败 3（基线）、构建 15.89s、类型检查通过、启动 13s 存活。**

> 说明：`scripts/probes/.probe-close-all.cjs` 那个隔离实验**没有**复现截断（时序相关），所以缺陷 2 的证据取自真实 Electron 的 TCP/HTTP 探测（`probe-callback-tcp`），而不是那个玩具实验。

---

## 0.0 热修：登录必失败「凭据存储不可用」（2026-11-13 真机反馈）

**现象**：设置页点「添加 ChatGPT 账号」，弹「授权失败 / 凭据存储不可用 / 授权没有完成，可以重试或换一个账号」。

**根因**：`electron/subscription/ipc.mjs` 的加密闸门写成了同步比较：
```js
return safeStorage.isAsyncEncryptionAvailable() === true;   // ❌
```
而 **Electron 45 的这个方法返回 `Promise<boolean>`**。`Promise === true` 永远为假，于是 `assertWritable()` 每次都抛 `credential`，登录在写凭据之前就被挡住——和用户看到的三个字样完全对应。

**同一个坑还有第二处**（虽然 store 已经兜住）：异步 API 的真实返回形状是
| 方法 | 真实返回 |
| --- | --- |
| `isAsyncEncryptionAvailable()` | `Promise<boolean>` |
| `encryptStringAsync(text)` | `Promise<Buffer>`（不是 `{ result }`） |
| `decryptStringAsync(buffer)` | `Promise<{ shouldReEncrypt, result: string }>` |

`store.mjs` 的 `unwrap()` 已经会拆 `{ result }`，所以解密没问题；`encrypt` 直接拿到 Buffer 也正确——**唯一的 bug 就是没 await**。

**修复**：`encryptionAvailable()` / `assertWritable()` 改为异步并兼容两种形态（Promise 与旧的同步 boolean），5 个调用点补 `await`。

**为什么测试没抓到**：两个测试文件的假 `safeStorage` 返回的是**同步 boolean** 与 `{ result: Buffer }`，比真实 API「更宽松」，于是 `=== true` 在测试里成立。已把假对象改成与 Electron 45 完全一致，并补 3 个回归用例（`Promise<true>` / 旧同步 boolean / `Promise<false>`）。

**真机验证**（真实 `safeStorage`，不开浏览器）：装 IPC → `settingsSet` 写成功 → `logout(未知账号)` 返回 `not_configured`（不再是 `credential`）→ `list()` 返回空列表不抛。结论 PASS。诊断脚本：`scripts/probes/.probe-subscription-gate.cjs`。

---

## 0.1 第四轮增量（剩余四块收尾）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| **Mova 工具经 MCP 暴露** | `electron/mcp/tools.mjs`（12 个工具 + 按需发现，只列有 handler 的工具）+ `electron/mcp/server.mjs`（JSON-RPC over HTTP，Bearer 鉴权、127.0.0.1、1MB 上限、timingSafeEqual）；`chat-agent.mjs` 的 `buildMovaHandlers` 把读/写/搜索/记忆/提问/目标/计划包成工具，**写操作先过审批 + 路径白名单** | 30 例通过 |
| **MCP 注入契约** | `engine.mjs` 的 `mcpServers` 支持**函数形态**：等 `initialize` 拿到 `agentCapabilities.mcpCapabilities.http` 再决定挂不挂；挂不上只发 warn notice，不阻断对话 | 4 例通过 |
| **LLM 摘要器** | `electron/context/summarize.mjs`（结构化 JSON、`facts` 无 `source` 自动降级进 `open`、重试 1 次、失败回退确定性）；`wiring.mjs` 改为**异步**，`chat-agent` 加 `createContextSummarizer` 适配层（把 `fetchModel(url,init)` 桥成一次性补全） | 23 例通过 |
| **服务版登录** | `subscription-service.mjs` 加 flows（`consumeFlow` 用单条 `delete ... returning` 保证一次性）；`services/subscription-login.mjs` 服务端 OAuth 编排，`nonce` 由 `sha256('mova:nonce:'+state)` 派生（表无 nonce 列） | 51 例通过 |
| **Gemini 多账号** | `ipc.mjs`：按真实 `accountId` 落库（同账号覆盖）、`listAll` 全列、`refresh` 分批并发 3 + `allSettled` 单账号隔离、`select/logout` 按账号、`noProject` 不重试 | 19 例通过 |

**第四轮验收：1426 例 / 1420 通过 / 失败 3 项（同一批基线）、构建 19.96s 通过、类型检查通过、ESLint 0 error、Electron 启动 14s 存活无报错。**

第四轮修正（由统筹者做）：

1. **`applyContextLedger` 同步 → 异步**：摘要器 agent 指出同步函数拿不到 LLM 正文（异步结果只能作废回退）。改为 `async` 并 `await` 调用点后，LLM 摘要真正生效；同时更新 3 个按同步版写的测试。
2. **`path` 标识符冲突**：`buildMovaHandlers` 里用 `path.resolve` 与工具参数名 `path` 冲突，统一改名为 `nodePath`。
3. **`electron/chat-agent.mjs` 新增 `node:fs/promises` / `node:path` 顶层 import**：MCP 工具的读写与路径校验需要。

---

## 0.2 第三轮增量

| 项 | 内容 | 验收 |
| --- | --- | --- |
| **内置订阅 provider** | `providers.cjs`：`subscription:chatgpt` / `subscription:gemini` 恒在最前，`kind`/`subscriptionProvider` 不再被剥掉，`resolveModel` 能命中，`loadProviderKey` 返回 `''` 不抛，`save/remove` 拒绝改删内置项 | 16 例通过 |
| **Gemini 登录** | `subscription/gemini-login.mjs`：`readGeminiToken` + `loginGemini`（找 CLI → 私有 profile → `auth login` → 轮询 `acp_token.json` → accountId 指纹），`ipc.mjs` 的 gemini 分支接上 | 19 例通过 |
| **P0-1/2/3** | `memory_search.source`、`memory_read_source.mode`、Edge 等待条件由 `browser/prompt.cjs` 的 `capabilitySentence` 从工具枚举生成（不再手写 `for=`） | 13 例通过 |
| **P0-4** | `mcpCatalog` 带 `inputSchema`（进程内不发模型）；`mcp_search` 只给 `hasSchema`/`required`；新增 `mcp_tool_info`（6000 字符截断）；`mcp_call` 缺必填**不发 IPC** | 12 例通过 |
| **P0-5** | `model-ipc.cjs` 把 `{name,status}` 升级成 `ActionRecord`（actionId/target/result/evidence，脱敏，≤20 条）；`chat-agent.mjs` 的恢复提示改成 `✅/❌/❓` 三组 + 「先观察再决定」强制指令 | 13 例通过 |
| **渲染端** | notice 行（不进 timeline、切会话即清）、`context` 上报只存不画（P0-6 死代码已删）、`#form-card-host` + `window.movaShowFormCard` 懒挂载入口 | 8 例通过 |
| **服务版** | `db/migrations/006_subscription.sql`（三表四索引、30 天审计）+ `services/subscription-service.mjs`（AAD 绑定租户/账号，越权搬密文必失败） | 25 例通过 |

**第三轮验收：1323 例 / 1317 通过 / 失败 3 项（同一批基线）、构建 17.60s 通过、类型检查通过、ESLint 0 error、Electron 启动 14s 存活无报错、设置页仍正常渲染。**

两处修正（由统筹者发现并修）：

1. **`runAcpSubscriptionTurn` 漏传 `asks`** —— ACP 支路里 `asks.ask(...)` 会抛 `ReferenceError`，ESLint 的 `no-undef` 抓到了。已补参数，同时去掉未使用的 `mcpManager`。
2. **`app.js` 的 `applyAimEvent` 把「非 goal」当 plan** —— 新增的 `context` 事件会**误清空用户计划**。已加类型守卫并写路由回归测试。

一处文档失真（已核实）：

- 方案 §5 P0-5 的 ★ 项说「渲染端副本 `app.js:2661-2668` 同步改造」。经比对改动前快照，`app.js` 里的 `actions` 全是 DOM 容器（`project-row-actions` / `provider-actions`），**根本不存在动作记录副本**。该项不适用，无需同步。

---

## 1. 验收结论

| 门槛 | 基线 | 现在 | 结论 |
| --- | --- | --- | --- |
| `node --test` | 3 项既有失败 | **1426 例 / 1420 通过 / 失败 3 项**（同一批） | ✅ 零新增失败 |
| `npm run build` | 612 模块 / 6.44s | 通过 / 19.96s | ✅ 通过 |
| `npm run typecheck` | 通过 | 通过 | ✅ 通过 |
| `npx eslint`（新增/改动文件） | — | **0 error**（仅 warning） | ✅ 通过 |
| Electron 启动 | 正常 | 14s 存活、无订阅/MCP 相关报错 | ✅ 通过 |
| 设置页真实渲染 | — | 6 段 / 7 条额度条 / `data-source="demo"` 回退 | ✅ 通过 |

已知失败 3 项（**既有，非本次引入**，不建议在本轮修）：`scripts/popup-test.cjs`（被 `node --test` 误扫的脚本）、`tests/markdown-transcript.test.mjs`、`tests/trace-rows.test.mjs`。
> 另有一项既有 flaky：`compaction keeps the newest N messages…` 偶发失败、复跑即过，与本次改动无关。

---

## 2. 并行策略（为什么没有互相写坏）

1. **先定契约再派活**：`electron/subscription/contract.mjs` 是唯一取值来源（通道名、错误码、状态值、`isAvailable`/`effectiveState`），所有 agent 都 import 它，不允许写字面量。
2. **文件所有权互斥**：每个 agent 拿到一份独占文件清单 + 一份「绝对不要碰」清单；单体文件（`app.js`/`index.html`/`chat-agent.mjs`/`preload.cjs`/`main.cjs`）**只由统筹者或单点 owner 修改**。
3. **新功能一律独立模块**：渲染层新功能做成 `src/features/*` 下的自包含组件，单体只加 1–3 行接线；主进程新功能一律 `.mjs` 新文件。
4. **无 git 的安全网**：仓库不是 git 仓库，动手前做了完整快照 `.code-backups/before-cli-models-20261113-175232/`（784 文件 / 37MB）。
5. **每次交付即验证**：单模块测试 → 全量测试 → 构建 → 真实渲染/启动，四道闸。

失败与补救：第一波 5 个 agent 中 3 个因任务过大失败（ACP/表单卡/上下文台账）；把每个拆成「1–2 个文件」的小任务重派后全部完成，`electron/acp/engine.mjs` 由统筹者亲自实现。

---

## 3. 交付清单

**总计：新增 32 个源文件 + 25 个测试文件 + 2 个验收脚本；改动 9 个既有文件。**

与改动前快照逐行比对的净变化（`+新增 / −删除`）：

| 文件 | 变化 | 说明 |
| --- | --- | --- |
| `index.html` | +5 / −0 | 纯追加：导航项 + 页面容器 + `#form-card-host` |
| `electron/preload.cjs` | +18 / −0 | 纯追加：`subscription` 命名空间 |
| `electron/main.cjs` | +14 / −0 | 纯追加：1 行 require + 1 处 try/catch 装配 |
| `app.js` | +83 / −6 | notice 拦截、上下文上报、FormCard 宿主、`applyAimEvent` 类型守卫；**删除的是 P0-6 确认的死代码**（`buildContextHistory` 那段只喂提示的计算） |
| `electron/chat-agent.mjs` | +226 / −15 | ACP 支路、`applyContextLedger`、P0-1/2/3/4/5；删除的是被替换的旧提示文案与旧工具描述 |
| `electron/model-ipc.cjs` | +226 / −8 | 订阅 Gemini 判定与 ACP 入参解析、`ActionRecord` 聚合；删除的是旧的 `{name,status}` 聚合 |
| `electron/providers.cjs` | +80 / −2 | 内置订阅 provider、保留 `kind`/`subscriptionProvider`、订阅分支 |
| `electron/services/agent-memory-search.cjs` | 微改 | P0-1 的 `source !== 'memory'` 回退守卫 |
| `src/services/mova-client.ts` | +15 / −2 | 新增 `ContextEvent`，把它纳入 `StateEvent` |
| `src/features/chat/chat-reply.ts` | 微改 | `isStateEvent` 增加 `context` |

| 目录 | 新增 |
| --- | --- |
| `electron/subscription/` | 9 个（contract / store / pool / usage / login / cli / gemini-login / runtime / ipc） |
| `electron/acp/` | 4 个（client / translate / gate / engine） |
| `electron/context/` | 5 个（budget / digest / ledger / wiring / summarize） |
| `electron/mcp/` | 2 个（tools / server） |
| `electron/browser/` | 1 个（prompt.cjs） |
| `electron/services/` | 2 个（subscription-service / subscription-login） |
| `electron/db/migrations/` | 1 个（006_subscription.sql） |
| `src/features/cli-models/` | 7 个（设置页） |
| `src/features/ask/` | 3 个（schema-form / form-card） |
| `src/features/chat/` | 1 个（notice-row.js） |
| `tests/` | 29 个 |
| `qa/` | 3 个（agents-brief.md / accept.mjs / 本报告） |

### 3.1 订阅后端（9 个模块 + 6 个测试，67 例）

| 文件 | 职责 |
| --- | --- |
| `electron/subscription/contract.mjs` | **契约**：`CHANNELS` / `EVENT_KINDS` / `MODEL_SETTING_KEYS` / `SubscriptionError` / `isAvailable` / `effectiveState` |
| `electron/subscription/store.mjs` | 多账号凭据存储：`safeStorage` 加密、原子写、进程内串行 `modify`、`list()` 脱敏 |
| `electron/subscription/pool.mjs` | 多账号调度：优先账号 → 剩余额度最多 → `lastUsedAt`；额度用尽标记、到点自动恢复 |
| `electron/subscription/usage.mjs` | 额度探针与归一：Codex `wham/usage` 双窗口、Gemini 双 host 三类 bucket、`describeReset` |
| `electron/subscription/login.mjs` | OAuth 纯逻辑：PKCE、授权 URL、回调解析、换/刷新 token、ID token 验签、`isUsable` |
| `electron/subscription/ipc.mjs` | 服务层：串起上面四个模块 + 本地回调服务器 + 设置持久化 + 12 个 IPC 通道 + 事件广播 |
| `electron/preload.cjs`（改） | 只追加 `subscription` 命名空间（12 个方法 + `onEvent`） |
| `electron/main.cjs`（改） | 只加 1 行 require + 1 处 try/catch 调用（装配失败只告警） |

### 3.2 ACP 桥（新增 4 个模块 + 3 个测试，45 例）

| 文件 | 职责 |
| --- | --- |
| `electron/acp/translate.mjs` | **纯函数**：ACP update → Mova `StreamEvent`（thinking/text/tool/plan/usage/notice）、提问与审批判别 |
| `electron/acp/client.mjs` | stdio NDJSON JSON-RPC：跨 chunk 半行、逐请求超时、反向请求、协议异常判定 |
| `electron/acp/gate.mjs` | 反向请求闸门：`realpath` 路径白名单、写前审批+diff、终端审批与 8KB 截断、`full` 放行但审计 |
| `electron/acp/engine.mjs` | 会话编排：起进程 → initialize → session/new → prompt → 翻译 → 收尾；中断只 cancel、并发拒绝 |

### 3.3 上下文工程（新增 3 个模块 + 3 个测试，40 例）

| 文件 | 职责 |
| --- | --- |
| `electron/context/budget.mjs` | token 估算（CJK/ASCII/代码/图片）+ 四档阈值 + 滞回 |
| `electron/context/digest.mjs` | 确定性摘要（零随机）+ 摘要块 + 合并 + 紧急占位符 |
| `electron/context/ledger.mjs` | 六层台账 + `compact()` + `read()` 分页回查 + `pinnedConstraints` |

### 3.4 前端（新增 10 个文件）

| 文件 | 职责 |
| --- | --- |
| `src/features/cli-models/cli-models-settings.jsx` 等 7 个 | 「CLI 模型」设置页：六段、账号行、「…」菜单贴右、登录面板、退出确认、额度条、toast |
| `src/features/ask/schema-form.mjs` | JSON-Schema → 字段模型（纯逻辑）：类型映射、校验、取值、超限降级 |
| `src/features/ask/form-card.jsx` / `.css` | 表单卡：紧凑 6 列网格 + 行尾补齐、分段按钮、键值对、数组、降级卡、64KB 限制 |
| `index.html`（改 2 处） | 导航项 + `<div class="settings-page" id="settings-page-cli-models">` |
| `app.js`（改 3 处） | import + `cliModelsPageRoot` + `selectSettingsPage` 分支 |

### 3.5 会话路由（改 1 处，最小侵入）

`electron/chat-agent.mjs` 在 `runChatAgent` 开头新增 **提前返回** 支路：
`request.engine === 'acp'` → `runAcpSubscriptionTurn(...)`，把 CLI 的事件直接 `emit`，失败收敛成 `ModelError`。
**没开这个引擎时行为与改造前完全一致**（既有 19 个相关测试全通过）。

---

## 4. 与文档的偏差（需知悉）

| 项 | 文档 | 实际 | 原因 |
| --- | --- | --- | --- |
| 登出撤销 | §3.4 调 `revocation_endpoint` | 只做本地删除 | 未实现，UI 已有正确文案 |
| `dispose()` | 退出时释放 | 未接 `before-quit` | main.cjs 限定 1 处调用；回调服务器 timer 已 unref |
| Gemini 额度多账号 | 支持 | 登录已通，但额度探针仍是单账号（`pool` 按 provider 隔离可用，Gemini 侧只登记了一个账号） | 多账号 UI 与探针并发未做 |
| Mova 工具经 MCP 暴露 | §11.3b 完整清单（12 核心 + 按需发现） | 引擎已支持 `mcpServers` 透传，**工具表未注册** | 需一个 MCP server 进程；这是剩下最大的一块 |
| 上下文压缩 | §7 S2/S3（LLM 摘要器 + 自动触发） | 内核 + 接线已交付，**默认 off**；`report` 只上报、`ledger` 只用**确定性摘要**在 overflow 时压缩 | LLM 摘要器需一次额外的模型调用与预算分配，按方案 §7 的顺序理由先观测再开 |
| `v1internal` 直连 | §7.3 实验特性 | 未实现 | 默认关闭项，未做 |
| 服务版 flows 表 | §5.5 有 DDL | 只有表，**无读写方法** | 服务版登录服务未写（桌面端登录已通） |
| `edge-extension/page.js` 补 `time` 等待 | §5 P0-3 附带项 | 未做 | 扩展文件不在授权范围；提示已改成「按枚举生成」，不会假装支持 |
| `field pattern` / `object` kind | 契约未定义 | schema-form 最小扩展：`pattern`/`integer`/`kind:'object'` | 已同步给表单卡渲染层 |

### 4.1 新增开关

| 环境变量 | 取值 | 作用 |
| --- | --- | --- |
| `MOVA_CONTEXT_LEDGER` | `off`（默认）/ `report` / `ledger` | `report`：每次请求 emit 一条 `{type:'context', report}`，给上下文面板与 P0-6 用；`ledger`：在估算 **overflow** 时把旧区间换成摘要（保留最新用户消息与 pinned 约束） |
| `MOVA_CONTEXT_SUMMARY` | `deterministic`（默认）/ `llm` | 仅 `MOVA_CONTEXT_LEDGER=ledger` 时有效：`llm` 会用一次额外模型调用做结构化摘要，失败自动回退确定性 |

> `off` 时 `applyContextLedger` 直接返回原对象引用（连复制都不做），所以默认部署的行为与改造前完全一致。

### 4.1b Mova 工具经 MCP 暴露的实际情况

`chat-agent.mjs` 的 `buildMovaHandlers` 只把**真的能干的**包成工具（没注入 `search` 就没有 `web_search`）：

| 已暴露 | 前置 |
| --- | --- |
| `mova_read_file` / `mova_list_files` / `mova_write_file` | 项目根白名单；写要过审批（`full` 除外） |
| `mova_web_search` | 需要 `search` 注入（联网搜索开启时才有） |
| `mova_memory_search` | 需要 `memorySearch` 注入（记忆开启且非临时会话） |
| `mova_ask_user` / `mova_set_goal` / `mova_update_plan` | 需要 `asks` + `sender`（提问卡）；目标/计划直接 emit 既有事件 |
| `mova_tools_search` | 总是可用（发现用） |

未暴露：`mova_apply_patch` / `mova_web_read` / `mova_memory_write`（没有干净实现，宁可缺也不给假接口）。

**已知外部不确定性**：HTTP 型 MCP 需要 CLI 在 `initialize` 里自报 `agentCapabilities.mcpCapabilities.http === true`，否则一个工具都不挂（并给一条 warn notice）。这个能力位与 `mcpServers[].headers` 的数组形态（`[{name,value}]`）是按 ACP v1 schema 实现的，但**本机没有 CLI，无法验证真实 CLI 是否接受**。若真机上工具挂不上，第一处要查的就是这里。

### 4.2 订阅 Gemini 的判定口径（model-ipc 实现，写进文档备查）

```
走 ACP ⇔ 订阅 ∧ Gemini，两者必须同时成立：
  订阅 = provider.kind === 'subscription'
        || provider.type === 'subscription'
        || provider.id.toLowerCase().startsWith('subscription:')
  Gemini = ['subscriptionProvider','provider','subscription.provider'] 任一 === 'gemini'
        || provider.id.toLowerCase().includes('gemini')
        || （以上都没有时）provider.name.toLowerCase().includes('gemini')
```
> 第三轮已落地：`providers.listProviders()` 现在**真的**返回 `subscription:chatgpt` / `subscription:gemini`（`kind:'subscription'`），`resolveModel` 能命中，`loadProviderKey` 返回 `''`。也就是说这条判定**已经可达**，不再依赖未来改动。

### 4.3 端到端现在还差什么（诚实结论）

桌面端从「选中 Gemini 订阅」到「CLI 跑一轮并回渲染」的**代码链路已完整**：
`providers.listProviders` → 设置页选中 → `model:complete` → `model-ipc` 解析 CLI → `runChatAgent` 的 `engine:'acp'` 支路 → `acp/engine.mjs` → `translate.mjs` 出事件 → 渲染层。

但有三个**外部前置**，机器上缺一个就跑不通：

1. **本机必须装 antigravity CLI 且已登录**（`locateCli` 找不到就报 `not_configured`，这是设计如此）。
2. **用户必须在设置页登录过 ChatGPT 或 Gemini**（否则 `list()` 为空，池子无候选）。
3. **`settings.cliPath` 或 PATH 里能找到 CLI**；找不到时设置页的「CLI 路径」可以手动指定。

在满足这三条的机器上，一轮 Gemini 对话应当能跑通；本机没有 CLI，所以只验证到「错误路径正确、不崩、不静默降级」。

---

## 5. 剩余工作（按价值排序）

1. **真机验证 ACP 全链路**：装 antigravity CLI → 登录 → 观察 `agentCapabilities.mcpCapabilities.http` 是否为 true、`mcpServers[].headers` 数组形态是否被接受。**这是唯一还没在真实环境验证过的部分**（本机无 CLI）。
2. **`accessTokenFor` 按 provider 分支**：`ipc.mjs` 的实现只认 ChatGPT 记录形状，喂 Gemini 记录会走错端点。目前没有调用方（ACP 的令牌由 CLI profile 提供），接 Gemini 直连或通道自检时需要补。
3. **Gemini 账号身份稳定性**：`gemini-login.mjs` 的 `accountId = sha256(client_id \0 refresh_token \0 project_id)`——refresh token 轮换或 project_id 后补会算成新账号。要恒定身份应改用 profile 里的 Google 用户 id。
4. **`before-quit` 接 `dispose()`**：1 处改动，避免登录回调服务器残留。
5. **服务版 flows 的 `nonce` 列**：现在从 `state` 派生（表结构冻结）。若能改表，应改成独立随机列。
6. **`v1internal` 直连实验特性**：默认关闭，仅诊断用。

> 已完成的 P0 缺陷：`memory_search.source`、`memory_read_source.mode`、Edge 等待能力生成化、MCP `mcp_tool_info` + 最小校验、恢复记录结构化。`app.js` 死代码（P0-6）已删。

---

## 6. 如何复验

```powershell
# 一条命令跑完三闸（推荐）
node scripts/accept.mjs

# 只跑测试 / 跳过构建
node scripts/accept.mjs --tests
node scripts/accept.mjs --fast

# 只跑本次新增的测试
$env:ELECTRON_RUN_AS_NODE='1'
node --test tests/subscription-*.test.mjs tests/acp-*.test.mjs tests/context-*.test.mjs tests/schema-form.test.mjs tests/cli-models-view.test.mjs tests/notice-row.test.mjs tests/mcp-tool-info.test.mjs tests/browser-prompt-contract.test.mjs tests/memory-tool-schema.test.mjs tests/providers-subscription.test.mjs tests/resume-action-records.test.mjs

# 渲染核对（输出 JSON + assets\cli-models-live.png）
.\node_modules\.bin\electron.cmd scripts\.verify-cli-models.cjs
```

回滚（三级，按需选最近的）：

```powershell
# 回到第四轮开始前（MCP / LLM 摘要 / 服务版登录 / Gemini 多账号之前）
Copy-Item .code-backups\round3-20261113-191636\* .\ -Recurse -Force
# 回到第三轮开始前（内置 provider / Gemini 登录 / P0 修复 / 服务版表之前）
Copy-Item .code-backups\round2-20261113-182756\* .\ -Recurse -Force
# 回到整件事开始前（CLI 模型功能之前）
Copy-Item .code-backups\before-cli-models-20261113-175232\* .\ -Recurse -Force
```
