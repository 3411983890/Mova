# CLI 模型 · 开发文档

> 状态：**草案 v0.2**（2026-11-12 第二轮）。§16 已记录 11 项已确认决策，5 项按推荐默认执行（可随时否决）。
> 关联产物：[cli-models-settings.html](../prototypes/cli-models-settings.html)（设置页原型）、[schema-form-card.html](../prototypes/schema-form-card.html)（完整 schema 表单卡原型）、`assets/cli-models-*.png`（审查截图）、[Mova订阅额度登录方案.md](Mova订阅额度登录方案.md)（机制分析）、[Mova-Gemini后台执行-前端接入方案.md](Mova-Gemini后台执行-前端接入方案.md)（ACP 接入分析）。
> 设计基线：[Mova设置页设计规范.md](Mova设置页设计规范.md)（token、718 内容列、66% 行内边界、30px 分区节奏）、`src/features/ask/ask-card.css`（对话页卡片语言：`#1d1d1d` 底、12px 圆角、3px 语义竖条）。

---

## 1. 目标与非目标

### 1.1 目标（长期可用、功能完整）

1. 用户**用自己已有的订阅**驱动 Mova：ChatGPT（Plus/Pro）与 Gemini（AI Pro/Ultra，经本机 antigravity CLI）。
2. **多账号**：同一 provider 可登录多个账号，按额度自动轮换；额度用尽自动切号且用户可感知。
3. **额度可见**：5 小时 / 每周窗口、重置时间、重置券，读不到时明确显示「未知」而不是伪装成正常。
4. **对话页全链路**：Gemini 后台执行时的思考、计划、工具、改动、审批、提问，全部进 Mova 现有时间线与卡片。
5. **长期可维护**：凭据加密与撤销、跨进程锁、时钟与代理容错、失败可诊断、上游变更可降级。

### 1.2 非目标

- 不做令牌中转/共享池：一个凭据只对应一个真人。服务版允许**每个用户登录自己的账号**，但**不允许**平台建立一个所有人共用的账号池。
- 不替代 API Key 通道：`providers.json` 的 key 型 provider 行为不变。
- 不接管 CLI 自己的更新：antigravity 由用户安装与升级，Mova 只做版本探测与不兼容提示。

### 1.3 已确认的范围（2026-11-12，含第二轮决策）

| 决策 | 结论 |
| --- | --- |
| 功能范围 | ChatGPT + Gemini 双订阅，**含对话页全链路**（思考/计划/审批/提问进时间线） |
| 账号模型 | 每个 provider 多账号 + 用尽自动切号 + 优先账号；池子按 provider 隔离 |
| 发行形态 | **桌面端 + 服务版**：服务版同样提供该页与能力，凭据按用户隔离加密（§4.3） |
| 对话页露出 | 先只做「失败时提示」；额度细节留在设置页 |
| Gemini 通道 | 后台 CLI（ACP）；`v1internal` 直连只作实验特性，默认关闭 |
| ChatGPT 通道 | **两条都启用**：`chatgpt-plan`（默认）与 `chatgpt.com/backend-api`，设置页可切（§10.1） |
| 目标（goal） | 双保险：会话层兜底 + 进程内 MCP 注入 `set_goal/update_plan/ask_user` |
| Gemini 的工具 | **经 MCP 暴露完整 Mova 工具集**（项目文件、搜索、浏览器、桌面、记忆、MCP、设计、提问）（§11.3b） |
| 权限 | **`full` = 完全放行**：按 ACP/CLI 的最高权限执行，不弹审批，但仍写审计日志（§11.6） |
| 表单提问 | **完整 JSON-Schema 表单**（B 方案），字段类型全量映射（§12.4） |
| 计费口径 | 订阅调用 **成本记 0**，用量页单列、不计入金额（§8.5） |
| 子 agent 展示 | 折叠成一条 tool 行，可展开看输出 |
| 退出登录 | 调 revocation 撤销上游授权（见 §3.4 副作用说明） |
| CLI 分发 | 用户自行安装 antigravity，Mova 只做检测与引导 |

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 账号（account） | 一个 provider 下的一份 OAuth 凭据 + 展示信息（邮箱/plan/指纹） |
| 窗口（window） | 额度计量周期，如 `5h`、`weekly`、`monthly` |
| 池（pool） | 同一 provider 下参与轮换的账号集合 |
| 通道（channel） | ChatGPT 的两条上游：`api.openai.com/v1/responses`（chatgpt-plan）与 `chatgpt.com/backend-api`（codex） |
| ACP | Agent Client Protocol：Gemini CLI 与客户端之间的 stdio JSON-RPC |
| 闸门（gate） | Mova 实现 ACP 的 fs/terminal/permission 反向请求，从而拦住所有副作用 |
| 引擎（engine） | 一次对话的驱动方式：`api`（Mova 自己的循环）或 `acp`（CLI 拥有循环） |

---

## 3. 用户旅程

### 3.1 首次登录（ChatGPT）

1. 设置 → CLI 模型 → 「添加 ChatGPT 账号」。
2. 主进程生成 PKCE + state + nonce，`shell.openExternal` 打开系统浏览器。
3. 用户授权后浏览器跳回 `http://127.0.0.1:<port>/auth/callback`（页面提示「返回 Mova」）。
4. 主进程换 token、验签 ID token、落库加密，**自动收起登录面板**，新账号行出现并读一次额度。
5. 失败分支：拒绝授权 / 超时 / 已连接同账号 / 网络 → 面板内就地显示原因 + 「重试登录」。

### 3.2 日常使用

1. 用户发消息；主进程按 §9 选账号。
2. 若额度快过期（< 60s）先刷新 token；请求失败按 §9.4 分类处理。
3. 对话页不显示额度；仅在切换/失败时插入一条 `notice` 行（如「已切换到 bob@example.com」）。

### 3.3 额度用尽

1. 上游返回 `subscription_sharing_usage_limit_exceeded` / 429 限额语义。
2. 若本轮**尚未向用户吐过 token**：标记该账号 `exhaustedUntil = resetsAt`，切下一个账号重试一次。
3. 若已吐过内容：不重放，直接以错误结束并提示「额度用尽，X 后恢复；可在设置里切换账号」。
4. 设置页该账号行变「额度用尽」+ 倒计时；到点自动解除，不需要用户操作。

### 3.4 退出登录

1. 确认对话框（单条危险确认）→ 调 `revocation_endpoint` 撤销 refresh token（失败也算本地已删，但提示「已在本机移除」）。
2. 删除凭据文件；若删的是当前账号，自动切到池内下一个可用账号。
3. 进行中的请求：中止（abort），不静默改写结果。
4. **副作用（已确认接受）**：撤销的是这条 OAuth 授权本身，因此**同一账号在其它设备上的 Mova 也会失效**，需要重新登录。对话框文案必须写明这一点，不能只说「本机」。

### 3.5 换机 / 重装

- 凭据不跟随漫游：每台机器单独登录（Google/OpenAI 侧本来就是按设备授权）。
- 同一 ChatGPT 账号在多台机器登录：各自独立 client 注册，互不干扰；本地 `hostId` 不同，属于两个 agent 实例。

---

## 4. 总体架构

```
┌ renderer（React） ────────────────────────────────────────────────┐
│ 设置页 CLI 模型：账号行 / 额度条 / 登录面板 / 调度 / 模型 / 运行方式   │
│ 对话页：notice 行（切号、额度用尽）、审批条 options、提问卡、表单卡    │
└───────────────▲───────────────────────────────▲──────────────────┘
                │ IPC invoke / event            │ stream events
┌───────────────┴───────────────────────────────┴──────────────────┐
│ main                                                              │
│  subscription/                                                    │
│    store.mjs     凭据：safeStorage + 原子写 + 跨进程文件锁          │
│    models.mjs    pi-ai createModels（openai / openai-codex）        │
│    login.mjs     OAuth 流程 + 回调服务器 + 状态机                   │
│    usage.mjs     额度探针（codex wham / gemini cloudcode-pa）       │
│    pool.mjs      多账号选择、冷却、失败分类                          │
│  acp/                                                             │
│    client.mjs    stdio JSON-RPC：initialize/session/prompt/cancel  │
│    gate.mjs      反向请求 → permissions.cjs / approvals.cjs        │
│    translate.mjs ACP update → StreamEvent（纯函数，可单测）         │
│  chat-agent.mjs  路由：engine=api（现状） | engine=acp（新）        │
└──────────────────────────────────────────────────────────────────┘
```

模块边界规则：

1. **只有 `store.mjs` 碰凭据文件**；其它模块只拿 `accessToken()` 的结果，不读原始记录。
2. **只有 `usage.mjs` 发额度请求**；设置页与调度都读它的缓存快照。
3. **`translate.mjs` 必须是纯函数**：输入 ACP update、输出 StreamEvent，不碰 IO；这样映射规则能被单测覆盖。
4. `chat-agent.mjs` 不感知 OAuth：它只拿到「这个 provider 该用哪个 engine、哪个 model、哪个 token」。

### 4.3 服务版形态（新增）

服务版（`electron/services/*` + postgres/redis 那套）**同样提供该功能**，但边界必须写死：

| 项 | 规则 |
| --- | --- |
| 登录主体 | 每个登录用户登录**自己的** ChatGPT / Google 账号；不存在「平台账号」供所有人用 |
| 令牌存储 | 按 `userId` 隔离的加密记录（AES-GCM，密钥来自服务端密钥环/环境变量 `MOVA_SUBSCRIPTION_KEY`），表结构带 `tenant_id`，所有查询强制带租户条件 |
| OAuth 回调 | 走服务端 `/oauth/callback/<flowId>`，`flowId` 一次性、绑定 `userId` 与 `state`，5 分钟过期 |
| 进程模型 | 每个用户一份 CLI profile 目录（`data/subscriptions/<userId>/gemini-profile`），**不复用同一个 CLI 会话** |
| 权限 | `full` 只在桌面端等价放行；服务版 `full` 仍受服务端工作区根目录限制（服务端没有「用户桌面」） |
| 审计 | 服务版所有 ACP 工具调用落库（userId、工具名、参数摘要、结果状态），保留 30 天 |
| 不可用项 | 桌面类工具（屏幕/输入/UIA）在服务版直接不暴露给 CLI |
| 风险提示 | 设置页在服务版额外显示「令牌保存在服务端，仅你自己可见；退出会撤销上游授权」 |

> 迁移：`providers.json` 不动；服务版新增表 `subscription_credentials`、`subscription_events`、`subscription_flows`（见 §6.2）。

---

## 5. 数据模型

### 5.1 凭据记录（加密文件内）

```ts
type CredentialRecord =
  | { type: 'oauth'; provider: 'chatgpt' | 'gemini';
      accountId: string;              // 稳定 id：sha256(sub 或 google id)
      access: string; refresh: string;
      expiresAt: number;              // ms，判断时留 60s 余量
      scope?: string;                 // chatgpt: 校验 chatgpt.tokens.use.direct
      clientId?: string;              // chatgpt 动态注册结果（oaiapp_…）
      idToken?: string;               // 仅用于取 sub / account_id，不落明文日志
      email?: string; plan?: string;  // 展示用
      google?: { clientId: string; clientSecret: string; projectId?: string }; // gemini
      createdAt: number; lastUsedAt?: number }
  | { type: 'api_key'; key: string }; // 兼容旧 provider（不进设置页）
```

存储布局（`app.getPath('userData')`）：

```
subscriptions.enc         # 全部 oauth 记录，safeStorage 加密的整体 JSON
subscriptions.lock        # 跨进程文件锁（拿锁→读→改→原子替换→放锁）
subscription-host-id      # urn:uuid，ChatGPT 首次登录生成后固定
gemini-profile/           # antigravity 的私有 profile（GEMINI_HOME）
  antigravity-acp/{settings.json, acp_token.json}
```

> 迁移：不动 `providers.json`（v1）。CLI 模型是**新增的一组内置 provider**，`providers.list` 里以 `kind:'subscription'` 出现，`providers.cjs` 的 `PROTOCOLS` 校验不作用于它。

### 5.2 对外账号视图（不含令牌）

```ts
interface AccountView {
  id: string; provider: 'chatgpt' | 'gemini';
  email?: string; plan?: string;
  state: 'ready' | 'limited' | 'expired' | 'error';
  limitedUntil?: number;   // 仅 limited
  lastError?: string;      // 已脱敏
  active: boolean;         // 当前优先账号
  usage?: UsageSnapshot;   // 见 5.3
}
```

### 5.3 额度快照

```ts
interface UsageSnapshot {
  checkedAt: number;
  stale?: boolean;                 // 读取失败、沿用上次
  plan?: string;
  windows: Array<{
    id: string;                    // 'session' | 'weekly' | 'monthly' | 'gemini-5h' | '3p-shared' …
    label: string;                 // 「5 小时窗口」「Claude & GPT 共享池」
    usedPercent: number;           // 0–100
    resetsAt?: number;
    windowDurationMins?: number;
  }>;
  resetCredits?: { availableCount: number; nextExpiresAt?: number };
  reason?: 'unsupported' | 'probeFailed' | 'noProject';  // 读不到时的原因
}
```

### 5.4 设置项

```ts
interface CliModelSettings {
  autoSwitch: boolean;        // 默认 true
  preferredAccountId?: string;
  remindBelowPercent: number | null;   // 默认 null（关闭）
  refreshIntervalMins: 5 | 15 | 60 | -1; // -1 = 仅发送前
  channel: 'chatgpt-plan' | 'codex';     // 默认 chatgpt-plan；两条都可用（§10.1）
  geminiRunner: 'acp' | 'off';
  exposeToolsToCli: boolean;             // 默认 true：把 Mova 工具集经 MCP 给 Gemini（§11.3b）
  costAccounting: 'zero';                // 固定 'zero'：订阅调用不计价（§8.5）
}
```

### 5.5 服务版表结构

```sql
-- 每用户一份凭据，按 provider+account 唯一
subscription_credentials(
  tenant_id text not null, user_id text not null,
  provider text not null, account_id text not null,
  ciphertext bytea not null,         -- AES-GCM(record)，AAD = tenant_id|user_id|provider|account_id
  email text, plan text,
  expires_at timestamptz, created_at timestamptz default now(), last_used_at timestamptz,
  primary key (tenant_id, user_id, provider, account_id)
);
subscription_flows(flow_id text primary key, tenant_id text, user_id text,
  provider text, state text, verifier text, created_at timestamptz, expires_at timestamptz);
subscription_events(id bigserial primary key, tenant_id text, user_id text,
  at timestamptz default now(), kind text, provider text, account_id text,
  detail jsonb);                      -- 已脱敏；保留 30 天
```

> 加解密密钥只从 `MOVA_SUBSCRIPTION_KEY`（或 OS keyring）读取，不进代码库、不进镜像；AAD 绑定租户与账号，防止换行替换密文。

---

## 6. 存储与安全

| 项 | 要求 |
| --- | --- |
| 加密 | `safeStorage.encryptStringAsync`（Windows DPAPI）；不可用时**拒绝登录**并提示，不退化成明文 |
| 原子写 | 写临时文件 → `rename`；文件 `0600`；失败清理临时文件 |
| 并发 | `subscriptions.lock` 进程内 promise 链 + 跨进程文件锁（`wx` 打开 + 超时 2s 重试 3 次） |
| 刷新时机 | `expiresAt - 60s` 内刷新；刷新在锁内做，避免双刷把 refresh token 刷废 |
| 刷新失败 | **保留旧记录**供重试，标记 `expired`，提示重新登录；绝不清空 |
| 日志 | 只记 `accountId` 前 8 位 + 错误 code；禁止 access/refresh/id_token 进入日志、错误对象、遥测 |
| 撤销 | 登出调 `revocation_endpoint`（`token_type_hint=refresh_token`）；失败降级为本地删除并提示 |
| 校验 | PKCE `S256`、`state`、`nonce`、ID token 的 `iss/aud/exp/sub` 与 JWKS 验签；回跳的 `client_id` 必须匹配本次注册 |
| 同账号 | 已存在同 `sub` 时拒绝重复添加（提示「这个账号已经连接」），避免上游堆出一串 agent 授权 |

---

## 7. 登录子系统

### 7.1 ChatGPT（OAuth，与 harness/t3code 同款）

| 参数 | 值 |
| --- | --- |
| issuer / token | `https://auth.openai.com`、`/api/accounts/oauth/token` |
| resource | `https://api.openai.com/v1` |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| client_id | 动态注册得到的 `oaiapp_…`；不支持注册时回退 `dynamic_agent_client` |
| 其他参数 | `ext_agent_host_id`（本机固定 uuid）、`code_challenge_method=S256`、`agent_name_hint=Mova`、`id_token_hint`（重复登录时） |
| 回调 | `http://127.0.0.1:<随机端口>/auth/callback`，只接受本次 `state` |

登录状态机：`idle → waiting（浏览器） → verifying（换 token + 验签） → authorized | failed | cancelled`。同一 provider 同时只允许一个 waiting；`cancel()` 关闭回调服务器并中止，不留悬空监听。

### 7.2 Gemini（CLI 登录 + 读取 profile）

1. 检测 `agy`/`antigravity`：`settings.cliPath` → `PATH` → 常见安装位置；找不到则「安装 antigravity」引导。
2. 用私有 `GEMINI_HOME` 启动 CLI 登录（浏览器授权由 CLI 完成），Mova 只监听 profile 变化。
3. 读取 `<profile>/antigravity-acp/acp_token.json`：`client_id / client_secret / refresh_token / project_id`，写入凭据库并记录 `accountId = sha256(google id)`。
4. `project_id` 缺失时：额度探针返回 `noProject`，提示「打开一次 antigravity 完成初始化」。

### 7.3 关于 `v1internal`（为什么不做主路径）

`cloudcode-pa.googleapis.com/v1internal:*` 是 Google **内部、无文档**的 Cloud Code / Gemini Code Assist 后端：没有公开协议、没有版本承诺；请求需带官方客户端 UA 才会按订阅计量；额度要从 `loadCodeAssist/onboardUser` 拿到的 `project` 才能查。t3code 只用它**读额度**，生成一律交给 CLI。因此：

- 主路径：ACP（官方行为，可长期跟）。
- 实验特性（可选）：直连 `v1internal:streamGenerateContent` 仅作诊断/兜底，默认关闭，UI 标「实验」，失败不重试、不自动切号。

---

## 8. 额度子系统

### 8.1 ChatGPT

```
GET https://chatgpt.com/backend-api/wham/usage
  authorization: Bearer <access>
  openai-beta: codex-1
  originator: Mova
  chatgpt-account-id: <id_token.chatgpt_account_id>   # 有则带
→ { plan_type, rate_limit: { primary_window, secondary_window } }
GET .../wham/rate-limit-reset-credits → { credits[] }
```

窗口归一：`primary/secondary` 只是位置，真实周期看 `limit_window_seconds`；免费/Go 档主窗口按月，付费档 5h + 周。`limitId != 'codex'` 的模型级限额不进主列表。

### 8.2 Gemini

```
POST https://oauth2.googleapis.com/token                      # refresh
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
  authorization: Bearer <google access>
  user-agent: antigravity/hub/<ver> (aidev_client; os_type=…; arch=…; cl=…)
  body: { project }
```

两个 host 都问，按 `bucketId` 合并（谁先给数据用谁）；bucket 归类 `gemini-*` / `gemini-argon-*` / `gemini-carbon-*` / `3p-*`（Claude & GPT 共享池）。老账号没有 summary 时退化为 `fetchAvailableModels` 的 `quotaInfo/weeklyQuotaInfo`。

### 8.3 刷新与缓存

| 触发 | 行为 |
| --- | --- |
| 打开设置页 | 立即刷新一次（并发上限 1，按账号串行） |
| 定时 | `refreshIntervalMins`；窗口不可见时暂停 |
| 发送前 | 只做**本地判定**（未过期且未标记 limited 就不发网络请求） |
| 失败 | 退避：1min → 5min → 15min；期间 UI 显示上次快照 + `stale` |
| 429 | 记录 `retryAfter`，不参与调度 |

### 8.4 归一化与展示

- 同一账号多窗口时，设置页按 `session → weekly → 其他` 排序。
- `usedPercent` 保留整数；`resetsAt` 显示为「X 小时 Y 分后重置」，超过 24h 显示「周日 09:00 重置」（按本地时区）。
- 读不到 → `unknown` 徽章 + 原因，**不得**显示成「已连接/正常」。

### 8.5 计费口径（已确认：按 0 计）

订阅额度不是按量计费的 API，混进金额会误导，因此：

| 位置 | 规则 |
| --- | --- |
| `usage` 事件 | `cost = 0`，且带 `billing: 'subscription'` 标记；`input/output/cacheRead/reasoning` 仍如实记录 |
| 会话内成本 | 订阅调用不计入会话累计金额；顶部「本次花费」保持不变 |
| 使用情况和计费页 | 新增一行「订阅额度（不计费）」，展示请求数 / token 数，金额列显示 `—` 而不是 `$0.00`（避免被读成"免费额度已用"） |
| 导出/统计 | 统计脚本按 `billing` 过滤，避免把 0 成本混进平均单价 |
| token 口径 | Gemini 的 `input` 不含 cached、`output` 不含 thought；展示时按上游口径，不自己重算 |

> `—` 与 `$0.00` 的区别是刻意的：前者表示"不适用"，后者表示"计量为 0"。用户对账时需要这个区别。

---

## 9. 调度子系统（多账号）

### 9.1 选号算法

```
candidates = pool(provider)
  .filter(account.state === 'ready' && !limited(account, now))
preferred = settings.preferredAccountId
ordered = [preferred?] + others           // 其余按「剩余额度最多」再按 lastUsedAt 升序
pick = ordered[0] ?? null
```

- `limited()`：`limitedUntil > now + 30s`（30s 容错时钟偏移）；到点自动解除。
- 无候选：抛 `no_account_available`，提示最近的重置时间。

### 9.2 并发

- 同一账号允许并发（上游按窗口计量，不按并发）；但**同一账号的刷新串行**。
- 一次对话内的工具循环固定同一个账号（避免中途换号导致上下文不一致）；只有 `quota` 失败且未吐字时才换。

### 9.3 切号可观测

每次选择写一条诊断事件：`{ at, provider, picked, reason: 'preferred'|'least_used'|'failover'|'recovered', skipped: [{id, why}] }`。对话页只在 `failover` 时插 `notice` 行。

### 9.4 错误分类

| 上游 | 分类 | 处理 |
| --- | --- | --- |
| `subscription_sharing_usage_limit_exceeded` / `usage_limit_reached` | `quota` | 标记 limited → 切号重试一次 |
| 401 / `invalid_token` / 刷新失败 | `auth` | 标记 expired，提示重新登录；**不切号**（同 provider 都失效时提示） |
| 429 无限额语义 | `rate_limited` | 指数退避（1s/2s/4s，最多 3 次），不换号 |
| 403 + 模型名 | `model_access` | 提示该账号无此模型权限，不换号 |
| 网络/DNS/代理 | `network` | 不换号，提示检查代理（默认走系统代理，`127.0.0.1` 回调例外） |

---

## 10. 请求路径

### 10.1 ChatGPT（两条通道都启用）

| 通道 | 端点 | 能力 | 何时用 |
| --- | --- | --- | --- |
| `chatgpt-plan`（默认） | `api.openai.com/v1/responses` | Responses、文本+工具+图片、`store:false`、推理强度 | 通用对话与工具循环；最轻、最少状态 |
| `codex` | `chatgpt.com/backend-api` | 同上 + Codex 会话语义（prompt cache、sessionId、WebSocket 传输与 SSE 回退） | 需要 Codex 专属模型、长会话缓存命中、或 chatgpt-plan 不可用时 |

选择规则：

1. 设置页 `channel` 决定默认；切换后**新会话生效**，进行中的会话不改通道（避免上下文错乱）。
2. 模型目录按通道过滤：`codex` 专属模型只在 `codex` 通道出现，`chatgpt-plan` 下置灰并提示「需要开启 Codex 通道」。
3. 失败回退：`chatgpt-plan` 返回 404/403 且判定为通道级错误时，提示用户切通道，**不静默切换**（两条通道的会话语义不同）。
4. 健康检查：设置页每个通道一个状态点（`ok / failed / unknown`），点「测试」发一个最小请求（`max_output_tokens: 1`）。

实现方式：复用已安装的 `@earendil-works/pi-ai@1.5.0`（`createModels` + `providers/openai` 或 `providers/openai-codex`），OAuth 刷新在 `CredentialStore.modify` 的锁内完成。**不自己写 OAuth 客户端**，只提供 `CredentialStore` 与登录 UI 桥。`codex` 通道需要额外传 `sessionId` 并在会话结束时 `cleanupSessionResources(sessionId)`，否则 WS 连接池不会释放。

### 10.2 Gemini（ACP）

`chat-agent.mjs` 增加 `engine==='acp'` 分支：

```
启动：agy acp（stdio）→ initialize（clientInfo/capabilities）
建会话：session/new（cwd=项目根, mcpServers=…）
一轮：session/prompt（内容为 Mova 用户消息）→ 流式 session/update → 结束时取 PromptResponse.usage
取消：session/cancel
退出：关闭 stdin + 等进程退出（3s 后 kill）
```

会话复用：同一 `conversationId` 复用 ACP 会话；切换模型/权限模式走 `session/set_model`、`session/set_mode`（不支持则重建会话）。

---

## 11. ACP 集成：映射与缺口

### 11.1 客户端职责（闸门）

| 反向请求 | Mova 实现 | 安全要求 |
| --- | --- | --- |
| `fs/read_text_file` | 读文件 | 路径必须落在已授权 `projectRoots` 内（realpath 校验） |
| `fs/write_text_file` | 写文件 | 走 `approvals.ask`，预览 diff；写入前再校验一次路径 |
| `terminal/create/output/wait_for_exit/kill/release` | 执行命令 | 走 `permissions.cjs` 的 exec 能力与审计日志；输出限流 |
| `session/request_permission` | 审批条 / 提问卡 | 见 11.3 |
| `elicitation/create` | 表单卡 | 见 11.4 |

> 不实现 `fs/*`、`terminal/*` = 放弃审批与 diff，等于把磁盘交给 CLI。这是硬约束。

### 11.2 事件映射（ACP → Mova StreamEvent）

| ACP | Mova | 处理要点 |
| --- | --- | --- |
| `agent_thought_chunk` / `agent_thought` | `{type:'thinking', id, round, text}` | 同一轮合并为一条，节流 50ms |
| `agent_message_chunk` / `agent_message` | `{type:'text', id, text}` | 空块丢弃 |
| `tool_call` / `tool_call_update` | `{type:'tool', id, name, label, status, detail}` | status 四态归一：`pending\|in_progress→running`，`completed→done`，`failed→error` |
| `tool_call.content[] = {type:'diff'}` | `tool.diff` / `tool.path` | 直接喂 changes 面板与审批预览 |
| `tool_call.content[] = {type:'content'}` | `tool.output[]` / `{type:'image'}` | 文本尾部保留、超长截断 |
| `plan` / `plan_update` / `plan_removed` | `{type:'plan', plan:{steps}}` | 见 11.3 |
| `PromptResponse.usage` | `{type:'usage'}` | Gemini 口径：`input` 不含 cached、`output` 不含 thought |
| `compaction_update` | `{type:'notice'}` | 「上下文已压缩」 |
| 子 agent（child session） | `{type:'tool', name:'subagent'}` 折叠行 | 见 11.5 |

### 11.3 缺口一：目标与计划

**goal（已确认：双保险）**

ACP 没有 goal 概念，Mova 同时跑两条路：

1. **兜底（永远有值）**：会话层用首条用户消息 + 会话标题生成一个只读目标，卡片标注「Mova 维护 · 非模型意图」。它不随对话变化，除非用户手动改标题。
2. **覆盖（Gemini 主动写）**：Mova 起一个**进程内 MCP server**（仅内存、无网络），暴露三个纯状态工具：

   | 工具 | 参数 | 行为 |
   | --- | --- | --- |
   | `set_goal` | `{title, detail?}` | 覆盖兜底目标，标记 `source:'agent'` |
   | `update_plan` | `{steps:[{label,status}]}` | 覆盖 ACP plan（见下），标记 `source:'agent'` |
   | `ask_user` | `{question, options[]}` | 转成 Mova 的 ask-card（复用现有 `asks.ask`） |

   通过 `session/new` 的 `mcpServers` 传入（ACP 支持 stdio / http / acp 三类，见 t3code `adapter.ts:174-176`），**不改用户 profile 里的 `mcp_config.json`**（避免污染用户自己的 MCP 配置，也避开 t3code 那个「profile 里一有全局 MCP 就禁用文本生成」的坑）。三个工具都不接受任意命令/路径，只回传结构化状态。默认用 **stdio 子进程**（走 Mova 自己的 node 运行时，`stdio:'inherit'` 之外的管道不做捕获），需要跨会话复用时才启 http + 一次性 token。
3. UI 上目标卡显示来源徽章：`Mova 维护` / `Gemini 设置`；两者互斥，后者优先。

**plan 归一**：`entries[{content, priority, status}]` → `steps[{label,status,meta}]`；`in_progress` 多于一个时只保留第一个为 `active`；`failed` → `done` + `meta:'失败'`；整表替换 + 200ms 节流，避免计划卡抖动。若 Gemini 调用了 `update_plan`，以工具结果为准直到下一次 ACP `plan` 更新。

### 11.3b 把完整 Mova 工具集暴露给 Gemini（已确认）

Gemini 跑在 ACP 里，默认只有 CLI 自带的工具。要让它在 Mova 里"什么都能干"，把 Mova 的工具集通过同一个进程内 MCP server 暴露出去。

**传输**：stdio 子进程 `mova-mcp-bridge`（复用 `electron/mcp-manager.cjs` 的进程管理约定），在 `session/new` 的 `mcpServers` 里声明；工具名统一前缀 `mova_`，避免与 CLI 原生工具重名。

**工具清单**（按能力分组，默认只暴露 ★ 的核心 12 个）：

| 组 | 工具 | 风险 | 默认暴露 |
| --- | --- | --- | --- |
| 文件 | `mova_read_file` ★、`mova_write_file` ★、`mova_list_files` ★、`mova_apply_patch` | 写 | ★ |
| 搜索 | `mova_web_search` ★、`mova_web_read` ★ | 读 | ★ |
| 记忆 | `mova_memory_search` ★、`mova_memory_write` | 写 | ★（读） |
| 会话 | `mova_ask_user` ★、`mova_set_goal` ★、`mova_update_plan` ★ | 无副作用 | ★ |
| 浏览器 | `mova_browser_open/click/type/snapshot` | 写（外部副作用） | 否 |
| 桌面 | `mova_desktop_*`（截图/点击/输入/UIA） | 写（系统级） | 否（服务版永不暴露） |
| 项目 | `mova_project_roots`、`mova_git_status/diff` | 读 | 否 |
| MCP | `mova_mcp_search`、`mova_mcp_call` | 取决于目标 | 否 |
| 设计 | `mova_design_*` | 写 | 否 |

**工具目录治理（关键）**：60+ 个工具全塞进 system prompt 会吃掉几万 token 并让模型乱选。规则：

1. 默认只给 12 个核心工具；
2. 其余经 `mova_tools_search(query)` 发现，调用后返回 schema 并由 ACP 侧动态加入（和 Mova 自己的 `mcp_search` 一致）；
3. 每个工具的 `description` ≤ 2 行，参数 schema 去掉内部字段；
4. 设置页可切「暴露全部工具 / 仅核心 / 关闭」（`exposeToolsToCli`）。

**权限桥接**：工具执行前仍走 Mova 的 `permissions.cjs`：

- 读类：直接执行（受 `projectRoots` 白名单约束）；
- 写类：`exitPreset !== 'full'` 时走 `approvals.ask`（带 diff 预览）；`full` 时直接执行并记审计（§11.7）；
- 桌面/浏览器类：即使 `full` 也要求该能力在设置里被显式开启过（一次授权，长期有效），因为它们是系统级副作用。

**结果格式**：MCP `content` 数组；文本截断 8K、图片转 base64 并限制长边 1600px；异常返回 `isError:true` 且**不中断会话**（让 Gemini 自己决定重试或换路）。

**审计**：每次调用记 `{ tool, argsDigest, status, ms, preset }`；桌面端写滚动日志，服务版入库（§4.3）。

### 11.4 缺口二：提问与表单

- Antigravity 把「让用户选一个」走 `session/request_permission`（选项即答案）。判别依据：`toolCall` 的 meta 标记 + 选项集合形态。判别后映射成 `ask-card`：`{question: toolCall.title, options:[{value:optionId,label:name}]}`，回填 `{outcome:'selected', optionId}`。
- Mova 的 ask-card 上限 4 选项 / label 26 字：**翻译层先截断并去重**，被截断的选项要在「查看全部」里给原文。
- `elicitation/create`（JSON-Schema）→ **完整 schema 表单卡**，规格见 §12.4（已确认采用完整渲染，不做降维）。

### 11.5 缺口三：子 agent 与降级

- 子 agent：Mova 无 subagent UI → 折叠成一条 `tool` 行（标题 + 状态 + 可展开输出），不新造时间线层级。
- 中断：用户停止 → `session/cancel`，未完成的 tool 行标 `denied`，不留 `running`。
- 崩溃：CLI 进程退出且本轮未完 → `notice`「Gemini 会话已结束」+ 错误码，会话标记失效下次重建。

### 11.6 审批选项（重要）

ACP 给的选项是**数据**，不能硬套 Mova 的三键：

| ACP option kind | Mova 决策 | UI |
| --- | --- | --- |
| `allow_once` | `accept` | 允许一次 |
| `allow_always` | `acceptForSession` | 本会话允许（带 `_meta.security_warning` 时必须显示警告） |
| `reject_once` | `decline` | 拒绝 |
| `reject_always` | `decline` + 本会话记住 | 拒绝并记住 |
| 无匹配 | — | 只显示「取消」 |

`ApprovalBar` 增加可选 `options: [{id,label,kind,warning?}]`；有则按它渲染并回填 `optionId`，没有则走现有三键。

### 11.7 权限模式映射（已确认：full = 完全放行）

Mova 的三档预设与 ACP 会话模式一一对应：

| Mova `approvalPreset` | ACP 会话模式 | 反向请求处理 | 审计 |
| --- | --- | --- | --- |
| `default` | CLI 默认模式 | `request_permission` → 审批条；`fs/write` 前问一次 | 写 |
| `auto` | 自动接受（若 CLI 支持） | 读类直接过，写类只在**首次**每类动作问一次，之后同会话放行 | 写 |
| `full` | **CLI 最高权限**（`bypassPermissions` / yolo 等价模式） | **一律自动接受**，不弹任何卡片，不二次确认 | 仍写（不询问） |

`full` 的具体规则：

1. 首次切到 `full` 时给一次性警告横幅：「Gemini 将不经确认直接修改文件与执行命令，且无法自动撤销」。确认后才生效，可勾选「不再提醒」。
2. 会话中所有 ACP 反向请求直接 `accept`（`allow_always` 等价），日志记录 `preset:'full'`，便于事后追溯。
3. 仍保留三项**不拦截**的保护：写前快照（checkpoint，供 `changes` 面板回滚）、路径必须在已授权项目根内（桌面端也做 realpath 校验，防越界）、危险命令清单只做**事后高亮**不阻断。
4. 服务版 `full` 额外受工作区根限制：不能写到用户工作区之外（服务端没有"用户桌面"这个概念）。
5. 从 `full` 切回 `default` 不需要警告；已放行的动作不追溯。

> 取舍说明：`full` 的产品语义是"我相信这个 agent"。因此不做"白名单外再问一次"这类半放行——半放行会让用户以为放行了，实际仍被拦，反而更难排查。真正的安全阀是**事后可回滚 + 全量审计**。

---

## 12. 前端

### 12.1 设置页（已出原型）

六段：ChatGPT 订阅 / Gemini 订阅 / 额度调度 / 会话模型 / 运行方式 / （状态预览，落地删除）。要点：

- 账号行：`圆点 + 邮箱 + plan 徽章 + 状态徽章` 一行，`…` 菜单贴右；额度条在行下方（6px quota 语义）。
- 登录面板：状态文字靠左、按钮靠右；成功后**自动收起**。
- 空态/失败态：`unknown` 虚线徽章，不显示「已连接」。
- 所有远程操作都有 loading 与 3s toast；危险动作走确认对话框。

### 12.2 对话页（本期最小改动）

1. 新增 `ReplyEvent: {type:'notice', tone:'info'|'warn'|'error', text}` → 时间线里一行浅色提示，不参与 transcript 导出。
2. `no_account_available` / `quota` 失败 → notice + 行动按钮「打开设置」。
3. 审批条支持动态 `options`（§11.6）；提问卡支持 `header`（可选）。
4. 新增表单卡（elicitation）。

### 12.3 无障碍

- 账号行整行不是按钮（避免与菜单冲突）；菜单 `aria-haspopup/expanded`；进度条 `role="progressbar"` + `aria-valuenow`；切换账号后 `aria-live` 播报。

### 12.4 表单卡：完整 JSON-Schema 渲染（已确认采用完整版）

> 视觉原型：[schema-form-card.html](../prototypes/schema-form-card.html)（含简单 / 嵌套数组 / 键值对 / 复杂降级 / 校验失败 / 提交中 六种状态）。

#### 12.4.1 卡片结构（复用 ask-card 语言）

| 部分 | 规格 |
| --- | --- |
| 容器 | `#1d1d1d` 底、`1px #343434` 边、`12px` 圆角、左侧 `3px` 蓝色语义竖条、`0 10px 26px #00000040` 阴影、内边距 `10px 12px 10px 14px` |
| 头部 | 徽标「需要你确认」（`10.5px`、`#9dc2f5`、胶囊）+ 题干（`12.5px/600`、`#ededed`）+ 说明（`11.5px`、`#808080`）**同一行**，`flex-wrap` |
| 身体 | 字段区（6 列网格）；**只有身体滚动**，头尾固定 |
| 尾部 | 左侧 hint（「还有 2 项必填」/「已填完」）、右侧「跳过」+「提交」（`26px` 高、`7px` 圆角，主按钮 `#2f6bd8`） |
| 高度 | `max-height: min(56vh, 520px)`；字段区 `overflow-y:auto` + `overscroll-behavior:contain` |

#### 12.4.2 类型 → 控件映射

| schema | 控件 | 规格 |
| --- | --- | --- |
| `string`（无 enum，`maxLength ≤ 240`） | 单行输入，**标签同排** | `30px` 高、`#171717` 底、`#333` 边、focus `#3f6ea8` |
| `string` + `enum`（2–4 项） | **内联分段按钮**（`segment`） | 2px 内边距的分段容器；选中 `accent-surface + accent-line`；比整行单选省一半高度 |
| `string` + `enum`（≥ 5 项） | 自绘下拉 | 与设置页 `.settings-select` 同款，标签同排 |
| `string`（`maxLength > 240` 或 `format: multi`） | 多行文本，**标签在上** | `min 54px` / `max 112px`、可拖高 |
| `string` + `format: path` | 单行输入（占位符写「相对路径」） | **不弹系统选择器**（安全）；不再额外加小标签 |
| `number` / `integer` | 数字输入（右侧单位） | 输入框 `max-width: 110px`；integer 步进 1 |
| `boolean` | 开关，**标签同排** | `38×22`，右侧跟「是/否」文字 |
| `array`（items 为 `string`） | 胶囊列表 + 「添加」 | 胶囊 `1px 7px`；回车确认；最多 20 项 |
| `array`（items 为 `object`） | 子卡列表 | 每项一张卡：序号 + 必填数 + 删除 + 内部 6 列网格 |
| `object`（嵌套） | 6 列子网格 | 无边框分组，仅靠 8px 行距区分 |
| `additionalProperties` | 键值行 | `0.8fr / 1.2fr / 24px` 三列；键重复就地报错 |
| `oneOf` / `anyOf` | 分段选择器 + 对应字段 | 先选分支再渲染，切换时清除该分支旧值 |
| `enum` 含 `null` | 追加「留空」分段项 | 输出 `null` |
| 未支持（外链 `$ref`、`format:file`） | 只读提示「暂不支持，请在终端填写」 | 整体标记 `degraded` |

#### 12.4.3 布局（紧凑版，2026-11-13 修订）

> 这一节**刻意不套用设置页的 66% 换行规则**：表单卡是覆盖在输入栏上的临时面板，密度优先。原型见 [schema-form-card.html](../prototypes/schema-form-card.html)。

**6 列网格 + 行尾补齐**：

- 字段容器 `display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 8px 12px`。
- 每个字段占 `span-N`：`boolean / number / integer` → 2；`enum`（≤2）→ 3、`enum`（3–4）→ 4；短文本 / path → 3、长文本 → 6；数组 / 对象 / 键值对 → 6。
- **行尾补齐**：按 6 列贪心打包，一行填不满时把该行最后一个字段加宽到行尾（`boolean/number` 最多补到 4，其余可补到 6）。这样「名称 + 超时」「输出目录 + 备注」都能并成一行，右侧不留空档。

**字段行结构**：

```
[label 66–108px] [control flex:1]        ← 标量：标签与控件同排
[label]                                   ← 块级（长文本/数组/键值对）：标签独占一行
[control width:100%]
[desc 11px] [error 11px]                  ← 说明与错误在整行下方，出现时不跳行
```

**节奏与尺寸**（比设置页更紧一档）：

| 项 | 值 |
| --- | --- |
| 卡片内边距 | `10px 12px 10px 14px` |
| 头部 | badge `10.5px` + 题干 `12.5px/600` + 说明 `11.5px`，三者同一行（`flex-wrap`） |
| 字段行距 | `8px`；网格列距 `12px` |
| 标签 | `11.5px`，`#a2a2a2`，`min-width: 66px`（超长省略号） |
| 控件高 | 输入 `30px`、开关 `38×22`、按钮 `26px` |
| 数组项 | `padding 6px 9px 8px`，项间距 `6px`，头部 `10.5px` |
| 底部 | `margin-top 8px`，hint `11px` + 按钮 `26px` |

**窄窗（< 720px）**：网格降为 2 列，`span-6` 占满两列，标签最大宽度 40%。

**密度对照**（同屏 1000px 宽）：简单表单 **390px → 165px**（-58%）；嵌套表单在同样卡片高度里多显示一组「步骤」。

#### 12.4.4 校验

| 规则 | 处理 |
| --- | --- |
| `required` | 空 → 「XX 不能为空」 |
| `minLength / maxLength / pattern` | 就地提示；pattern 编译失败则忽略该规则并记一次诊断 |
| `minimum / maximum / multipleOf` | 数字字段提示 |
| `minItems / maxItems` | 数组字段提示，「添加」按钮到达上限即禁用 |
| 键值对 | 键重复 → 「键重复」；键为空 → 忽略该行 |
| 时机 | 失焦 + 提交；提交失败滚动到第一个错误并聚焦 |
| 文案 | 用 schema 的 `title` 拼中文句子，不直接回显英文错误 |

#### 12.4.5 状态机

```
idle → editing → submitting → submitted
                    └→ failed（保留已填值 + 顶部错误条 + 「重试」）
   └→ declined（点「跳过」，卡片收成「已跳过」一行）
```

- `submitting`：提交按钮 spinner、所有控件 `disabled`、hint 变成「正在提交…」；可「取消」（回 `{action:'cancel'}`）。
- `submitted`：卡片收成一行摘要（`已提交：实现策略=按现有风格补 · 测试=是`），可展开看完整 JSON；**不弹 toast**。
- 重开：同一 `elicitationId` 重放时恢复上次未提交的草稿（存内存，不落盘）。

#### 12.4.6 回填

```json
{ "action": "accept",  "content": { "...": "只含表单字段" } }
{ "action": "decline" }
{ "action": "cancel" }
```

- 未填的可选字段**不出现**（不发 `null`，与 JSON-Schema 语义一致）。
- 数字保持 number 类型、布尔保持 boolean、数组保序、键值对输出为对象。
- `content` 超过 64KB → 拒绝提交并提示。

#### 12.4.7 限制与降级

| 上限 | 值 | 超出后 |
| --- | --- | --- |
| 嵌套深度 | 5 | 停止展开，标「嵌套过深」 |
| 字段总数 | 40 | 整体降级 |
| 数组项 | 20 | 「添加」禁用 |
| schema 字节 | 64KB | 整体降级 |
| 外链 `$ref` | 不支持 | 该字段只读 |

降级形态：卡片显示「这个表格过于复杂，无法在这里安全填写」+ 可折叠的 schema 原文 + 「在终端确认」/「取消」。**降级也要给用户出口**，不能只报错。

#### 12.4.8 安全

1. `title` / `description` 一律按**纯文本**渲染（不解析 markdown/HTML）——否则 elicitation 可以注入 UI。
2. 不因 schema 弹系统文件选择器；路径只是字符串。
3. `default` 只作占位显示，**不算用户已确认**：`required` 字段即便有 default 也要求用户实际输入或显式点「使用默认值」。
4. 回填前对 `content` 做一次结构校验（只允许 schema 声明的键），防止模型侧塞入额外字段。
5. 表单卡不显示任何来自 schema 的链接（`format:uri` 也只做文本）。

#### 12.4.9 无障碍与键盘

- `<label for>` 关联；`aria-describedby` 指向说明与错误；`aria-invalid`。
- 错误容器 `role="alert"`；提交中容器 `aria-busy="true"`。
- `Enter` 提交（多行文本与键值对内除外）；`Esc` 收起并询问「放弃填写？」。
- 打开时聚焦第一个可编辑控件；数组「添加」后聚焦新项首个字段。

#### 12.4.10 性能

- 一次渲染，不做虚拟滚动（40 字段上限足够）。
- 字段独立受控，输入只重渲染该字段（事件委托 + 局部状态）。
- 数组增删只重渲染该数组节点。

---

## 13. 可观测与诊断

- 事件日志（滚动 7 天，脱敏）：登录开始/结束、刷新成功/失败、额度读取、选号决策、切号、ACP 会话起止、审批决策。
- 诊断包导出：OS/版本、CLI 是否存在及版本、`hostId` 前 8 位、各账号 `state/plan/usage`、最近 50 条事件（无令牌）。
- 自检：时钟偏移（> 2min 警告）、代理可达性、safeStorage 可用性、CLI 版本与 ACP 兼容性。

---

## 14. 测试计划

**单测**：`translate.mjs` 映射（含 plan 多 active、failed、空块、超长截断）、`pool.mjs` 选择与冷却、`usage.mjs` 归一（codex 两窗口 / gemini 三类 bucket / 缺 project）、凭据 store 的原子写与锁。

**集成**：本地 mock（`/v1/responses` SSE、`wham/usage`、`v1internal:*`）+ ACP mock agent（按脚本回放 update 与反向请求）。

**手工矩阵（16 条）**：

1. 首次登录成功 / 拒绝授权 / 超时 / 同账号重复添加
2. token 过期自动续期；刷新失败保留旧凭据
3. 双账号：额度用尽切号且不重复吐字；到点自动恢复
4. 断网 / 代理失效 / 时钟偏移 5 分钟
5. 长上下文（> 200K）不触发压缩死循环
6. 设置页与调度状态一致；退出当前账号后自动换号
7. 两条 ChatGPT 通道各自可用；`codex` 通道会话结束能释放 WS 连接
8. ACP：只读任务全流程（思考/计划/工具）
9. ACP：写文件审批（允许一次 / 本会话 / 拒绝）
10. ACP：`full` 放行——写文件与执行命令不弹卡，但审计有记录、changes 面板可回滚
11. ACP：提问卡回填；表单卡四种字段（枚举/布尔/数字/文本）回填
12. 表单卡边界：嵌套数组、键值对、必填缺失、超限降级、提交中取消
13. ACP：Mova 工具经 MCP 可被调用（`mova_read_file`、`mova_web_search`、`mova_ask_user`）；`mova_tools_search` 能发现未默认暴露的工具
14. ACP：取消与中断后无残留 running
15. ACP：CLI 崩溃恢复
16. 多窗口同时发消息（并发选号不串号）；服务版两用户凭据互不可见

---

## 15. 里程碑与验收

| 里程碑 | 内容 | DoD |
| --- | --- | --- |
| **M0 骨架** | store/models/login/usage/pool + IPC + 设置页接真数据 | 能登录、能看额度、能发消息；凭据加密、重启免登录 |
| **M1 多账号** | 调度算法、冷却恢复、通知行、错误分类 | 双账号用尽切号；无重复输出；状态与设置页一致 |
| **M2 Gemini 只读** | ACP client + translate（思考/计划/工具/usage），fs/terminal 全拒 | 让 Gemini 读项目并解释，时间线完整、零写入 |
| **M3 审批闸门** | fs/terminal/permission 三路接 `permissions/approvals`，diff 预览 | 写文件弹审批；拒绝后 CLI 正确继续；changes 面板有 diff |
| **M4 全链路** | 提问卡、完整 schema 表单卡（§12.4）、goal 双保险（含 MCP 三工具）、Mova 工具集经 MCP 暴露（§11.3b）、子 agent 折叠、notice、诊断包 | 12 条手工用例全过；上游错误文案可读 |
| **M5 服务版** | 服务端凭据表 + 租户隔离 + 服务端 OAuth 回调 + 审计入库；桌面专属工具不暴露 | 两个用户各自的账号互不可见；服务版 `full` 不越工作区根；审计可查 |

---

## 16. 决策记录与待确认

### 16.0 已确认（2026-11-12）

| 编号 | 问题 | 结论 | 文档落点 |
| --- | --- | --- | --- |
| 16.1 | Gemini 通道 | 后台 CLI（ACP）；`v1internal` 仅实验特性、默认关闭 | §1.3、§7.3、§10.2 |
| 16.1b | CLI 分发 | 用户自行安装 antigravity，Mova 只做检测与引导（不加包体） | §7.2、§13 |
| 16.2 | goal | 双保险：会话层兜底 + 进程内 MCP 注入 `set_goal/update_plan/ask_user` | §11.3 |
| 16.5 | 表单提问 | **完整 JSON-Schema 渲染（B）**，不做降维；上限与降级见 §12.4.7 | §11.4、§12.4 |
| 16.6 | 子 agent | 折叠成一条 tool 行，可展开看输出 | §11.5 |
| 16.10 | 退出登录 | 调 revocation 撤销上游授权；接受「其它设备也失效」并在对话框写明 | §3.4、§6 |
| 16.11 | 发行形态 | **桌面端 + 服务版**；服务版每用户各自登录、凭据按租户隔离加密 | §4.3、§5.5 |
| 16.12 | ChatGPT 通道 | **两条都启用**：`chatgpt-plan`（默认）+ `chatgpt.com/backend-api` | §10.1 |
| 16.13 | Gemini 的工具 | **经 MCP 暴露完整 Mova 工具集**（默认核心 12 个 + 按需发现） | §11.3b |
| 16.14 | 权限 | **`full` = 完全放行**（ACP 最高权限、不弹审批），保留审计与事后回滚 | §11.7 |
| 16.15 | 计费 | 订阅调用 **成本记 0**，用量页单列显示「—」 | §8.5 |

### 16.2 默认按推荐执行（未否决即生效）

| 编号 | 项 | 默认值 |
| --- | --- | --- |
| 16.3 | plan 语义 | ACP 扁平清单原样展示，只做状态归一；多 `in_progress` 保留一个 active |
| 16.4 | 提问/审批判别 | 按 `toolCall` meta 判别；判别失败按「审批」处理并显示原始选项 |
| 16.7 | 上下文压缩 | 只显示一条 notice「上下文已压缩」，不做摘要 |
| 16.8 | 额度口径 | 显示重置券（ChatGPT 有、Gemini 无则不显示）；阈值 70% 黄 / 90% 红；**不做**「今日用量」记账（M5 之后再评估） |
| 16.9 | 模型清单 | ChatGPT 用 `GET /v1/models`、Gemini 用 CLI 目录，各缓存 5 分钟，失败回退内置清单 |

> 以上若有异议直接说编号即可，我按你的版本改。

---

## 17. 风险与合规

1. **订阅额度只限本人**：不得共享、转售、做中转。服务版只允许「每个用户登录自己的账号」，**禁止**建设平台共用账号池（§4.3）。
2. **服务版令牌托管**：服务端持有他人令牌，泄露影响面大。要求：AES-GCM + AAD 绑定租户、密钥不进镜像、审计留痕、退出即撤销；上线前做一次渗透测试（越权读写他人 `account_id` 必须被拒）。
3. **`full` 完全放行**：等于把写盘与执行权交给模型。缓解手段是「事后可回滚 + 全量审计 + 首次警告」，**不是**中途拦截；文档与 UI 都必须说清楚这一点。
   - **服务版必须额外限制**：`full` 在服务端等于「任意用户可在服务器上执行任意命令」，可读环境变量、访问内网、挖矿。建议服务版强制二选一：**禁用 `terminal/*`**（只放行 fs 且限定工作区根），或把 CLI 跑在容器/沙箱里（独立用户、只读根、无网络）。这条属于上线门槛，不是优化项。
4. **Gemini 的 `v1internal` 是内部接口**：默认不启用；启用后失败不重试、不自动切号。
5. **CLI 版本耦合**：ACP 协议与 profile 布局会变；需要版本探测 + 「不兼容」提示 + 一键重装引导。
6. **上游封控**：异常高频登录/切号可能触发风控；登录加最小间隔（同 provider 30s），切号加冷却。
7. **合规展示**：设置页保留「订阅额度仅限本人在本设备使用」横幅；服务版加一句「令牌保存在服务端，仅你自己可见」。

---

## 18. 附录

### 18.1 参考实现索引

| 主题 | 位置 |
| --- | --- |
| ChatGPT OAuth 参数与验签 | t3code `apps/server/src/provider/CodexChatGptAuth.ts:604-626`；harness `chatgpt-plan/auth.mjs` |
| 令牌注入 CLI（可作为"不自己跑请求"的备选） | t3code `provider/CodexManagedRuntime.ts:22-32`、`CodexManagedTokenBroker.ts` |
| Codex 额度 | t3code `usage/cliproxyApi.ts:236-291` |
| Gemini 额度 | t3code `provider/antigravityUsageLimits.ts:210-340` |
| ACP 事件与 plan/审批 | t3code `packages/provider-acp/src/server/adapter.ts:1442-1463, 5582-5601` |
| 提问（走 permission 通道） | t3code `provider/acp/AntigravityProtocol.ts:115-165` |
| 审批选项映射 | 同上 `:77-102` |
| 客户端职责（fs/terminal/policy） | t3code `packages/provider-acp/src/server/{clientPolicy,clientTerminals,elicitationForm}.ts` |
| pi-ai 订阅 provider | `node_modules/@earendil-works/pi-ai/dist/providers/{openai,openai-codex}.js` |

### 18.2 IPC 契约（草案）

```ts
'subscription:list'        → AccountView[]
'subscription:login'       (provider, { channel }) → { started: true }   // 事件推进状态
'subscription:cancel'      (provider)
'subscription:logout'      (provider, accountId, { revoke: boolean })
'subscription:select'      (provider, accountId | null)                  // 设优先账号
'subscription:refresh'     (provider, accountId?)                        // 强制读额度
'subscription:settings'    () / (patch)
'subscription:models'      (provider) → ModelInfo[]
// 事件
'subscription:event'       { type: 'login', provider, state, detail? }
                           | { type: 'usage', provider, accountId, usage }
                           | { type: 'switched', provider, from, to, reason }
```

### 18.3 错误码

`not_configured` / `auth_expired` / `auth_cancelled` / `auth_timeout` / `duplicate_account` / `quota_exhausted` / `no_account_available` / `rate_limited` / `model_access` / `network` / `proxy` / `cli_missing` / `cli_incompatible` / `acp_protocol` / `credential`。
