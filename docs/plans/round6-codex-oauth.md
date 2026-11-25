# 方案 1 落地记录：ChatGPT 走 Codex OAuth，Gemini 走 ACP 强制重授权

日期：2026-11-14。这份记录只写「改了什么、怎么验证、还有什么没验证」，不重复方案论证。

## 一、结论

| 项 | 状态 |
| --- | --- |
| `electron/subscription/ipc.mjs` 编码事故 | 已修复（`node --check` 通过） |
| ChatGPT 浏览器登录（Codex 公开 PKCE 客户端） | 已实现，端到端跑通（假上游） |
| ChatGPT 订阅对话（`chatgpt.com/backend-api/codex/responses`） | 已接线，等待真实账号验证 |
| 多账号选号 / 限流换号 | 已接线（`acquireChatgptTurn` / `reportChatgptTurn`） |
| Gemini 每次登录都弹浏览器 | 已实现（`logout` → 新进程 `authenticate` → `session/new` 验真） |
| 模型目录（ChatGPT 8 个真实模型） | 已更新，带目录版本号 |
| 测试 | 1615 通过 / 3 失败（都是既有基线失败，与本功能无关） |
| typecheck / build | 通过 |

## 二、改了什么

### 1. `electron/subscription/login.mjs`（ChatGPT OAuth 参数）

- 授权端点 `https://auth.openai.com/oauth/authorize`，换码端点 `https://auth.openai.com/oauth/token`
  （原来是 `/api/accounts/oauth/*`）。
- `client_id` = `app_EMoamEEZ73f0CkXaXp7hrann`（Codex CLI 的公开 PKCE 客户端，无 secret）。
- `scope` = `openid profile email offline_access`，**去掉了** `resource` 与 `chatgpt.tokens.use.direct`。
  带 `resource=https://api.openai.com/v1` 的令牌不被 `chatgpt.com/backend-api/*` 接受（必 401）。
- 授权 URL 增加 `id_token_add_organizations=true`、`codex_cli_simplified_flow=true`、`originator=Mova`；
  去掉 `ext_agent_host_id` / `agent_name_hint` / `nonce` / `id_token_hint`。
- 刷新不再校验 `chatgpt.tokens.use.direct`（Codex 令牌里没有这个 scope，旧代码会把每次刷新都判成「套餐被收回」）。

### 2. `electron/subscription/codex-oauth.mjs`（新增）

- `codexClaims(accessToken)`：从 JWT 里取 `chatgpt_account_id` / `chatgpt_plan_type` / `profile.email` / `exp`。
- `codexRecordFromCredential`、`codexIdentityKey`、`refreshCodexCredential`。
- `createCodexLogin`：包装 `@earendil-works/pi-ai` 自带的 Codex OAuth（它已经实现了 PKCE、1455 回调、
  端口被占时退回「粘贴回调地址」、设备码兜底）。本模块只负责「开浏览器 / 收粘贴 / 落成记录形状」。

### 3. `electron/subscription/ipc.mjs`

- ChatGPT 登录：只走浏览器授权，**不再**读 `~/.codex/auth.json`（`importCodexAccount` 已删除）。
- 回调服务器先试 `127.0.0.1:1455`（上游唯一接受的 `redirect_uri` 是 `http://localhost:1455/auth/callback`），
  被占用时退回随机端口；`installSubscriptionIpc({ redirectPort })` 可覆盖（测试用 0）。
- 换码后的身份一律从 access token 声明里取；没有 `chatgpt_account_id` 直接判登录失败
  （没有它就打不了 `wham/usage` 与 `codex/responses`）。
- 新增 `service.acquireChatgptTurn()` / `service.reportChatgptTurn()`：选号 + 取令牌 + 回写限流/失效。
- Gemini 登录：`acpForceRelogin`（进程 A `logout` → 关掉 → 进程 B `authenticate` → `session/new`），
  不再「能开出会话就当已登录」；套餐名写入账号记录（`_meta.antigravity.tier`）。

### 4. `electron/model-ipc.cjs`

- 认出 `subscription:chatgpt`，**不再**向 providers 要 API Key。
- 每次尝试前 `acquireChatgptTurn()`，拿不到就报「请登录/换号」而不是空 key 打上游。
- 订阅通道把 `rate_limit` / `auth` / `quota_exhausted` 也算可换号重试，并把结果回写给账号池。

### 5. `electron/chat-agent.mjs`

- `piModel()`：ChatGPT 订阅用 `api: 'openai-codex-responses'`、`baseUrl: 'https://chatgpt.com/backend-api'`。
- `streamFor()`：对应地加载 `@earendil-works/pi-ai/api/openai-codex-responses`。
- `apiKey` 就是 access token；`chatgpt-account-id` 由 pi-ai 从 JWT 里解，不额外传。

### 6. `electron/subscription-models.cjs`

- `DEFAULT_CATALOG.chatgpt.models` 换成 Codex 订阅真实可用的 8 个 id（`gpt-6.1-sol` … `gpt-5.6-luna`），
  思考强度是同一模型上的档位（6 档），不是 8 个模型各一份。
- 新增 `catalogVersion`：旧文件里的占位模型 id（如 `gpt-5.1-mini`）会整份换成新默认值。

### 7. `electron/providers.cjs`

- `subscription:chatgpt` 的 `baseUrl` 从 `https://api.openai.com/v1` 改成 `https://chatgpt.com/backend-api`。
  这条不只是展示：`chat-agent` 的 `guardedFetch` 用它做白名单前缀，写错会把 codex 请求直接拦下来。

### 8. `electron/subscription/cli.mjs`

- `%LOCALAPPDATA%\agy\bin\agy.exe` 排到候选第一位（原来排在桌面程序后面）。
- 名字以 `antigravity` 开头的候选**一律**要「`--help` 里有 `acp`」这条正面证据才认，
  哪怕它 `--version` 吐了版本号（实测桌面程序会把内部 Node 的 `v24.22.0` 打出来冒名顶替）。
- 帮助文本里的 `acp` 匹配改成词边界。

## 三、验证

```
node --check   electron/subscription/ipc.mjs        ok
node --check   electron/subscription/codex-oauth.mjs ok
node --test    全部                                 1615 pass / 3 fail（基线）
npm run typecheck                                   ok
npm run build                                       ok
```

端到端（假上游，真实本地回调服务器）：

```
login → authorizeUrl( client_id=app_EMoamEEZ73f0CkXaXp7hrann,
                      redirect_uri=http://127.0.0.1:<port>/auth/callback,
                      scope=openid profile email offline_access,
                      codex_cli_simplified_flow=true, originator=Mova )
回调 → POST https://auth.openai.com/oauth/token
     → 事件 login:waiting → verifying → authorized → accounts
     → subscriptions.enc 里写入 chatgptAccountId / email / plan
```

真实机器上的 CLI 探测：

```
found=true  command=C:\Users\34119\AppData\Local\agy\bin\agy.exe  version=1.5.8  compatible=true
```

## 四、还没验证 / 需要注意

1. **真实浏览器登录只验证到「地址正确、回调服务器能起、令牌能解出身份」**。
   真正点一次登录才能确认 `originator=Mova` 是否被上游接受、`wham/usage` 是否 200。
2. **复用 Codex 公开 `client_id` 属于灰色地带**：一旦上游收紧（`redirect_uri_mismatch` / 拒绝
   `originator`），症状会出现在授权页而不是我们的代码里；所有 OAuth 细节都关在 `login.mjs` +
   `codex-oauth.mjs` 两个文件里，换实现只动这两处。
3. **Gemini 单槽位**：agy 的登录态在系统级位置，同一时刻只有一个 Google 账号；
   换号必须「注销 → 重新授权」，做不到 ChatGPT 那种静默轮换。
4. `electron/subscription/codex-auth.mjs`（读 `~/.codex/auth.json`）已不再被任何生产代码引用，
   只剩它自己的单测；保留是为了记录令牌形状，可以随时删。
5. `ipc.mjs` 里仍有约 85 行注释在编码事故里被截断（行尾是 `…`），不影响行为，未逐条重写。
