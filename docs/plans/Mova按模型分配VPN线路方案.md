# Mova 按模型独立分配 VPN 线路架构方案

> **适用范围**：Mova（Electron 45 / Windows / Node 24 / React + CSS 设置页）  
> **核心目标**：让不同 AI 模型（如 `ChatGPT`、`Gemini`、`Claude`、国内模型/本地网关直连）**并发或交替使用各自专属的 VPN 节点**而不互相冲突；兼容读取用户本机 `Fxy`（FlClash/Mihomo）配置、剪贴板一键导入、订阅链接导入，并在设置页提供完整的「导入线路 → 测速 → 自动切换池 → 模型路由分配」闭环。

---

## 1. 本机实测事实与核心痛点

### 1.1 本机 `Fxy` 环境实测结论

通过对 `C:\Users\34119\AppData\Local\Programs\Fxy` 及用户配置目录的无敏结构探测，已确认以下事实：

1. **内核本质**：`Fxy.exe` 是 **FlClash**桌面端，底层运行 `FlClashCore.exe`（基于 **Mihomo / Clash.Meta** 内核），因此原生支持用户截图中的 **`Vless`** 与 **`Mieru`** 协议。
2. **配置文件实际落点**：
   - 运行态配置：`%APPDATA%\com.Speed17\fxy\config.yaml`
   - 订阅配置文件：`%APPDATA%\com.Speed17\fxy\profiles\<timestamp>.yaml`（含标准 Clash `proxies`、`proxy-groups`、`rules` 结构）
3. **关键限制（实测 `config.yaml`）**：
   - `mixed-port: 7890`
   - **`external-controller: ""`（空）**：`Fxy` 未开放标准 Clash REST 控制端口，而是通过私有本地 socket（实测 `127.0.0.1:55328` ↔ `55330`）控制内核。
   - **全局单出口互斥**：在 `Fxy` 里同一时间只能激活 1 个代理出口——切到 `[Gemini][家宽]台湾5` 时 ChatGPT 易触发地区限制或风控；切到 `[GPT]日本Cs9` 时 Gemini 无法命中家宽路由。

### 1.2 为什么不能靠“发消息前修改 Fxy 全局节点”？

1. **多模型并发必冲突**：用户一边用 Gemini 订阅对话，Mova 后台可能同时用另一模型生成会话标题、压缩上下文，或者用户同时打开两个对话分别跑 GPT 与 Gemini；全局切换节点会打断进行中的流式响应。
2. **污染电脑全局网络**：修改系统代理或 TUN 会影响浏览器及其他桌面应用。
3. **私有 IPC 耦合脆弱**：`Fxy` 未暴露标准 Clash REST API，耦合其内部 socket 会随客户端版本升级失效。

---

## 2. 核心网络架构：独立多端口分流内核 + 按模型注入代理

### 2.1 总体架构图

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Mova 设置页（一级导航：网络与线路 / data-settings-item="network"）            │
│  [1] 内核状态 + 三合一导入（剪贴板一键 / 订阅 URL / 读取本机 Fxy 配置）         │
│  [2] 策略池与节点测速网格（GPT 自动优选池 / Gemini 家宽池 / 延迟与状态卡片）    │
│  [3] AI 模型路由表（按 Provider 默认 + 单模型覆盖 + 失败切线开关 + 连通性检测） │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ IPC (vpn:*)
┌───────────────────────────────▼────────────────────────────────────────────┐
│ Mova 主进程（electron/vpn/*）                                               │
│  ├─ contract.mjs       : IPC 通道、错误码、数据结构与 UI 脱敏视图转换          │
│  ├─ parser.mjs         : 解析 Clash YAML / Base64 / vless,mieru,vmess 等 URI  │
│  ├─ fxy-import.mjs     : 只读扫描 %APPDATA%\com.Speed17\fxy\profiles\*.yaml   │
│  ├─ store.mjs          : safeStorage 加密存 vpn-profiles.enc；明文存路由表      │
│  ├─ mihomo-manager.mjs : 托管独立 Mihomo（无 TUN、无系统代理）                 │
│  │                        ├─ external-controller: 127.0.0.1:17900 (+secret)  │
│  │                        └─ listeners（每个策略池/固定节点独立本地端口）：       │
│  │                             127.0.0.1:17901 -> mova-pool:gpt_auto         │
│  │                             127.0.0.1:17902 -> mova-pool:gemini_auto      │
│  │                             127.0.0.1:17903 -> [固定节点名称]              │
│  └─ router.mjs         : 按 {providerId, modelId} 解析代理、构造 fetch/env、   │
│                          执行失败冷却与两级自动切线                            │
└───────┬──────────────────────────┬──────────────────────────┬──────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
 [ChatGPT 订阅 & HTTP API]   [Gemini 订阅 (agy acp)]    [本地网关 / 国内模型]
  undici.ProxyAgent           spawn env 注入:            直连 (无 ProxyAgent)
  + forceSseTransport=true    HTTP_PROXY / HTTPS_PROXY   显式绕过代理
  → 127.0.0.1:17901           ALL_PROXY=127.0.0.1:17902
                              NO_PROXY=127.0.0.1,localhost,::1
```

### 2.2 Mihomo 运行态配置报文示例（`userData/vpn-runtime/running.yaml`）

Mova 在运行期为独立托管的 `mihomo.exe` 动态生成 `running.yaml`（关闭系统代理与 TUN，只开启 loopback `listeners` 映射不同策略组与固定节点）：

```yaml
mixed-port: 0
allow-lan: false
mode: rule
log-level: warning
ipv6: true
unified-delay: true
external-controller: 127.0.0.1:17900
secret: "<随机32字节十六进制密钥>"
tun:
  enable: false

proxies:
  - name: "[GPT]日本Cs9"
    type: mieru
    server: "..."
    port: 12345
    transport: TCP
    multiplexing: MULTIPLEXING_HIGH
    username: "..."
    password: "..."
  - name: "[Gemini][家宽]台湾5"
    type: vless
    server: "..."
    port: 443
    uuid: "..."
    tls: true
    network: tcp
    flow: xtls-rprx-vision
    reality-opts:
      public-key: "..."
      short-id: "..."

proxy-groups:
  - name: "mova-pool:gpt_auto"
    type: url-test
    url: "https://chatgpt.com/favicon.ico"
    interval: 180
    tolerance: 50
    proxies:
      - "[GPT]日本Cs9"
      - "[GPT][IPv6]日本Cs9"
      - "[GPT]美国cc2"
  - name: "mova-pool:gemini_auto"
    type: fallback
    url: "https://www.gstatic.com/generate_204"
    interval: 180
    proxies:
      - "[Gemini][家宽]台湾5"
      - "[Gemini][家宽]台湾4"

listeners:
  - name: mova-in-1
    type: mixed
    listen: 127.0.0.1
    port: 17901
    proxy: "mova-pool:gpt_auto"
  - name: mova-in-2
    type: mixed
    listen: 127.0.0.1
    port: 17902
    proxy: "mova-pool:gemini_auto"

rules:
  - MATCH,DIRECT
```

> **端口冲突规避**：生成配置前通过 `net.createServer().listen(port, '127.0.0.1')` 从 `17900` 起依次探测空闲端口；既不会与用户桌面 `Fxy` 的 `7890` 冲突，也不会在重启/多开时抢端口失败。

### 2.3 三类模型执行引擎的精准源码级接入点

结合 Mova 现有源码实读结果，精确接入点如下：

1. **普通 HTTP API Provider（OpenAI / Anthropic / DeepSeek / 自定义兼容服务）**
   - `node_modules` 已内置 `undici`（含 `ProxyAgent`）。
   - 在 [model-ipc.cjs](file:///c:/Users/34119/Documents/Mova/electron/model-ipc.cjs#L458) 调用 `runChatAgent` 时注入 `fetchModel`：
     - 当路由为池/固定节点且内核给出端口 `17901` 时，使用按代理 URL 缓存复用的 `new ProxyAgent('http://127.0.0.1:17901')` 发起 `undici.fetch(url, { ...init, dispatcher })`；
     - 当路由为「直连」时，不挂 dispatcher（或使用直连 `Agent`），确保不受系统代理开关影响。
   - **扩展点**：`providers:fetch` 拉取模型目录也可按 `provider.id` 走同一路由逻辑。

2. **ChatGPT 订阅通道（`subscription:chatgpt`）**
   - **关键源码陷阱验证**：在 [chat-agent.mjs](file:///c:/Users/34119/Documents/Mova/electron/chat-agent.mjs#L812-L820)，`streamFor` 调用 `@earendil-works/pi-ai/api/openai-codex-responses` 的 `streamSimple`。`pi-ai` 1.5.0 默认 `transport: 'auto'`，会优先尝试 `globalThis.WebSocket`（原生的 `WebSocket` **完全忽略 `options.fetch` 和 `ProxyAgent`**，导致流量从本地直连或系统代理泄露）。
   - **解决方式**：当模型启用了按模型 VPN 代理时，`model-ipc.cjs` 向 `agentRequest` 传标记（如 `forceSseTransport: true`），`streamFor` 收到后显式传 **`transport: 'sse'`**，强制 `openai-codex-responses` 100% 通过受控的 `guardedFetch` → `fetchModel`（`ProxyAgent`）出站。
   - **登录与额度刷新**：[ipc.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs) 中的 `exchangeCode`、`refreshAccessToken` 与 `probeChatgpt`（`wham/usage`）统一通过 `vpnRuntime.fetchForProvider('subscription:chatgpt')` 发出；同时 OAuth 浏览器回调服务器仅监听 `127.0.0.1:1455`，不受出站代理干扰。

3. **Gemini 订阅通道（`subscription:gemini`，即 `agy.exe acp`）**
   - 在 [model-ipc.cjs](file:///c:/Users/34119/Documents/Mova/electron/model-ipc.cjs#L753-L778) `buildAcpRequest` 读取 `vpnRuntime.envForModel('subscription:gemini', model.id)`，透传至 [chat-agent.mjs](file:///c:/Users/34119/Documents/Mova/electron/chat-agent.mjs#L1076-L1089) `runAcpSubscriptionTurn` → [engine.mjs](file:///c:/Users/34119/Documents/Mova/electron/acp/engine.mjs) → `client.start({ env })`：
     ```js
     {
       ...process.env,
       HTTP_PROXY: 'http://127.0.0.1:17902',
       HTTPS_PROXY: 'http://127.0.0.1:17902',
       ALL_PROXY: 'http://127.0.0.1:17902',
       NO_PROXY: '127.0.0.1,localhost,::1',
       http_proxy: 'http://127.0.0.1:17902',
       https_proxy: 'http://127.0.0.1:17902',
       all_proxy: 'http://127.0.0.1:17902',
       no_proxy: '127.0.0.1,localhost,::1',
     }
     ```
   - **为什么 `NO_PROXY` 必须带 `127.0.0.1,localhost,::1`**：`runAcpSubscriptionTurn` 在本机回环随机端口启动 `mova-tools` HTTP MCP Server（[chat-agent.mjs](file:///c:/Users/34119/Documents/Mova/electron/chat-agent.mjs#L1102-L1105)）供 `agy` 回调；若不放行回环地址，`agy` 会尝试通过台湾/日本代理回连本机导致 MCP 工具全部超时。
   - **Gemini 登录与模型枚举同步走代理**：[subscription/ipc.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs#L1283-L1309) 的 `acpDescribeCli`、`acpLoginCli`、`acpForceReloginCli`、`acpLogoutCli` 同步注入该环境变量。

---

## 3. Mihomo 内核获取与兜底机制

1. **发现与启动优先级**：
   1. 用户在设置页手动选择的本地可执行文件（`core.binaryPath`）；
   2. Mova 内置托管目录：`userData/bin/mihomo.exe`（Windows amd64）。
2. **一键下载与完整性校验流程**：
   - 请求 GitHub API `https://api.github.com/repos/MetaCubeX/mihomo/releases/latest`，筛选 `mihomo-windows-amd64-compatible-*.zip`（兼容有无 AVX2 的 Windows x64 CPU，备选 `mihomo-windows-amd64-v*.zip`）。
   - **网络自举**：若国内网络直连 GitHub 失败且配置中的兜底代理（默认 `http://127.0.0.1:7890`）TCP 探测可达，自动临时借道该代理完成内核下载，无需用户手动翻墙去下内核。
   - **SHA256 严格校验**：核对 Release Asset 自带 `digest`（`sha256:...`）或 `SHA256SUMS`/`Checksums.txt`；校验通过后临时解压并原子覆盖到 `userData/bin/mihomo.exe`。
3. **未安装 Mihomo 前的平滑兜底模式（Single-Port Fallback）**：
   - 若用户暂未下载 `mihomo.exe` 且本机 `Fxy`（`127.0.0.1:7890`）正在运行：
     - 依然支持读取 Fxy 配置 / 导入订阅 / TCP 握手机制测首跳延迟；
     - 允许将模型流量先暂借 `127.0.0.1:7890` 出站，同时界面清晰提示：**「当前处于单口兜底模式（7890），同一时刻共享同一出口；下载/启用 Mihomo 内核后可开启多模型并发异地分流」**。

---

## 4. 设置界面功能设计与视觉规范对齐

### 4.1 严格遵循 Mova 设计规范

依据 [Mova设置页设计规范.md](file:///c:/Users/34119/Documents/Mova/Mova设置页设计规范.md) 及实查结果：
1. **导航与图标**：在 [index.html](file:///c:/Users/34119/Documents/Mova/index.html#L230-L263) 设置导航栏加入 `<button class="settings-item" data-settings-item="network">`（名称：**网络与线路**）。注意 [icons.js](file:///c:/Users/34119/Documents/Mova/icons.js#L12-L34) 仅映射白名单图标，这里应选用已注册的 `ph-gauge`（或 `ph-globe`），避免图标加载警告。
2. **页面骨架**：采用 `.settings-panel-head` + `.settings-page` 居中内容列（`--content-column: min(718px, calc(100% - 48px))`）；完全复用 `src/features/cli-models/cli-models-parts.jsx` 中的 `CmDialog`、`CmSelect`、`CmSwitch`、`CmToastStack`。
3. **色彩克制**：沿用暗色阶 `#181818` / `#1e1e1e` / `#2f2f2f`，强调色仅用蓝色 `#5b9bf0`；节点卡片使用紧凑中性深底 + 选中态细蓝边框（1px `#5b9bf0`），延迟数字按绿（`<300ms`）/ 琥珀（`>=300ms`）/ 红（`Timeout`）区分。

### 4.2 自上而下的页面三段结构

```text
┌───────────────────────────────────────────────────────────────────────┐
│ 网络与线路                                                             │
├───────────────────────────────────────────────────────────────────────┤
│ 1. 分流引擎与线路导入                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ ● 独立分流内核运行中 · 已开启 2 个模型端口 (17901 / 17902)        │ │
│  │                          [一键测速] [选择内核] [一键下载内核]    │ │
│  ├─────────────────────────────────────────────────────────────────┤ │
│  │ [ 剪切板一键导入 ]   [ 导入订阅链接… ]   [ 读取本机 Fxy 配置 ]     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  已导入来源（Fxy · 机场配置 / 订阅链接 · 剩余 412 GB · 刷新 | 删除）   │
│                                                                       │
│ 2. 自动切换池 & 全部线路（测速与切换）                                  │
│  策略池：                                                             │
│   · GPT 自动优选池 (url-test · 17901) 当前：[GPT]日本Cs9 (216ms) [编] │
│   · Gemini 家宽池 (fallback · 17902) 当前：[Gemini][家宽]台湾5   [编] │
│   · [+ 新建线路池]                                                     │
│  筛选：[全部 | Fxy | 订阅 | 自建]  标签：[全部 | GPT | Gemini | 家宽]   │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐      │
│  │ 🇺🇸[GPT]美国cc2   │ │ 🇯🇵[GPT]日本cc31  │ │ 🇯🇵[GPT]日本Cs9   │      │
│  │ Vless  ·  Timeout │ │ Vless  ·  Timeout │ │ Mieru  ·  216 ms │      │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘      │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐      │
│  │ 🇯🇵[GPT][IPv6]Cs9 │ │ 🇹🇼[Gemini][家宽]4 │ │ 🇹🇼[Gemini][家宽]5 │      │
│  │ Mieru  ·  179 ms │ │ Mieru  ·  Timeout │ │ Mieru  ·  563 ms │      │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘      │
│                                                                       │
│ 3. AI 模型线路分配（实时读取 providers:list 含内置订阅与自建 Provider） │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ ChatGPT（订阅）     [⚡ GPT 自动优选池 ▾]  自动切线[开] [连通测试] │ │
│  │   ├─ GPT-6.1-Sol    [继承 Provider ▾]                           │ │
│  │   └─ GPT-6-Astra    [🇺🇸 美国cc2 (固定) ▾]                       │ │
│  ├─────────────────────────────────────────────────────────────────┤ │
│  │ Gemini（订阅）      [⚡ Gemini 家宽池 ▾]   自动切线[开] [连通测试] │ │
│  │   ├─ Gemini 4 Argon [继承 Provider ▾]                           │ │
│  │   └─ Claude Opus 5.5[继承 Provider ▾]                           │ │
│  ├─────────────────────────────────────────────────────────────────┤ │
│  │ 本地网关 / DeepSeek [直连（不走 VPN） ▾]   自动切线[关]           │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

#### 三项核心交互要点
1. **剪切板一键导入**：点按立即读系统剪贴板并自动判断形态：
   - 单个 `https://...` 订阅 URL（如 `https://xn--2dk290r.xn--p8jhn1a2d1epgoe.com/s/...`）→ 弹窗预览名称后拉取并加密入库；
   - Base64 编码节点列表 → 解码提取全部节点；
   - 单条/多行 URI（`vless://`、`mieru://`、`vmess://`、`trojan://`、`ss://`、`hy2://`、`hysteria2://`、`tuic://`）→ 立即导入「剪贴板线路」源；
   - Clash/Mihomo YAML 文本（含 `proxies:`）→ 直接解析透传原始字段。
2. **全部测速**：通过 Mihomo Controller `/proxies/<encName>/delay` 并发测速（支持选目标：`通用 204` / `chatgpt.com` / `googleapis.com`），实时经 `vpn:event` 回推进度并更新卡片延迟。
3. **AI 模型线路分配与连通测试**：读取 `providers.listProviders()`（含 `subscription:chatgpt`、`subscription:gemini` 及所有用户自定义 HTTP Provider），支持「Provider 组默认路由 + 单模型独立覆盖」；点「连通测试」直接用该模型实际生效端口请求目标端点（如 `chatgpt.com/cdn-cgi/trace` 或 `daily-cloudcode-pa.googleapis.com`），反馈真实出口地区与 RTT。

---

## 5. 两级自动故障切换与账号池的正交边界

| 维度 | 触发条件 | 执行动作 | 负责模块 |
| :--- | :--- | :--- | :--- |
| **第一级：内核周期探活** | 定时 `url-test` / `fallback` 探测超时或超出延迟容差 `tolerance` | Mihomo 自动在组内切至延迟最低或最高优先级的健康节点 | `mihomo-manager.mjs`（Mihomo 内核原生） |
| **第二级：应用层请求熔断切线** | `ECONNRESET` / `ETIMEDOUT` / `fetch failed` / 代理握手失败 / Cloudflare-地区拦截特征 HTTP `403`（非登录令牌失效） | 1. 将当前池内活跃节点加入内存冷却（如 5 分钟）<br>2. 选池内下一个未冷却最优节点调 `PUT /proxies/<group>`<br>3. 本轮请求自动重试（最多切线 2 次） | `router.mjs` + `model-ipc.cjs` |
| **正交边界：账号额度/过期切换** | HTTP `401`、`429 usage_limit_reached`、额度耗尽 | **绝不误切 VPN 节点**，交由订阅账号调度池切换下一个账号并冷却原账号 | `electron/subscription/pool.mjs` |

> **优先级判定顺序**：若单轮请求既分配了自动池又使用多账号订阅：连接失败 / 代理超时 / 403 CF 拦截先触发「切线路重试」；认证失效（401）或用量封顶（429 `usage_limit_reached`）则触发「切账号重试」。

---

## 6. 凭据安全存储、IPC 契约与错误码规范

### 6.1 安全存储规范

1. **`userData/vpn-profiles.enc`（DPAPI 加密文件）**：
   - 使用 Electron 45 `safeStorage.isAsyncEncryptionAvailable()` 检查后通过 `encryptStringAsync` / `decryptStringAsync` 读写；注意 **Electron 45 的 `decryptStringAsync` 返回 `{ result: string }`**（[model-credentials.cjs](file:///c:/Users/34119/Documents/Mova/electron/model-credentials.cjs#L43)），封装层兼容对象 `.result` 与纯字符串返回。
   - 存放订阅源原文 URL（含用户私人 token）及完整 `raw` 节点凭据（`uuid`、`password`、`reality-opts`）。
   - 加密不可用时直接返回 `credential` 错误并拒绝写盘，**绝不降级成明文**。
2. **`userData/model-vpn-routes.json`（明文 JSON，不含任何密钥）**：
   - 存放 `core`（模式/路径/端口段）、`pools`（策略池规则，只引用 `nodeId`）、`routes`（Provider 默认路由）、`modelOverrides`（`providerId/modelId` 级覆盖）。
3. **严禁外泄红线**：
   - 返回给渲染进程的永远是脱敏对象（订阅 URL 只留 `https://host/prefix/…` 摘要，节点只留 `serverHint: "123.…89:443"` + 名称/协议/标签/延迟）；
   - 日志只记录 `sourceId`、`nodeId`、端口和错误码，绝不打印节点密码、UUID 或完整订阅链接。

### 6.2 IPC 通道契约清单（`electron/vpn/contract.mjs`）

所有通道统一返回 `{ ok: true, value }` 或 `{ ok: false, error, message }`：

| IPC 通道 | 请求参数 | 返回值 `value` 说明 |
| :--- | :--- | :--- |
| `vpn:status` | 无 | `{ cryptoOk, core, subscriptions, nodes, routes }`（全量脱敏快照） |
| `vpn:import-clipboard` | `{ text?: string }` | 若未传 `text`，主进程读 `clipboard.readText()`；返回 `{ kind, subscription?, nodesAdded, url? }` |
| `vpn:import-subscription` | `{ url, name?, autoUpdateHours? }` | 带 `clash.meta` UA 拉取并加密入库，解析 `subscription-userinfo`；返回 `{ subscription, nodeCount }` |
| `vpn:refresh-subscription` | `{ id }` | 重新拉取已加密保存的订阅链接并刷新节点 |
| `vpn:remove-subscription` | `{ id }` | 删除订阅源及其下节点，同步重启/重载 Mihomo 配置 |
| `vpn:scan-fxy` | 无 | 只读扫描 `%APPDATA%\com.Speed17\fxy\profiles\*.yaml`，返回 `{ found, profiles }` |
| `vpn:import-fxy` | `{ profileId?: string }` | 导入选中或全部 Fxy 配置文件并重建 Mihomo `listeners` |
| `vpn:test-delays` | `{ nodeIds?: string[], testUrl?: string }` | 并发测速（过程通过 `vpn:event` 推送 `delay` 增量），返回 `{ results }` |
| `vpn:pool:save` | `{ id?, name, strategy, tagFilter, nodeIds, testUrl?, intervalSec?, toleranceMs? }` | 新建或更新策略池并分配独立 listener 端口 |
| `vpn:pool:delete` | `{ id }` | 删除策略池并把指向该池的模型路由清理回 `direct` |
| `vpn:pool:select-node` | `{ poolId, nodeId }` | 手动指定策略池当前首选节点（`PUT /proxies/<group>`） |
| `vpn:routes:get` | 无 | 返回 `{ routes, modelOverrides, core }` |
| `vpn:routes:set` | `{ routes?, modelOverrides?, core? }` | 原子更新路由表并按需重建 Mihomo `listeners` |
| `vpn:probe-model` | `{ providerId, modelId }` | 通过该模型当前生效端口探测真实出口域名与耗时 `{ viaProxy, nodeName, latencyMs, detail }` |
| `vpn:core:action` | `{ action: 'start' \| 'stop' \| 'restart' \| 'sync' }` | 控制 Mihomo 内核启停与配置重同步 |
| `vpn:core:pick-path` | 无 | 弹出原生文件选择框选取 `mihomo.exe`，成功则写入 `core.binaryPath` |
| `vpn:core:download` | 无 | 从 GitHub Release 拉取 Windows amd64 压缩包、SHA256 校验并解压至 `userData/bin/mihomo.exe` |
| `vpn:event` *(主→渲)* | — | 推送 `{ kind: 'status' \| 'delay' \| 'failover' \| 'download', ... }` |

### 6.3 错误码与用户可见中文文案映射

| 错误码 | 用户可见中文文案 |
| :--- | :--- |
| `empty_input` | 未识别到有效线路配置或订阅链接 |
| `parse_failed` | 线路格式解析失败，请确认内容为 Clash YAML、节点链接或订阅链接 |
| `subscription_fetch` | 订阅链接拉取失败（支持附带 HTTP 状态码或超时提示） |
| `fxy_not_found` | 未在本机发现 Fxy 配置目录 |
| `credential` | 系统安全存储不可用，无法加密保存线路凭据 |
| `core_missing` | 尚未安装 Mihomo 内核，请先一键下载或选择本地可执行文件 |
| `core_start_failed` | Mihomo 内核启动失败，请检查配置或端口占用 |
| `core_download_failed` | Mihomo 内核下载或校验失败 |
| `port_exhausted` | 本地空闲端口不足，无法为该线路分配监听端口 |
| `node_unavailable` | 所选线路节点不可用或已超时 |
| `probe_failed` | 连通性检测未通过 |

---

## 7. 完整模块清单与接线步骤

### 7.1 主进程模块（`electron/vpn/`）

1. `electron/vpn/contract.mjs` — IPC 通道、错误类、标签识别与脱敏视图投影。
2. `electron/vpn/parser.mjs` — 基于 `yaml` 解析 Clash/Mihomo YAML，纯 JS 解析 Base64 及 `vless / mieru / vmess / trojan / ss / hy2 / hysteria2 / tuic` URI，解析 `subscription-userinfo`。
3. `electron/vpn/fxy-import.mjs` — 可注入式扫描/读取 `%APPDATA%\com.Speed17\fxy\profiles\*.yaml`。
4. `electron/vpn/store.mjs` — `vpn-profiles.enc`（DPAPI 加密 + 串行写链）与 `model-vpn-routes.json`（明文路由与池配置）。
5. `electron/vpn/mihomo-manager.mjs` — 动态空闲端口探测、生成多 `listeners` 的 `running.yaml`、Mihomo 进程守护、Controller API 测速/切节点、GitHub Release 一键下载 + SHA256 校验、单口兜底探测。
6. `electron/vpn/router.mjs` — 单模型/Provider 路由优先级解析（`modelOverrides["providerId/modelId"]` > `routes[providerId]` > `direct`）、按端口缓存 `undici.ProxyAgent`、生成 ACP 子进程 `env`（含 `NO_PROXY`）、两级故障熔断切换器。
7. `electron/vpn/ipc.mjs` & `electron/vpn/runtime.mjs` — 装配全量 `vpn:*` IPC 与单例运行时暴露。

### 7.2 现有模块最小接线

- [electron/main.cjs](file:///c:/Users/34119/Documents/Mova/electron/main.cjs)：在 `installSubscriptionIpc` 之前初始化 `installVpnIpc`（带容错 try/catch），在 `before-quit` 中调用 `vpnIpc?.dispose()` 清理 Mihomo 子进程。
- [electron/model-ipc.cjs](file:///c:/Users/34119/Documents/Mova/electron/model-ipc.cjs)：
  - 普通 HTTP 模型与 `subscription:chatgpt` 通过 `vpnRuntime.withModelFetch` 包装 `runChatAgent`（若代理启用则标 `forceSseTransport: true`）；
  - `subscription:gemini` 在 `buildAcpRequest` 读取 `vpnRuntime.envForModel('subscription:gemini', model?.id)` 附着到 `acpEnv`。
- [electron/chat-agent.mjs](file:///c:/Users/34119/Documents/Mova/electron/chat-agent.mjs)：
  - `runAcpSubscriptionTurn` 将 `request.acpEnv` 传给 `engine.runTurn`；
  - `streamFor` 在 `isChatgptSubscription(provider)` 且开启代理时附带 `transport: 'sse'`。
- [electron/subscription/ipc.mjs](file:///c:/Users/34119/Documents/Mova/electron/subscription/ipc.mjs)：`httpFetch` 与 `acp*Cli` 在可用时优先走 `vpnRuntime` 的 Provider 专属出口。
- [electron/preload.cjs](file:///c:/Users/34119/Documents/Mova/electron/preload.cjs) & [src/app/desktop.d.ts](file:///c:/Users/34119/Documents/Mova/src/app/desktop.d.ts)：暴露 `window.movaDesktop.vpn`。

### 7.3 前端设置页（`src/features/vpn/` + `index.html` / `app.js`）

- `src/features/vpn/vpn-settings.jsx`：三段页面编排。
- `src/features/vpn/vpn-import-dialog.jsx`：订阅导入与 Fxy 选择弹窗。
- `src/features/vpn/use-vpn.js`：状态管理、事件流订阅与演示数据降级兜底。
- `src/features/vpn/vpn-settings.css`：样式补充（遵守 `--mova-settings-*` token）。
- [index.html](file:///c:/Users/34119/Documents/Mova/index.html) & [app.js](file:///c:/Users/34119/Documents/Mova/app.js)：注册导航项 `data-settings-item="network"` 与懒挂载页面宿主 `#settings-page-network`。

---

## 8. 依赖选型、已确认决策与测试验收计划

### 8.1 已确认的两项技术决策

1. **YAML 解析策略**：使用零传递依赖 npm 包 `yaml`（`2.9.1`）专门解析与生成 Clash/Mihomo YAML，确保稳定兼容各类 `Vless`（Reality/WS/gRPC）与 `Mieru` 复杂嵌套字段。
2. **Mihomo 内核分发与兜底策略**：采用「设置页一键下载官方 Windows amd64 包并校验 SHA256 至 `userData/bin/mihomo.exe` + 支持手动选择本地路径」为主方案；在未下载内核前平滑支持 `127.0.0.1:7890` 单口兜底。

### 8.2 验收与实机测试清单

1. **纯 Node 单元测试（`node --test tests/vpn-*.test.mjs`）**：
   - `vpn-parser.test.mjs`：验证 `Vless`（含 Reality）、`Mieru`、`VMess`、`Trojan`、`SS`、`Hysteria2`、`TUIC` 分享链接及 Base64/YAML 混合输入解析、`subscription-userinfo` 解析与重名去重。
   - `vpn-fxy-import.test.mjs`：注入模拟 `%APPDATA%\com.Speed17\fxy\profiles\*.yaml`，验证只读扫描、空目录容错及脱敏预览（不含任何密钥原文）。
   - `vpn-router.test.mjs`：验证 `buildMihomoRuntimeConfig` 为不同池生成互异的 `listeners` 端口且 `tun.enable === false`、`mixed-port === 0`；验证 `modelOverrides` > `routes` > `direct` 优先级；验证 403/网络超时触发切线重试，而 401/429 额度用尽不误切线路。
   - `vpn-store-ipc.test.mjs`：验证 `safeStorage` 返回 `{ result }` 与字符串两种契约、加密不可用时拒绝写入、IPC 脱敏输出。
2. **构建与类型检查**：`npm run typecheck`、`npm run lint`、`npm run build` 全部通过且不破坏既有 `node --test` 基线。
3. **实机端到端双模型并发验真**：
   - 开启独立 Mihomo 内核后，为 `ChatGPT` 分配「GPT 自动优选池（端口 `17901`）」，为 `Gemini` 分配「Gemini 家宽池（端口 `17902`）」，同时保留 `Fxy` 本机窗口关闭或停留在不同节点；
   - 分别点两行「连通测试」，核实两者握手延迟与出口归属独立；
   - 在 Mova 中同时或连续发送一条 `ChatGPT` 对话和一条 `Gemini`（`agy acp`）带工具调用对话：核实 ChatGPT 长流式输出完整（验证 `transport: 'sse'` 生效）、Gemini 正常返回且能回调本地 MCP 工具（验证 `NO_PROXY=127.0.0.1,localhost,::1` 生效）。

---

## 9. 附：当前工作区状态说明（在停止实作改为仅出方案文档前）

> 在收到「只写 md 方案、暂不实际实施」澄清前，工作区已有如下前期改动：
> - **依赖清单**：通过 `npm install yaml --save-exact` 在 `package.json`（及 `package-lock.json` / `node_modules/`）添加了 `yaml@2.9.1`。
> - **新建未接线的草稿模块（`electron/vpn/`）**：
>   - `electron/vpn/contract.mjs`
>   - `electron/vpn/parser.mjs`
>   - `electron/vpn/fxy-import.mjs`
>   - `electron/vpn/store.mjs`
> - **现有项目代码零改动**：`electron/main.cjs`、`electron/model-ipc.cjs`、`electron/chat-agent.mjs`、`electron/preload.cjs`、`electron/subscription/ipc.mjs`、`index.html`、`app.js`、`src/*` 及全部测试文件**均未被修改**，对当前 Mova 运行与构建没有任何影响。如果你希望保持工作区完全干净，我可以随时帮你删除 `electron/vpn/` 这 4 个文件并卸载 `yaml`。
