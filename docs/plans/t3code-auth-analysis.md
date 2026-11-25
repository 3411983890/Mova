# t3code 是怎么接 ChatGPT 与 Gemini 订阅额度的（源码分析 + 对本项目的结论）

分析对象：`github.com/pingdotgg/t3code`（main 分支，2026-11-13 的 HEAD）。
结论先行：**t3code 完全不做 OAuth，也不存任何订阅凭据。它只驱动用户机器上已经登录好的官方 CLI，
登录/额度/模型全都问 CLI。** Mova 现在这两条路都在自己实现，这就是所有 401 /「授权没完成」的根源。

---

## 1. 仓库结构（证据）

```
apps/{desktop,server,web,mobile,marketing}
packages/provider-acp            # 通用 ACP 客户端（JSON-RPC over stdio）
packages/provider-acp-registry   # 按 ACP Registry 驱动各类 agent（含登录）
packages/effect-codex-app-server # Codex app-server 的 JSON-RPC 客户端（自动生成）
packages/provider-core           # ProviderAuthFlow 抽象（authMethods / authenticate / logout 三件套）
```

- 没有 `packages/*oauth*`、没有自己实现 token 交换的模块。`provider-core` 提供的是**流程抽象**，
  具体认证全部委托给 ACP agent 或 Codex app-server。
- `effect-codex-app-server/src/_generated/schema.gen.ts` 有 2.3MB，是从 Codex 官方 app-server
  协议**生成**的；`namespaces.gen.ts` 里能看到完整方法表（下面第 3 节引用）。

## 2. Gemini / 其它 ACP agent：登录 = 问 agent 要「登录方式」，然后让它自己登

关键文件：`packages/provider-acp-registry/src/server/auth.ts`

```ts
const initialized = yield* runtime.initialize();
const advertised = normalizeAcpRegistryAuthMethods(initialized.authMethods) // ← 登录方式是 agent 报的
  ...
const method = initialized.authMethods?.find((method) => method.id === methodId);
if (method.type === "terminal") {
  // 让 agent 自己的登录命令在 PTY 里跑，把输出流给 UI
  yield* runTerminal(resolved, method, context);
  ...
} else if (method.type === undefined || method.type === "agent") {
  yield* runtime.authenticate(methodId);   // ← 真正的登录：ACP 的 authenticate
}
yield* context.verifying;
yield* runtime.start();                    // ← 「已登录」的唯一证据：能开会话
```

要点：

| 事项 | t3code 的做法 |
| --- | --- |
| 登录方式 | `initialize` 返回的 `authMethods`（id / name / type: `agent` / `terminal` / `env_var`） |
| 登录动作 | `authenticate(methodId)`；`terminal` 类型则在 PTY 里跑 agent 的登录命令 |
| 浏览器 | agent 通过 ACP **elicitation**（`mode:"url"`）把 URL 发给客户端，客户端带用户同意后回 `accept`/`decline` |
| 登录成功判据 | `start()`（新建会话）成功，**不是**读版本号、也**不是**看凭据文件 |
| 退出 | ACP `logout`，60 秒超时（`agentCapabilities.auth.logout` 声明支持） |
| 凭据存哪 | **Mova/t3 侧什么都不存**。只在 `cacheDir/acp-auth-<hash>.json` 里写一行 UI 提示 `{binding, authenticated}`，binding 是设置 + HOME/APPDATA 的 sha256，环境变了就当未登录 |
| 多实例 | `credentialBinding = acp:<agentKey>`，即「同一 agent 的多份配置共享登录态」 |

`authenticationState.ts` 全文只有「读写一个 boolean 提示」的逻辑，**没有任何 token**。

## 3. ChatGPT：登录 = Codex app-server 的 RPC，不是自己打 HTTP

`packages/effect-codex-app-server` 是 `codex app-server` 的 stdio JSON-RPC 客户端。
从 `_generated/namespaces.gen.ts`（v2 协议表）可以直接读到它用到的能力：

```
LoginAccountParams / LoginAccountResponse          ← account/login/start
CancelLoginAccountParams                            ← account/login/cancel
AccountLoginCompletedNotification                   ← 登录完成通知
GetAccountParams / GetAccountResponse               ← account/read（我是谁、什么套餐）
LogoutAccountResponse                               ← account/logout
GetAccountRateLimitsResponse                        ← account/rateLimits/read  ★ 额度
AccountRateLimitsUpdatedNotification                ← 额度变化通知
NullableGetAccountRateLimitsParams                  ← 可指定 account
ConsumeAccountRateLimitResetCreditParams            ← 用重置额度
GetAccountTokenUsageResponse                        ← token 用量
ModelListParams / ModelListResponse                 ← model/list  ★ 模型清单
```

也就是说：**额度是 Codex CLI 自己向上游查的，模型清单也是 CLI 报的。**
t3code 从不自己拼 `chatgpt.com/backend-api/...` 请求，所以它不会遇到 401。

## 4. 本机实测（这套机制在我们机器上是什么样）

### 4.1 `agy acp` 的真实能力

`node scripts/probes/.probe-acp-capabilities.mjs`（本机 agy 1.5.8）：

```json
"agentInfo": { "name": "Antigravity ACP Server", "version": "1.5.8" },
"agentCapabilities": { "auth": { "logout": {} }, "sessionCapabilities": { "resume":{}, "close":{}, "list":{} } },
"authMethods": [
  { "id": "oauth-personal",  "name": "Log in with Google" },
  { "id": "oauth-business",  "name": "Log in with Gemini Enterprise" },
  { "id": "gemini-api-key",  "name": "Gemini API key" },
  { "id": "agent-platform",  "name": "Gemini Enterprise Agent Platform" }
],
"sessionId": "ok",
"sessionKeys": ["sessionId", "models", "modes", "configOptions", "_meta"],
"models": { ... "name": "Gemini 4 Argon (Medium)" ... }
```

三个结论：

1. **登录方式叫 `oauth-personal`**，不是我们猜的 `agy auth login`（1.5.8 根本没有 auth 子命令）。
2. **模型清单来自 `session/new` 的 `models`**（不是 `agy models` —— 那个命令实测经常返回空，
   就是它把我们卡住的）。
3. **本机 CLI 已经是登录状态**：`session/new` 成功并返回了 18 个模型。所以对这台机器来说，
   「添加 Gemini 账号」根本不需要授权动作，只需要开会话确认能用。

### 4.2 Codex 的凭据在哪

```
C:\Users\34119\.codex\auth.json
  auth_mode : "chatgpt"
  tokens.id_token (1758) / access_token (1740) / refresh_token (196)
  tokens.oauth_provenance.client_id (28) / issuer (23)
  tokens.account_id (36, uuid)      ← 就是 chatgpt-account-id 头的值
  last_refresh
```

注意：本机**没有** `codex` 可执行文件（不在 PATH 上），但 Codex 的登录态是完整的。

## 5. Mova 现在错在哪（一一对应）

| Mova 现状 | t3code 的做法 | 结果 |
| --- | --- | --- |
| Gemini：跑 `agy auth login` | ACP `authenticate("oauth-personal")` | 子命令不存在 → 1.2 秒非零退出 → 用户看到「授权被拒绝」 |
| Gemini：读 `<profile>/antigravity-acp/acp_token.json` | 不读任何凭据文件 | 文件从来不存在 |
| Gemini：`agy models` 当模型源 | `session/new` 的 `models` | 该命令实测常返回空 → 目录空 → 模型菜单里没有 Gemini |
| ChatGPT：自己走 OAuth（`dynamic_agent_client`） | Codex app-server `account/login/start` | 自签的 token 没有官方 client 的权限 |
| ChatGPT：自己打 `chatgpt.com/backend-api/wham/usage` | `account/rateLimits/read` | **必然 401/网络失败**（缺 `chatgpt-account-id`、client 也不对） |
| ChatGPT：用量读不到就标 probeFailed/expired | 由 CLI 报 | 界面长期显示「读取额度失败」 |

## 6. 建议的改法（按风险从低到高）

**第一步（Gemini，改动小、可立刻验证）**
1. 删掉 `gemini-login.mjs` 的 `auth login` + profile 轮询路径，改成：
   `initialize` → 打印 `authMethods` → 若用户点登录则 `authenticate('oauth-personal')`（agent 自己开浏览器）
   → `session/new` 验证 → 成功即登记账号。
2. 模型清单改为 `session/new.models`（证据见 4.1），`agy models` 只作后备。
3. 退出登录用 ACP `logout`。
4. 账号身份用 `acp:<agentKey>`（与上游一致），一台机器一条。

**第二步（ChatGPT，需要用户拍板方向）**
- 方案 A（最省事、与上游语义最接近）：读 `~/.codex/auth.json` 的 `access_token` + `account_id`，
  额度请求带上 `chatgpt-account-id`；过期时用 `refresh_token` + 官方 `client_id` 刷新。
  不用装 codex，也不需要我们自己注册 OAuth 客户端。
- 方案 B（最正统、工作量大）：内置一个 `codex app-server` 客户端（我们已经有 ACP 的 JSON-RPC 底座），
  `account/login/start` 登录、`account/rateLimits/read` 读额度、`model/list` 读模型、`account/logout` 退出。
  需要用户机器上有 `codex` 可执行文件（本机目前没有）。

两个方案都不再需要 `dynamic_agent_client` 那套自研 OAuth。

## 7. 附：这次分析用到的探针

```powershell
node scripts/probes/.probe-acp-capabilities.mjs   # agy acp 的 authMethods / models
node scripts/probes/.probe-cli-locate.mjs         # CLI 定位结论
npm run logs -- --errors                   # 运行期日志
```

## 8. 现有测试状态

`node --test`：1606 例 / 通过 1600 / 失败 3（= 已知基线，与本次分析无关）。

---

# 已实现（方案 A）与实测证据

按上面第 6 节的计划改完了，两条链路都做了端到端实测（真 CLI、真网络、真凭据文件）。

## A. ChatGPT：复用 Codex CLI 的登录态

新增 `electron/subscription/codex-auth.mjs`：读 `~/.codex/auth.json`（尊重 `CODEX_HOME`），
取出 `access_token` / `refresh_token` / **官方 `client_id`** / **上游 `account_id`**，
用 `account_id` 当 `chatgpt-account-id` 头、用官方 `client_id` 刷新。

实测（`installSubscriptionIpc` + 真 IPC 调用）：

```json
"login": { "ok": true, "value": { "state": "authorized",
           "accountId": "00366cda…", "importedFrom": "codex-cli" } },
"account": { "email": "www157428@gmail.com", "plan": "plus", "state": "ready" },
"refreshFailed": [],
"usageAfter": {
  "plan": "plus",
  "resetCredits": { "availableCount": 1 },
  "windows": [
    { "id": "session", "label": "5 小时窗口", "usedPercent": 0,  "resetsAt": … },
    { "id": "weekly",  "label": "每周窗口", "usedPercent": 23, "resetsAt": … }
  ]
}
```

**401 消失了**：额度真的读回来了。登录也不再弹浏览器。

## B. Gemini：ACP 登录 + ACP 模型清单

新增 `electron/subscription/acp-auth.mjs`：

- `acpDescribe`：`initialize` → `authMethods`；`session/new` → `models.availableModels`
- `acpAuthenticate`：agent 自己拉浏览器，然后**用开会话证明成功**
- `acpLogout`：退出登录走 ACP `logout`

实测（同一台机器，真 `agy acp`）：

```json
"login": { "ok": true, "value": { "state": "authorized",
           "accountId": "agy-cli", "modelCount": 18, "savedModels": 18 } }
```

18 个模型直接写进模型目录（`Gemini 4 Argon (Medium)` 这种原始标签保留，档位从括注解析），
右下角模型菜单登录后立刻可用。整条登录 ~5.5s（含一次 CLI 冷探测），**不再有 25 秒卡顿**。

## C. 配套改动

- `logout`：Gemini 的 `type:'cli'` 账号会先真的 `ACP logout` 再删本地记录。
- 模型目录探针（`setModelProbe`）从 `agy models` 换成 ACP `session/new`。
- `importCodex` 做成**显式开关**（默认关，`main.cjs` 打开）：否则开发机上装了 Codex 会改变
  测试里 ChatGPT 登录的路径，测试就不确定了。
- 旧的 `gemini-login.mjs`（`agy auth login` + profile 轮询）只保留给注入实现的历史路径，
  生产不再走；`cli-models.mjs` 的 `agy models` 解析降级为备用工具。

## D. 验证

```
node --test       1606 例 / 通过 1600 / 失败 3（已知基线）
npm run build     通过
npm run typecheck 通过
Electron 启动     存活 16s+，日志正常
```

新增测试 25 条：`tests/subscription-codex-auth.test.mjs`（10）+ `tests/subscription-acp-auth.test.mjs`（15）。
