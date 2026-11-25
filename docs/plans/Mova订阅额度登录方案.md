# Mova 订阅额度登录方案（复用 ChatGPT / Gemini 订阅额度）

> 目标：让 Mova 的用户「用 ChatGPT 订阅（Plus/Pro）和 Gemini 订阅（AI Pro/Ultra）的额度」直接驱动自己的 Agent，不再只依赖 API Key。
> 参照物：`pingdotgg/t3code`（下称 t3code）与 DSH harness 的 `chatgpt-plan` 插件（本机源码 `C:\Users\34119\Documents\DeepSeekTool\chatgpt-plan`）。
> 本文只讲机制与工程落点，不含任何密钥、不需要用户在本文档里贴 token。

---

## 0. 结论先行

| 问题 | 结论 |
| --- | --- |
| 订阅额度是怎么"变成 API"的？ | 三条路，本质只有两条：**(A) 自己走 OAuth 拿到 `chatgpt.tokens.use.direct` 的 access token，直接打上游 HTTP**（harness 插件、t3code 的 Codex 管理态都最终落到这里）；**(B) 驱动官方 CLI（codex / antigravity），让 CLI 用它自己的登录态**（t3code 生成侧的主力做法）。 |
| t3code 对 Codex 怎么做的？ | 自建 OAuth（`auth.openai.com` + PKCE + 动态注册客户端）→ 凭据加密落库 → **不写 `auth.json`**，而是给 codex CLI 传 `model_providers.openai_token_sharing.auth={command=...}`，由本机私有 IPC 令牌代理按需吐出 access token。 |
| t3code 对 Gemini 怎么做的？ | 不做 API 直连：写 `antigravity-acp/settings.json` + `acp_token.json` 到私有 profile 目录，**用 ACP 启动 antigravity CLI** 跑会话；额度另外用 `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` 探针读取。 |
| 额度（配额）数字从哪来？ | Codex：`https://chatgpt.com/backend-api/wham/usage`（`rate_limit.primary_window/secondary_window`）+ `.../rate-limit-reset-credits`；Gemini：`v1internal:retrieveUserQuotaSummary`（5h / weekly 桶）。 |
| Mova 应该怎么接？ | **优先复用已经装好的 `@earendil-works/pi-ai@1.5.0`**：它已经自带 `openai`（Sign in with ChatGPT，直连 `api.openai.com/v1` 的 Responses）与 `openai-codex`（`chatgpt.com/backend-api` 的 Codex Responses）两个 OAuth 订阅 provider，连登录流程、token 自动刷新、`CredentialStore` 接口都是现成的。Gemini 侧 pi-ai 没有 Code Assist/订阅通道，走 CLI/ACP 或自研 `v1internal`（风险自负）。 |

一句话：**Codex 订阅 ≈ 接一层 OAuth + 换一个 `api` 模块；Gemini 订阅 ≈ 要么托管 CLI，要么自己实现内部 API。**

---

## 1. t3code 的真实机制（逐层拆）

### 1.1 Codex：自建 OAuth + "令牌代理"注入 CLI

相关文件（仓库 `apps/server/src/` 下）：

- `provider/CodexChatGptAuth.ts`（47 KB）：OAuth 全流程 + 凭据存储 + 校验
- `provider/CodexManagedRuntime.ts`：把 token 变成 codex CLI 的启动参数
- `provider/CodexManagedTokenBroker.ts`：本机私有 IPC（Windows 命名管道 / Unix socket）令牌服务
- `provider/Drivers/CodexHomeLayout.ts`：影子 `CODEX_HOME`（`auth.json` 等私有文件不共享）
- `usage/cliproxyApi.ts` + `provider/codexUsageLimits.ts`：额度读取与归一

关键实现细节：

1. **授权请求**（`CodexChatGptAuth.ts:604-626`）

```
GET https://auth.openai.com/api/accounts/authorize
  client_id=dynamic_agent_client            # 或动态注册得到的 oaiapp_xxx
  ext_agent_host_id=urn:uuid:...            # 机器指纹，首次生成后固定
  response_type=code
  redirect_uri=http://127.0.0.1:<随机端口>/auth/callback
  scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct
  resource=https://api.openai.com/v1
  state=...  nonce=...  code_challenge_method=S256  code_challenge=...
  agent_name_hint="T3 Code"                 # 首次；之后用 id_token_hint / login_hint
```

- 这与 harness 插件 `chatgpt-plan/auth.mjs:69-72` 的参数**一模一样**，区别是 harness 用固定的 `dynamic_agent_client`，t3code 支持动态注册（回跳里带 `client_id`，且校验前缀 `oaiapp_`，见 `:664-676`）。
- 换 token：`POST https://auth.openai.com/api/accounts/oauth/token`（`grant_type=authorization_code` / `refresh_token`，`resource` 固定）。
- 校验：拉 `/.well-known/openid-configuration` 的 JWKS，`RS256` 验签，再校验 `iss/aud/exp/nonce/sub`（harness 版同款，`auth.mjs:29-42`）。
- 必须检查 `scope` 里含 `chatgpt.tokens.use.direct`，否则说明用户没同意"共享套餐额度"。

2. **凭据落库**：`{ clientId, refreshToken, accessToken, expiresAt, scopes, sub, email }`，`expiresAt-60s` 内不刷新（`CodexChatGptAuth.ts:831-878`）。刷新在**存储锁内**做，避免多进程重复刷新把 refresh token 刷废。

3. **注入 CLI（这是 t3code 最巧的一步）**：不写 `auth.json`，而是给 codex CLI 传自定义 provider（`CodexManagedRuntime.ts:22-32`）：

```
-c 'model_provider="openai_token_sharing"'
-c 'model_providers.openai_token_sharing={name="OpenAI Token Sharing",
      base_url="https://api.openai.com/v1",
      model_catalog_url="https://api.openai.com/v1/models",
      wire_api="responses",
      requires_openai_auth=false,
      supports_websockets=false,
      auth={command=<本机可执行文件>, args=["__managed-chatgpt-token", <pipe>, ...],
            timeout_ms=..., refresh_interval_ms=0}}'
-c 'features.api_key_model_discovery=true'
```

   即 **codex CLI 支持"由外部命令提供 token"**。那个 `command` 是 t3code 自己的进程，去连 `CodexManagedTokenBroker` 的命名管道；broker 收到请求后用存储的 refresh token 换新 access token 返回（`CodexManagedTokenBroker.ts:129-208`）。
   好处：token 不落盘、不写 `auth.json`、每次调用都是最新 token；坏处：绑定 codex CLI 的配置 schema，CLI 升级要跟。

4. **影子 HOME**：`CODEX_HOME` 指向影子目录，`auth.json`/`auth.lock`/`models_cache.json` 是私有实体文件，其他条目软链回共享 home（`CodexHomeLayout.ts:32-36`）——这样既用用户自己的配置/技能，又不会污染用户真实登录态。

5. **额度**（`usage/cliproxyApi.ts:236-291`）：

```
GET https://chatgpt.com/backend-api/wham/usage
  authorization: Bearer <access token>
  openai-beta: codex-1
  originator: Codex Desktop
  chatgpt-account-id: <id_token.chatgpt_account_id>   # 有就带上
→ { plan_type, rate_limit: { primary_window: {used_percent, reset_at, limit_window_seconds},
                             secondary_window: {...} } }
GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits   # 重置券
```

   解读规则（`provider/codexUsageLimits.ts:59-97`）：`primary/secondary` 只是位置，真实窗口长度看 `windowDurationMins`；免费/Go 档主窗口是月，付费档主窗口 5 小时、次窗口周。`limitId !== "codex"` 的模型级限额不进主列表。

### 1.2 Antigravity（Gemini 订阅）：托管 CLI + 独立额度探针

- 私有 profile：`<profile>/antigravity-acp/settings.json`（写 GCP OAuth client 对，注释说"环境里 `GOOGLE_API_KEY` 优先级更高"）、`<profile>/antigravity-acp/acp_token.json`（`provider/antigravityAuthSupport.ts:376-449`）。
- `acp_token.json` 结构（`provider/antigravityUsageLimits.ts:35-40`）：`{ client_id, client_secret, refresh_token, project_id? }` —— 这是 **Gemini/Antigravity 那套 OAuth 客户端凭据**，由 CLI 登录写入。
- 生成侧：**不直连模型 API**，走 ACP（Agent Client Protocol）启动 `antigravity` CLI 会话（`textGeneration/AntigravityTextGeneration.ts:162-287`），模型选择、权限、工具调用都通过 ACP 协商；文本生成场景把权限/工具全部拒绝，只取文本。
- 额度侧（`provider/antigravityUsageLimits.ts:210-340`）：

```
POST https://oauth2.googleapis.com/token            # refresh → access_token
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary   # 两个域名都问，按档位谁先
  authorization: Bearer <google access token>
  user-agent: antigravity/hub/2.24.0 (aidev_client; os_type=win32; arch=x64; cl=963137146)
  body: { project: <project_id> }                    # 没有 project 就发 {}
→ { groups/buckets: [ { bucketId, window: "5h"|"weekly", remainingFraction, resetTime } ] }
```

   bucket 归类：`gemini-*` → Gemini，`gemini-argon-*` / `gemini-carbon-*` → 单独家族，`3p-*` → Claude & GPT 共享池。
   老账号没有 summary 时退化为 `v1internal:fetchAvailableModels`，读每个模型的 `quotaInfo/weeklyQuotaInfo`。
- 账号识别：`www.googleapis.com/oauth2/v2/userinfo` 的 `id` 做 sha256 指纹（refresh token 每台机器都不同，不能当身份）。

**重点**：t3code 对 Gemini 全程没有"自己发一帧模型请求"，因为它没有稳定的公开接口；它把"用订阅"这件事外包给了官方 CLI。这也说明：**Gemini 订阅能不能被第三方 Agent 直接用，取决于是否愿意托管 CLI。**

### 1.3 DSH harness 的 `chatgpt-plan` 插件：最轻的一条路

`C:\Users\34119\Documents\DeepSeekTool\chatgpt-plan\`：

- `auth.mjs`：与 t3code 同款 OAuth（固定 `dynamic_agent_client`、`agent_name_hint`、`chatgpt.tokens.use.direct`），host id 存 `~/.dsh/chatgpt-plan/host-id`，凭据走 harness 的 `ctx.credentials`，登出时调 `revocation_endpoint`。
- `responses.mjs`：**直接** `POST https://api.openai.com/v1/responses`，`store:false, stream:true, include:['reasoning.encrypted_content']`；工具用 `{type:'namespace', name:'harness', tools:[{type:'function',...}]}` 包一层；把 SSE 事件翻成 harness 的 `block-start/text-delta/tool-call-*/usage/finish` 事件，并把 `response.output` 存为 `replayState` 供下一轮复用。
- `index.js`：
  - `GET /v1/models` 当模型目录（`visibility==='list'`），带 `context_window`、`supported_reasoning_levels`；目录缓存 5 分钟，失败 1 分钟。
  - **双账号 failover**：`order=[active, 1-active]`，命中 `subscription_sharing_usage_limit_exceeded` 且本轮还没吐过内容时，标记该账号 exhausted 换另一个（`:81-101`）。
  - replay 状态打上 `account` 标记，换号时自动丢弃别家的加密推理块（`:94`）。
  - HTTP 路由 `/chatgpt-plan/{status,login,select,logout,cancel}` 给设置页用；登录状态机 `idle/waiting/limit/error/authorized`。

**这条路的价值**：证明"不装 CLI 也能用订阅额度"——只要拿到带 `chatgpt.tokens.use.direct` 的 access token，`api.openai.com/v1/responses` 就是官方通道（OpenAI 的 token sharing）。而且它没有 `store:true`、没有 Codex 的 session 语义，实现面最小。

---

## 2. 三条落地路线的取舍

| | A. CLI 注入（t3code 式） | B. 直连 HTTP（harness 式） | C. 本地代理进程 |
| --- | --- | --- | --- |
| token 从哪来 | 自建 OAuth，token 只进管道 | 自建 OAuth，token 只在内存 | 同 B，但由代理进程持有 |
| 请求发到哪 | `codex exec` / `antigravity acp` | `api.openai.com/v1/responses`、`chatgpt.com/backend-api` | 本地 `127.0.0.1:port/v1` |
| 依赖 | 官方 CLI 必须装、配置 schema 要跟 | 无外部依赖 | 无外部依赖，但多一层进程/端口 |
| 能力 | 完整（含 Codex 工具、Gemini 全能力） | 仅文本/工具调用，图片要自己转 | 同 B |
| 套餐外风险 | 最低（就是官方行为） | 中（依赖内部通道，可能变） | 中 |
| 适配 Mova 成本 | 高（进程管理、权限、事件翻译） | **低** | 中（协议翻译 + 生命周期） |

Mova 的定位是"自己的 Agent 跑自己的循环"（`electron/chat-agent.mjs` 自己实现工具、审批、记忆），所以 **B 是主路**；只有在需要"整台机器交给 Codex 干活"时才考虑 A。

---

## 3. Mova 现状与接入点

调用链（main 进程）：

```
渲染层 invoke('model:complete')
  → electron/model-ipc.cjs:258   handler('model:complete')
    → providers.resolveModel(provider, model)      // providers.json + 加密 key
    → providers.loadProviderKey(provider.id)       // safeStorage
    → runChatAgent({ key, provider, entry, request, ... })
      → electron/chat-agent.mjs:739   piModel(entry, provider)   // api: 'anthropic-messages' | 'openai-completions'
      → electron/chat-agent.mjs:709   streamFor(provider, key)   // 选 pi-ai 的 streamSimple
      → electron/chat-agent.mjs:1113  streamFn(model, messages, { apiKey: key, ... })
```

现状约束：

- `electron/providers.cjs:8` 只允许 `['openai', 'anthropic']` 两种 `protocol`，`baseUrl + apiKey` 是唯一鉴权模型（`electron/providers.cjs:37` `keyStore(id)`）。
- `electron/model-credentials.cjs` 已经是"每个 provider 一个 `safeStorage` 加密文件"的结构，加 OAuth 凭据只是再开一种记录类型。
- `electron/chat-agent.mjs:64` 把 `api` 写死成两种；要支持订阅就必须让它按 provider 声明分发。
- **`@earendil-works/pi-ai@1.5.0` 已在依赖里**（`package.json:36`），且自带：
  - `providers/openai` → `Sign in with ChatGPT`（`auth.oauth.name = "OpenAI (ChatGPT subscription)"`, `isSubscription: true`, baseUrl `https://api.openai.com/v1`, `api: openai-responses`）
  - `providers/openai-codex` → `OpenAI (ChatGPT Plus/Pro)`（baseUrl `https://chatgpt.com/backend-api`, `api: openai-codex-responses`，支持 SSE/WebSocket）
  - `createModels({ credentials })` + `models.login(providerId,'oauth',interaction,{getDeviceId,agentName})` + 自动刷新 + `models.streamSimple()`
  - `CredentialStore` 只有 4 个方法：`read/list/modify/delete`（`pi-ai/dist/auth/types.d.ts:57-79`），刷新在 `modify` 的锁里做。

也就是说：**Codex 订阅所需的 OAuth、Responses 客户端、token 自动轮换，Mova 一行都不用自己写**，只要实现一个 `CredentialStore`、接一个登录 UI、把 `chat-agent` 的分发改成"按 `api` 选模块"。

---

## 4. 推荐方案（Codex / ChatGPT 订阅）

### 4.1 结构

```
electron/subscription/
  store.mjs        # CredentialStore：safeStorage 加密的 providers.secrets.json
  models.mjs       # createModels + setProvider(openaiProvider / openaiCodexProvider)
  login.mjs        # models.login('openai','oauth') 的交互桥（渲染层弹窗/内嵌浏览器）
  usage.mjs        # wham/usage 探针 + 缓存 + 归一成 {windows[], plan, resetCredits}
  errors.mjs       # 上游错误码 → 中文提示 + 是否可切号
```

### 4.2 凭据存储（唯一写入路径）

```js
// electron/subscription/store.mjs
import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export function createCredentialStore(filename = 'subscriptions.enc') {
  const file = join(app.getPath('userData'), filename);
  let chain = Promise.resolve();           // 串行化，等价于 pi-ai 的"每 provider 一把锁"

  const load = async () => {
    try { return JSON.parse(await safeStorage.decryptStringAsync(await readFile(file))); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  };
  const save = async (all) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, await safeStorage.encryptStringAsync(JSON.stringify(all)), { mode: 0o600 });
    await rename(tmp, file);               // 原子替换，绝不半写
  };

  return {
    async read(providerId) { return (await load())[providerId]; },
    async list() { return Object.entries(await load()).map(([providerId, c]) => ({ providerId, type: c.type })); },
    modify(providerId, fn) {
      const run = chain.then(async () => {
        const all = await load();
        const next = await fn(all[providerId]);      // 刷新也在这里发生 → 不会双重刷新
        if (next !== undefined) { all[providerId] = next; await save(all); }
        return all[providerId];
      });
      chain = run.catch(() => {});
      return run;
    },
    delete(providerId) {
      const run = chain.then(async () => { const all = await load(); delete all[providerId]; await save(all); });
      chain = run.catch(() => {});
      return run;
    },
  };
}
```

要点：**不要给 OAuth 凭据写"另一个 key 文件"**，一个 provider 一条记录（`{type:'oauth', refresh, access, expires, ...}`），与 pi-ai 的 `Credential` 形状对齐；`modify` 是唯一写入口。

### 4.3 登录

```js
// electron/subscription/models.mjs
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export const models = createModels({ credentials: createCredentialStore() });
models.setProvider(openaiProvider());       // Sign in with ChatGPT → api.openai.com/v1/responses
models.setProvider(openaiCodexProvider());  // Codex 客户端通道 → chatgpt.com/backend-api
```

```js
// 登录：auth_url / device_code / progress 三种事件转发给渲染层
await models.login('openai', 'oauth', {
  prompt: (p) => askRenderer(p),                    // 'secret' | 'manual_code' | 'select'
  notify: (e) => win.webContents.send('subscription:event', e),
}, { getDeviceId: () => hostId(), agentName: 'Mova' });
```

- `hostId()`：`urn:uuid:` 首次生成后固定（照 harness `auth.mjs:17-28`，落到 `userData/subscription-host-id`，`0600`）。**同一账号重复登录时复用它**，否则每次都被当成新 agent。
- 回调：`auth_url` 事件里带 `http://127.0.0.1:<port>/auth/callback`；Mova 用**系统浏览器**打开（比内嵌 BrowserWindow 更不容易被 OpenAI 判定异常，也避开 cookie 污染），同时保留 `manual_code` 兜底（粘贴整条跳转 URL）。
- 成功后立刻做两件事：`plan`（`chatgpt_plan_type`/`plan_type`）与第一次 `usage` 探针，UI 才有东西显示。
- 登出：`models.logout('openai')` + 调 `revocation_endpoint` 撤销 refresh token（harness `auth.mjs:103-109` 已证实可用）。

### 4.4 让 Agent 真正走订阅

`chat-agent.mjs` 的分发改成按 `api`（而不是按 `protocol`）选模块：

```js
const API_MODULES = {
  'openai-completions':      () => import('@earendil-works/pi-ai/api/openai-completions'),
  'anthropic-messages':      () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'openai-responses':        () => import('@earendil-works/pi-ai/api/openai-responses'),
  'openai-codex-responses':  () => import('@earendil-works/pi-ai/api/openai-codex-responses'),
};
```

- 订阅 provider 不要走 `providers.loadProviderKey()`，而是拿到 **pi-ai 的 `Models` 实例上已注册的模型**：`models.streamSimple(model, context, options)`，让它自己解析/刷新 auth（`auth` 失败会以 `stopReason:'error'` 的流事件出现，`model-ipc.cjs` 里已有统一错误壳可复用）。
- `providers.json` 里加两个内置 provider（`kind:'subscription'`），模型目录**不在 `providers.json` 里手写**：`models.getAvailable('openai')` 给的就是"这个账号真的能用"的清单；`getAvailable` 内部会按凭据过滤（`openai` provider 的 `filterAllModels` 还会摘掉 classifier 模型）。
- 能力字段映射：`contextWindow`/`maxTokens`/`thinkingLevelMap` 直接取 pi-ai 模型对象的字段（`chat-agent.mjs:56-93` 的 `piModel()` 对订阅模型要单独一条分支，不要复用 completions 的 `compat`）。

### 4.5 额度与多账号

```js
// electron/subscription/usage.mjs
const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
  headers: {
    authorization: `Bearer ${accessToken}`,
    'openai-beta': 'codex-1',
    originator: 'Mova',
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  },
  signal: AbortSignal.timeout(10_000),
});
// → { plan_type, rate_limit: { primary_window, secondary_window } }
```

归一成统一结构（可直接给现有 UI 用）：

```ts
{ plan: 'Plus' | 'Pro' | 'Free' | 'Go' | ...,
  windows: [{ id:'session'|'weekly'|'monthly', label, usedPercent, resetsAt, windowDurationMins }],
  resetCredits?: { availableCount, nextExpiresAt } }
```

规则照抄 `provider/codexUsageLimits.ts:59-97`：窗口长度看 `limit_window_seconds`，别硬编码"5 小时"。

**多账号 + 自动切号**（这是订阅方案真正的产品价值，学 harness `index.js:81-101`）：

- 账号表：`[{ id, email, plan, windows, exhaustedUntil, active }]`，exhausted 按 `resetsAt` 到期自动解除，不要永久拉黑。
- 调用顺序：`[active, ...others]`；命中以下情况才切号：
  - 上游码 `subscription_sharing_usage_limit_exceeded`、`usage_limit_reached`
  - HTTP 429 且带限额语义
  - `stopReason:'error'` 且本轮**还没向 UI 吐过任何 token**（吐过就不能重放，否则用户看到重复输出）
- 切号后必须丢弃上一账号的加密推理/缓存锚点（harness 用 `replayState.response.account` 标记实现），否则上游会拒。

### 4.6 错误码 → 用户可见文案

| 上游 | 内部 reason | 文案（中文） |
| --- | --- | --- |
| 401 / `invalid_token` | `auth_expired` | 登录已过期，请重新登录 ChatGPT |
| `subscription_sharing_usage_limit_exceeded` | `quota` | 该账号额度已用完，已尝试切换账号 |
| 429（无额度语义） | `rate_limited` | 请求过于频繁，稍后再试 |
| 403 + 模型名 | `model_access` | 该账号没有这个模型的权限 |
| 网络/超时 | `network` | 连接 OpenAI 失败，请检查代理 |

`model-ipc.cjs:310` 已有 `RETRYABLE` 集合与 5 次重试退避，`quota` 不应在里面无限重试，而应触发**切号**后重试一次。

### 4.7 安全

- token 只经 `safeStorage`（DPAPI）落盘，文件 `0600`、原子写；日志与错误对象**永不**序列化 access/refresh token。
- PKCE `S256` + `state` + `nonce` + 跳转 URL 归属校验（t3code `CodexChatGptAuth.ts:653-676` 的教训：换来的 code 必须属于本次 state，`client_id` 必须匹配）。
- 一个账号只允许一份凭据：重复登录同账号时复用旧 `client_id` + `id_token_hint`，避免 OpenAI 侧堆出一串 agent 授权（harness 明确拒绝"这个账号已经连接"）。
- 关闭"浏览器内自动填充 token"类调试开关；不提供"从别处导入 auth.json"的入口（否则等于把别人的登录态搬进用户机器）。
- 隐私：默认 `store:false`；只有在需要多轮推理复用且确认账号支持时才开 `store:true`（Codex 通道）。

---

## 5. Gemini（Antigravity / Gemini 订阅）怎么接

pi-ai 没有 Code Assist 通道（`providers/google` 只认 `GEMINI_API_KEY`，`providers/google-vertex` 走 ADC/API key），所以三选一：

### 方案 G1（推荐，与 t3code 同路）：托管 antigravity CLI

- 私有 profile：`userData/gemini-profile/{settings.json, acp_token.json, antigravity-acp/}`
- 启动：`antigravity acp`（stdio JSON-RPC，ACP），Mova 侧实现 ACP 客户端的最小面：`initialize / session/new / session/prompt / session/cancel` + `session/update` 事件。
- 优点：官方行为、能力完整、登录由 CLI 自己维护；缺点：Windows 上要分发/检测 CLI，且要写一套 ACP 事件 → Mova 事件（`text/tool/usage`）的翻译层。
- 工作量参考：t3code 的 `textGeneration/AntigravityTextGeneration.ts`（346 行）+ `acp/AntigravityProtocol.ts`（约 500 行）+ `antigravityAuthSupport.ts`（630 行）就是这个方案的规模。

### 方案 G2（自研内部 API，风险高）

```
POST https://oauth2.googleapis.com/token                              # refresh
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary   # 额度
POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse  # 生成
  authorization: Bearer <google token>
  user-agent: antigravity/hub/<ver> (aidev_client; os_type=...; arch=...; cl=...)
  body: { model, project, request: { contents, tools, systemInstruction, ... } }
```

- 这套是 Gemini CLI / Antigravity 的内部协议，**非公开、无兼容承诺、UA/版本校验随时可能变**，一旦变了就是全线不可用。只适合个人自用试验，不建议进发布版本。
- 还需要 `loadCodeAssist`/`onboardUser` 之类的前置调用才能拿到 `project_id`。

### 方案 G3（产品化最稳）：教用户用 Gemini API Key

- 现状已经支持 OpenAI/Anthropic 兼容协议；Gemini 的 OpenAI 兼容端点（`https://generativelanguage.googleapis.com/v1beta/openai`）可以直接当一个 provider 加进去，只需要在 `providers.cjs` 加预设。
- 缺点：那是按量计费，不是订阅额度。

**建议**：M1/M2 只做 Codex；Gemini 先做 G3 的预设（一天工作量），把 G1 排到有明确用户需求时再上。

---

## 6. 里程碑

| 阶段 | 范围 | 验收 |
| --- | --- | --- |
| **M1** Codex 登录可用 | `store.mjs`/`models.mjs`/`login.mjs`；`chat-agent` 按 `api` 分发；设置页"使用 ChatGPT 订阅登录"；`models.getAvailable` 出模型 | 全新机器：点登录 → 浏览器授权 → 回到 Mova 能发消息；重启后不用重新登录；token 过期能自愈；登出后立刻不可用 |
| **M2** 额度可视 + 多账号 | `usage.mjs` + 账号卡片（plan、5h/week、重置券、重置时间）；双账号切号；`quota` 错误文案 | 额度用尽时自动切到账号 B 且不重复吐字；额度到点自动恢复；关闭网络时显示"上次成功读数 + 时间"而非报错 |
| **M3** Codex 通道（可选） | `openai-codex` provider：`chatgpt.com/backend-api` + WebSocket；或 CLI 注入 | Codex 模型可用；与 M1 账号共享同一份凭据 |
| **M4** Gemini | 先 G3 预设，后 G1 ACP | G3：填 key 即用；G1：`antigravity` 已装时可切换并显示 Gemini 5h/week 额度 |

测试重点（照 t3code/harness 踩过的坑）：

1. 并发两路请求同时过期 → 只刷新一次（`modify` 锁）；
2. 刷新失败 → 保留旧凭据供重试，不要清空（否则用户被迫重登）；
3. 切号重放 → 上一账号的加密推理块必须丢；
4. 5.4 万 tokens 长上下文 → `contextWindow` 必须来自模型目录，否则压缩逻辑会拒；
5. 代理/VPN → 回调 `127.0.0.1` 不走代理，`api.openai.com` 走系统代理；
6. 时钟偏移 → `expires_at` 判断留 60s 余量。

---

## 7. 风险与合规（必须让用户知道）

1. **订阅额度不是 API 额度**。OpenAI 的 token sharing（`chatgpt.tokens.use.direct`）是官方通道，但它绑定"本人在本设备/本 agent 使用"；把它做成给别人用的中转/共享池，会违反条款并可能封号。t3code 的 README 第一句就是"They are already signed in"——不转卖、不共享。
2. **Gemini 的 `cloudcode-pa` 是内部 API**，没有公开文档，UA/版本/协议变更不通知；用它=自担风险。
3. **CLI 版本耦合**：`model_providers.*.auth.command` 这类配置属于 codex CLI 的私有 schema，升级即可能失效；托管 CLI 更是"官方一变就要跟"。
4. **不要把额度伪装成计费**：Mova 的用量展示应明确区分"订阅额度（非计费）"和"API 计费"，否则用户对账会崩。
5. **不要做多租户共享**：一个凭据只对应一个真人；服务端集中托管用户 refresh token 会直接把风险放大到"泄露即全量"。

---

## 8. 需要你拍板的四件事

1. **范围**：只做 ChatGPT 订阅（M1/M2），还是这轮就要 Gemini？
2. **Gemini 路线**：接受"必须装 antigravity CLI"（G1，稳但重）？还是先只给 API Key 预设（G3，轻但不是订阅额度）？
3. **通道选择**：`openai`（`api.openai.com/v1/responses`，轻、纯文本/工具）还是 `openai-codex`（`chatgpt.com/backend-api`，能力全、要处理 session/WS）？还是两条都注册、让用户选？
4. **多账号**：要不要一开始就支持"两个账号 + 自动切号"（harness 已经有现成状态机可以照搬）？

---

## 附：参考实现索引

| 主题 | t3code | harness `chatgpt-plan` |
| --- | --- | --- |
| OAuth 授权参数 | `apps/server/src/provider/CodexChatGptAuth.ts:604-626` | `auth.mjs:69-72` |
| ID token 校验 | 同上 `:200-260` | `auth.mjs:29-42` |
| 刷新与锁 | 同上 `:831-878` | `auth.mjs:88-101` |
| 登出撤销 | 同上（revocation） | `auth.mjs:103-109` |
| 直连 Responses | —（管理态走 CLI） | `responses.mjs:3-12` |
| 模型目录 | `provider/CodexChatGptModels.ts` | `index.js:37-67` |
| 额度读取 | `usage/cliproxyApi.ts:236-291` | —（只有额度错误码） |
| 多账号切号 | `codexUsageLimits` + 账户池 | `index.js:81-101` |
| Gemini 额度 | `provider/antigravityUsageLimits.ts:210-340` | — |
| Gemini 生成 | `textGeneration/AntigravityTextGeneration.ts` + ACP | — |
| 凭据抽象 | `provider/ProviderCredentialStore.ts` | `ctx.credentials`（record/modify） |

外部链接：[t3code](https://github.com/pingdotgg/t3code) · [架构说明](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) · [pi-ai README（OAuth Providers）](https://github.com/earendil-works/pi)
