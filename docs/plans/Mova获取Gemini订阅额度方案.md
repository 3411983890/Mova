# Mova 获取 Gemini（Antigravity CLI）订阅额度架构方案

> **适用范围**：Mova（Electron 45 / Windows / Node 24 / React 设置页）  
> **目标**：在不改动 `agy acp` 稳定对话链路、不窃取或破解 CLI 本地私密凭据、不引入新第三方 npm 依赖的前提下，让 Mova 准确获取并展示用户的 **Google AI Pro / Gemini 订阅真实剩余额度**（含 5 小时窗口、每周窗口、Gemini 4 Argon 独立限额与重置倒计时）及真实账号邮箱。

---

## 1. 现状诊断与实测结论

### 1.1 现有代码断链点

1. **探针代码早已备好，但缺少 OAuth 凭据来源**
   - [electron/subscription/usage.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/usage.mjs) 已实现 `probeGemini` 与 `normalizeGeminiSummary`，可把 `retrieveUserQuotaSummary` 的响应映射为标准 `UsageSnapshot`（5 小时窗口、每周窗口、重置时间）。
   - 该探针最初配套的是 [electron/subscription/gemini-login.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/gemini-login.mjs)（设想通过 `agy auth login` 轮询读取 `acp_token.json`）。
2. **切换到 ACP 后额度路径被直接短路**
   - 本机实际安装的 `agy.exe 1.5.8` 并无 `auth login` 子命令，也不产出 `acp_token.json`，因此 Mova 改为通过 [electron/subscription/acp-auth.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/acp-auth.mjs) 走 ACP（`initialize` → `authenticate` → `session/new`）。
   - 登录后 [electron/subscription/ipc.mjs#L702-L714](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs#L702-L714) 只写入一条 `type: 'cli'`、`email: '本机 antigravity CLI'` 的占位记录；在 [L943-L945](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs#L943-L945) 刷新额度时看到 `record.type === 'cli'` 就直接返回 `{ reason: 'unsupported', detail: 'cli_managed' }`。

### 1.2 本机 `agy.exe 1.5.8` 协议实测事实

通过对本机 `agy.exe 1.5.8` 执行 ACP 探针与 Windows ConPTY 实测，已证实以下事实：

1. **ACP 协议不提供订阅配额 RPC**：
   - `initialize` 返回的 `agentCapabilities._meta.antigravity` 只有 `{ tier: true, systemPrompt: { append: true } }`；
   - `session/new` 仅返回档位 `_meta.antigravity.tier`（如 `{ id: "g1-pro-tier", name: "Google AI Pro" }`）与 18 个可用模型；
   - `session/update` 推送的 `usage_update`（`{ used: 0, size: 1048576 }`）仅代表**当前单次对话上下文窗口 token 占用**，并非订阅额度；
   - `available_commands_update` 中暴露的斜杠命令不含 `/usage` 或 `/quota`；
   - 即使覆写 `--app_data_dir` 与 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`，`agy acp` 仍共用系统级登录态。
2. **交互式终端（TUI）内置 `/usage` 且可通过 `120×70` ConPTY 一次抓全**：
   - 在 `120×70` 伪终端下启动 `agy.exe` 并发送 `/usage` 后，无需翻页即可完整输出全部 38 行配额面板（已实测跑通）：

```text
└ Models & Quota

  Account:  bottarinathan780@gmail.com

GEMINI MODELS
   Models within this group: Gemini Flash, Gemini Pro
     Weekly Limit Remaining  [ ██████████████████████████████████████████████  ░░░░ ]  92.33%   Refreshes in 33h 18m
     Five Hour Limit Remaining  [ █████████████████████████████████████████  ░░░░░░░░░ ]  82.33%   Refreshes in 1h 13m

CLAUDE AND GPT MODELS
   Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
     Weekly Limit Remaining  [ ██████████████████████████████████████████████████ ]  100.00%   Quota available
     Five Hour Limit Remaining  [ ██████████████████████████████████████████████████ ]  100.00%   Quota available

GEMINI 4 ARGON
   For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) ...
     Gemini 4 Argon Weekly Limit  [ ███  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ]  6.09%   Refreshes in 34h 1m
```

---

## 2. 总体架构设计（ConPTY `/usage` 探针 + 429 限流感知）

### 2.1 方案选型理由

| 方案路线 | 能否拿到准确百分比 | 合规与稳定性 | 多账号隔离 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **A. ConPTY 启动 `agy` 执行 `/usage`（本方案主路）** | ✅ 完整 3 组配额 + 重置时间 + 真实邮箱 | ✅ 完全走官方 CLI 正规命令，不拆包/不窃取本地私有 token | ⚠️ 随 `agy` 单账号态（与对话链路一致，不会账号错位） | **推荐立即落地** |
| **B. Mova 自研 Google OAuth 调 `v1internal:retrieveUserQuotaSummary`** | ⚠️ 受 Google 客户端 allowlist 约束（大概率 403） | ❌ 与 `agy` 对话账号易割裂 | ✅（仅查额度可多号，但对话仍切不了 `agy`） | 暂不作为主路 |
| **D. ACP 429 限流解析 + 档位展示（本方案兜底层）** | ❌ 仅在触发限流后得恢复时间 | ✅ 零外部依赖与UI耦合 | — | **与方案 A 协同内置** |

### 2.2 状态机与数据流图

```text
用户登录完成 / 点「刷新额度」 / 后台定时到达
                │
                ▼ (互斥锁：同一时刻仅运行 1 个探针；60s 冷却防抖)
┌──────────────────────────────────────────────────────────────┐
│ electron/subscription/gemini-usage-cli.mjs                   │
│                                                              │
│ 1. 启动 Windows ConPTY (120×70, STARTF_USESTDHANDLES)        │
│    cmd: agy.exe (cwd: 安全临时目录; 注入 Gemini 代理 env)      │
│ 2. 事件驱动等待就绪（超时上限 12s）：                          │
│    ├─ 命中 "Choose your color scheme" / "Terms of Service"   │
│    │   → 立即终止，返回 cli_onboarding_required              │
│    ├─ 命中 "Trust" 目录确认 → 立即终止，返回工作区提示         │
│    ├─ 出现 "? for shortcuts" 与输入提示行                    │
│    │   → 发送 "/usage" + 300ms + "\r"                        │
│ 3. 等待输出出现 "Models & Quota" 且底部出现 "esc" + "Close"  │
│    → 立即抓取输出并强杀/关闭 ConPTY 进程（全程约 3~5 秒）     │
│ 4. ANSI 清洗 + 分段正则解析 → 输出：                          │
│    { email, tierName, usage: UsageSnapshot }                 │
└───────────────┬──────────────────────────────────────────────┘
                │ 回写加密 store (store.modify)
                ▼
[Mova 设置页 · CLI 模型]
  · 账号行显示真实邮箱 (bottarinathan780@gmail.com) + 套餐徽章 (Google AI Pro)
  · QuotaBlock 渲染：
      - Gemini · 5 小时窗口 / 每周窗口
      - Gemini 4 Argon · 每周窗口
      - 第三方模型（Claude / GPT-OSS）· 5 小时 / 每周窗口
```

---

## 3. ConPTY 伪终端实现规范（零新增依赖）

### 3.1 技术实现要点（Windows）

Mova 的 `package.json` 已直接依赖 `koffi@3.3.7`（且内置 Windows PowerShell），**无需安装 `node-pty`**：
- **首选实现**：封装纯 Win32 `kernel32.dll` ConPTY 调用（通过 `koffi` 直接在主进程或轻量 worker 中调用 `CreatePipe`、`CreatePseudoConsole`、`InitializeProcThreadAttributeList`、`UpdateProcThreadAttribute`、`CreateProcessW`、`TerminateProcess`、`ClosePseudoConsole`），或通过 `powershell.exe -NoProfile` 执行内联 C# ConPTY 桥接（启动约多 0.8s，但无任何原生 ABI 风险）。
- **三个实测验证过的关键坑（必须遵守）**：
  1. **`dwFlags` 必须设置 `STARTF_USESTDHANDLES`（`0x00000100`）**：实测若不设该标志，Windows `CreateProcessW` 会让子进程继续往父控制台句柄写输出，导致 ConPTY 读取管道收不到 CLI 内容。
  2. **响应终端光标查询 DSR（`\x1b[6n`）**：读取循环中一旦收到 `\x1b[6n`，立即向输入管道回写 `\x1b[1;1R`，避免 TUI 渲染框架卡在光标探针阶段。
  3. **控制台缓冲尺寸设为 `COORD { X: 120, Y: 70 }`**：实测 `45` 行会将 `/usage` 折叠为 `(1–17 of 38 lines)` 隐藏下方配额块；设到 `70` 行可一屏完整渲染 `GEMINI MODELS`、`CLAUDE AND GPT MODELS`、`GEMINI 4 ARGON` 全部 3 个区块，省去翻页按键模拟。
  4. **工作目录与环境变量**：
     - `cwd` 固定使用系统临时目录或 `userData` 下专建的只读空目录（避免在任意项目目录触发「是否信任该文件夹」向导）。
     - 若配置了按模型 VPN 路由，注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 并强制带 `NO_PROXY=127.0.0.1,localhost,::1`。

---

## 4. `/usage` 输出清洗与解析规范

### 4.1 ANSI / 控制符清洗

将 ConPTY 抓取到的 `AFTER_USAGE` UTF-8 文本依次执行：
1. 剥离 CSI 转义序列：`/\x1b\[[0-9;?<>!]*[ -/]*[@-~]/g` → 替换为单空格（保留列间分隔，避免左右两列文字粘连）
2. 剥离 OSC 序列：`/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g`
3. 折叠 `\r` 与多余不可见控制字符（`\x00-\x08`, `\x0b-\x1f`, `\x7f`）

### 4.2 状态机分块解析规则

仅在确认捕获文本中存在 `Models & Quota` 后按行扫描（取 `Models & Quota` 之后到 `esc   Close` 之前的内容）：

1. **提取真实邮箱**：
   - 正则：`/Account:\s*([^\s@]+@[^\s@]+)/i` → 提取 `email`（如 `bottarinathan780@gmail.com`）。
2. **提取订阅档位（可选补充）**：
   - 从启动页尾或 ACP `session/new` 的 `_meta.antigravity.tier` 取 `Google AI Pro`。
3. **区块识别（`currentSection`）**：
   - 匹配 `/^GEMINI MODELS\b/i` → `section = 'gemini'`
   - 匹配 `/^CLAUDE AND GPT MODELS\b/i` → `section = '3p'`
   - 匹配 `/^GEMINI 4 ARGON\b/i` → `section = 'gemini-argon'`
4. **窗口行与倒计时解析**：
   - **百分比**：匹配 `/(Weekly|Five Hour)[^%\n]*?(\d+(?:\.\d+)?)%/i`（注意 `GEMINI 4 ARGON` 行的文案是 `Gemini 4 Argon Weekly Limit  [...] 6.09%`）：
     - `remainingPercent = Number(match[2])`
     - **`usedPercent = Math.max(0, Math.min(100, Math.round(100 - remainingPercent)))`**（与 Mova 现有 `UsageSnapshot` 统一按「已用百分比」存储）。
   - **刷新倒计时**：同一行或紧邻下一行匹配：
     - `/Refreshes in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/i` → 计算 `deltaMs = ((d * 24 + h) * 60 + m) * 60_000`，得出 `resetsAt = checkedAt + deltaMs`；
     - `/Quota available/i` → 满额状态，不写入过期 `resetsAt`。

### 4.3 归一化后的 `UsageSnapshot` 映射表

| CLI 原始区块 & 行标签 | `window.id` | Mova 界面展示 `label` | `windowDurationMins` |
| :--- | :--- | :--- | :--- |
| `GEMINI MODELS` · `Five Hour Limit Remaining` | `gemini-5h` | `Gemini · 5 小时窗口` | `300` |
| `GEMINI MODELS` · `Weekly Limit Remaining` | `gemini-weekly` | `Gemini · 每周窗口` | `10080` |
| `GEMINI 4 ARGON` · `Gemini 4 Argon Weekly Limit` | `gemini-argon-weekly` | `Gemini 4 Argon · 每周窗口` | `10080` |
| `CLAUDE AND GPT MODELS` · `Five Hour Limit Remaining` | `3p-5h` | `第三方模型（Claude/GPT）· 5 小时` | `300` |
| `CLAUDE AND GPT MODELS` · `Weekly Limit Remaining` | `3p-weekly` | `第三方模型（Claude/GPT）· 每周` | `10080` |

> **注意**：`CLAUDE AND GPT MODELS` 与 Mova 的 `subscription:chatgpt` 额度完全独立（它属于你 Google AI Pro 账号在 `agy` 中调用 Claude/GPT-OSS 的配额），界面标签写明「第三方模型（Claude/GPT）」以防用户误会。

**输出样例（对照本次实测数据）**：
```json
{
  "email": "bottarinathan780@gmail.com",
  "usage": {
    "checkedAt": 1794601170000,
    "windows": [
      { "id": "gemini-5h", "label": "Gemini · 5 小时窗口", "usedPercent": 18, "resetsAt": 1794605550000, "windowDurationMins": 300 },
      { "id": "gemini-weekly", "label": "Gemini · 每周窗口", "usedPercent": 8, "resetsAt": 1794721050000, "windowDurationMins": 10080 },
      { "id": "gemini-argon-weekly", "label": "Gemini 4 Argon · 每周窗口", "usedPercent": 94, "resetsAt": 1794723630000, "windowDurationMins": 10080 },
      { "id": "3p-5h", "label": "第三方模型（Claude/GPT）· 5 小时", "usedPercent": 0, "windowDurationMins": 300 },
      { "id": "3p-weekly", "label": "第三方模型（Claude/GPT）· 每周", "usedPercent": 0, "windowDurationMins": 10080 }
    ]
  }
}
```

---

## 5. 安全护栏、刷新调度与 429 联动兜底

### 5.1 严守安全红线（绝不偷偷替用户确认条款）

| 检测到的终端文本特征 | 错误分类 | 用户可见文案 |
| :--- | :--- | :--- |
| `Choose your color scheme` / `Terms of Service` | `cli_onboarding_required` | 请先在终端运行一次 `agy` 完成首次向导后再刷新额度 |
| `Trust` 且含目录授权提示 | `cli_trust_required` | CLI 需要终端工作区确认，请先在终端完成一次授权 |
| 长时停留在 `Signing in...` 或提示 `/login` | `cli_not_logged_in` | 本机 antigravity CLI 尚未登录，请重新授权 |
| 超时（12s 未出 `Models & Quota`）或解析为空 | `probeFailed` | 读取额度超时，已保留上次快照（`stale: true`） |

### 5.2 刷新调度与性能保护

1. **绝不在发送消息前同步阻塞拉起 ConPTY**：一次 ConPTY 启动需要 3~5 秒，聊天发送前只读取本地缓存的 `record.usage` 判定是否可用。
2. **单飞互斥 + 最小冷却间隔（60 秒）**：进程内维护一个 `inFlightGeminiProbe` Promise，防止自动定时刷新与用户连续点击同时拉起多个 `agy.exe`。
3. **触发点**：
   - Gemini 登录成功（`acpForceRelogin` 通过）后异步触发一次刷新，顺便把占位名称 `'本机 antigravity CLI'` 更新为真实邮箱；
   - 用户在「CLI 模型」页点击「刷新额度」或全局定时刷新器到达周期时执行。

### 5.3 协同兜底：ACP 对话 429 / 限流时间回写

在 [electron/acp/engine.mjs](file:///c:/Users/34119/Documents/Mova/electron/acp/engine.mjs) 与 [electron/model-ipc.cjs](file:///c:/Users/34119/Documents/Mova/electron/model-ipc.cjs) 增加错误特征解析：当 `agy acp` 在聊天过程中返回 `RESOURCE_EXHAUSTED` / `429` / `Quota exceeded` 并携带恢复时间时，提取 `limitedUntil` 写入账号状态并推送 `accounts` 事件，再顺带异步触发一次 `/usage` 刷新，实现「被动触发 + 主动校准」双闭环。

---

## 6. Mova 代码改动清单

| 文件 | 改动内容 |
| :--- | :--- |
| **新建** `electron/subscription/gemini-usage-cli.mjs` | 1. 纯函数 `stripAnsi(raw)` 与 `parseAgyUsageOutput(text, checkedAt)`（可完全脱离 Windows/ConPTY 运行单测）<br>2. `probeGeminiViaCli({ command, env, timeoutMs, execConPty })` ConPTY 执行与护栏控制 |
| [electron/subscription/contract.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/contract.mjs) | 补充友好错误码文案（如 `cli_onboarding_required`） |
| [electron/subscription/ipc.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs) | 1. 在 `refreshUsage` 中遇到 `record.type === 'cli'` 时不再短路 `unsupported`，改调 `probeGeminiViaCliImpl`<br>2. 拿到真实 `email` 与 `usage` 后原子回写 `store`<br>3. 若遇 `cli_onboarding_required` 传回 `detail`，不将已登录账号错判为 `expired` |
| [src/features/cli-models/cli-models-view.js](file:///c:/Users/34119/Documents/Mova/src/features/cli-models/cli-models-view.js) | 1. `sortUsageWindows` 补充 `gemini-5h` → `gemini-weekly` → `gemini-argon-weekly` → `3p-5h` → `3p-weekly` 的展示排序<br>2. `usageReasonText` 支持展示 `cli_onboarding_required` 的引导提示（告知先在终端跑一次 `agy`） |
| **新建** `tests/subscription-gemini-usage-cli.test.mjs` | 覆盖真机 `/usage` 输出样本解析、百分比与 `Refreshes in` 换算、首次向导阻断、未登录态、旧快照 `stale` 降级与并发防抖 |

---

## 7. 验收验证标准

1. **单元测试（`node --test tests/subscription-gemini-usage-cli.test.mjs`）**：
   - 将本次真实抓取到的 3 区块 38 行样本喂给 `parseAgyUsageOutput`，准确产出一个真实邮箱与 5 条带 `usedPercent` / `resetsAt` 的窗口；
   - 模拟输出 `Choose your color scheme` / `Terms of Service` 时，在 100ms 内终止进程并精确返回 `cli_onboarding_required`。
2. **构建与回归**：`npm run typecheck`、`npm run build` 保持通过，不影响已有 `node --test` 基线。
3. **实机端到端验收**：
   - 在 Mova 设置 → 「CLI 模型」→ Gemini 卡片点击「刷新额度」：
     - 3~5 秒内卡片标题由 `本机 antigravity CLI` 自动刷新为 `bottarinathan780@gmail.com`，带 `Google AI Pro` 徽章；
     - 进度条完整呈现 Gemini 5 小时 / 每周窗口、Gemini 4 Argon 每周窗口以及第三方模型（Claude/GPT）配额与重置倒计时，数值与终端手动执行 `agy` → `/usage` 一致。
