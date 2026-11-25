# Mova 结构说明（docs/architecture.md）

> 这是本仓库**唯一**的结构说明（`docs/conventions.md` §6）。其它文档提到目录时请链接到这里，不要复制树状图。
> 开发硬规则见 [`conventions.md`](conventions.md)；方案文档索引见 [`plans/README.md`](plans/README.md)。

**一句话**：Electron 45 单机桌面端，主进程 `electron/`（`.cjs` + `.mjs` 混合），渲染层是 `index.html` + 根 `app.js` 主导的 React 原型，经 `scripts/build.mjs` 打包成 `dist/` 后由主进程以 `mova://app/index.html` 加载。

---

## 1. 目录树（真实，2–3 层）

```text
Mova/
├─ index.html  app.js  styles.css        # 渲染层三件套：活源码，必须留在根目录
├─ keyline-icons.css                     # 被 index.html 直接 link
├─ package.json  vite.config.js  tsconfig.json  tsconfig.electron.json  eslint.config.js
├─ README.md  THIRD_PARTY_NOTICES.md  docker-compose.yml  .env.example
├─ docs/
│  ├─ architecture.md                    # 本文件
│  ├─ conventions.md                     # 开发规范（先读）
│  ├─ plans/                             # 25 份方案/设计/报告 md + README.md 索引
│  └─ prototypes/                        # 两份已审查的视觉基准 HTML（cli-models-settings / schema-form-card）
├─ electron/                             # 主进程
│  ├─ main.cjs                           # 唯一入口：窗口、IPC 装配、mova:// 协议
│  ├─ stdio-guard.cjs                    # stdout/stderr 的 EPIPE 守卫（main.cjs 第一条语句）
│  ├─ session-sync.cjs                   # 会话合并/删除意图（mergeRows / mergeSessions）
│  ├─ preload.cjs                        # contextBridge 暴露 window.movaDesktop
│  ├─ model-ipc.cjs  chat-agent.mjs      # 聊天主链路（见 §4）
│  ├─ agent-tools.cjs  permissions.cjs  approvals.cjs   # 工具/权限/审批三件套
│  ├─ memory-ipc.cjs  memory-store.cjs  memory-runtime.cjs
│  ├─ edge-bridge.cjs  edge-files.cjs    # Edge 扩展桥
│  ├─ providers.cjs  model-credentials.cjs  subscription-models.cjs
│  ├─ acp/          client.mjs engine.mjs gate.mjs translate.mjs
│  ├─ bots/         README.md            # ★ 预留：MovaBot 服务端运行时（只有说明）
│  ├─ browser/      controller.cjs cdp.cjs snapshot.cjs tools.cjs policy.cjs …（含 *.test.cjs）
│  ├─ context/      ledger.mjs budget.mjs summarize.mjs pending.mjs wiring.mjs tools.mjs digest.mjs
│  ├─ db/           migrate.cjs postgres-repository.cjs postgres-store.cjs migrations/
│  ├─ desktop/      index.cjs actions.cjs input.cjs capture.cjs policy.cjs interlock.cjs …（host/ overlay/ vision/）
│  ├─ logging/      index.mjs logger.mjs redact.mjs rotate.mjs watchdog.mjs ipc-trace.mjs
│  ├─ mcp/          server.mjs tools.mjs normalize.mjs
│  ├─ search/       index.cjs providers.cjs passage.cjs fuse.cjs citation.cjs cache.cjs budget.cjs score.cjs url.cjs providers/
│  ├─ services/     memory-*.cjs subscription-service.mjs subscription-login.mjs queue.cjs quota.cjs pitr.cjs
│  ├─ skills/       index.mjs registry.mjs manifest-schema.mjs discover.mjs events.mjs approval-bridge.mjs adapters/ packs/
│  ├─ subscription/ acp-auth.mjs cli.mjs codex-oauth.mjs codex-auth.mjs gemini-login.mjs login.mjs ipc.mjs pool.mjs usage.mjs store.mjs runtime.mjs
│  └─ vpn/          contract.mjs parser.mjs store.mjs fxy-import.mjs
├─ src/                                  # 渲染层
│  ├─ app/          main.tsx（唯一 script 入口）window-controls.tsx desktop.d.ts
│  ├─ data/         demo-transcript.js
│  ├─ features/     approvals ask bot botchat browser changes chat cli-models composer contacts
│  │                design desktop mcp media memory permissions projects sidebar ui
│  ├─ services/     mova-client.ts desktop-model-client.ts mock-mova-client.ts
│  └─ shared/       icons.js              # 图标映射（静态 i.ph → SVG / React icon()）
├─ scripts/                              # 构建、运维、可重复冒烟
│  ├─ build.mjs  build-edge.mjs  prepare-*.mjs  open-pencil-vite.mjs
│  ├─ accept.mjs                         # 一条命令跑测试+类型检查+构建并与基线比对
│  ├─ db-migrate.mjs  services.mjs  pitr.mjs  collect-logs.mjs
│  ├─ desktop-*.cjs  design-*-check.cjs  browser-benchmark.cjs  popup-test.cjs
│  └─ probes/                            # 一次性探针（不进测试门禁，随时可删）
├─ tests/                                # node --test（desktop/ 与 helpers/ 子目录 + 一模块一文件）
├─ mobile/                               # 独立 Expo SDK 58 / React Native / TypeScript iOS 客户端
│  ├─ src/app/                           # 根原生 Stack、主聊天工作区、原生 settings、chat/[id]、setup
│  ├─ src/components/ src/features/chat/ src/theme/   # 平台控件、演示状态、系统主题
│  └─ tests/ assets/ app.json eas.json package*.json tsconfig.json  # 独立依赖与校验
├─ assets/  design/  vendor/  edge-extension/
├─ dist/  dist-edge/                     # 生成物，禁止手改
└─ .mova-backups/  .code-backups/  mova-logs/   # 回滚快照与运行日志（不进工作树视野）
```

## 2. 进程与加载链

移动端是独立入口：`mobile/package.json` → `expo-router/entry` → `mobile/src/app/_layout.tsx` → 聊天工作区与原生设置页面栈。当前只有明确标识的内存演示会话，没有真实模型、服务连接或桌面 IPC。新 UI 使用原生 Liquid Glass、会话抽屉、双态输入栏和 SwiftUI Toggle；Web 和旧系统使用清晰的深色表面回退。启动、手机步骤和云构建见 [iOS 开发环境与框架](plans/Mova-iOS开发环境与框架.md)。桌面构建不包含此工程。

```text
electron/main.cjs
   └─ 注册 mova:// 协议 → 只加载 dist/
dist/index.html                     ← scripts/build.mjs 从根 index.html 生成
   ├─ ./styles.css  ./keyline-icons.css  ./project-dialog.css   （静态拷贝）
   ├─ <script src="./project-popover.js" defer>                 （IIFE，经典脚本）
   └─ <script src="./app.js" defer>                             （打包产物）
dist/app.js  ← vite 以 src/app/main.tsx 为唯一入口打成单文件 IIFE
src/app/main.tsx
   └─ import '../../app.js'          ← 根 app.js 是活的 UI 主控，不是生成物
        └─ 静态 import 各 feature：./src/features/<feature>/…、./src/shared/icons.js、./src/services/…
```

- 开发时 `npm run dev`（vite）直接服务根 `index.html`；`project-dialog.css` / `project-popover.js`
  的源码在 `src/features/projects/`，由 `vite.config.js` 的 `legacyRootAssets()` 在 dev 下把
  `/project-dialog.css`、`/project-popover.js` 两个旧扁平 URL 指回源码；`npm run build` 用
  `scripts/build.mjs` 的 `[source, destination]` 表把它们拷成同名文件到 `dist/`。
- 构建是**单文件 IIFE**：动态 `import()` 分包不可用，任何库都必须静态内联。

**启动动画与窗口**（都是「首帧就在最终窗口里」，不换窗口、不缩窗）：

```text
main.cjs createWindow()
   ├─ 尺寸：TARGET_WINDOW 2300×1450（物理像素）→ /display.scaleFactor → 夹进 workArea
   ├─ 图标：assets/app-icon.png（由 scripts/make-icon.cjs 从 SVG 生成，另有 app-icon.ico 供打包）
   └─ ready-to-show → win.show()      ← 第一帧画的就是 #boot-splash 覆盖层
dist/index.html  #boot-splash（position:fixed 覆盖层）
   └─ <iframe src="./splash/mova-startup.html" sandbox="allow-scripts">
dist/splash/*  ← scripts/build.mjs 从 electron/splash/ 拷贝（源是 scripts/split-splash.mjs 拆出来的）
app.js initializeMemory().finally(hideBootSplash)   ← 会话与记忆读回来才揭开，最少播 1.8s
```

**preload 暴露面**（`electron/preload.cjs`，`contextBridge.exposeInMainWorld('movaDesktop', …)`）：
`act`、`isMaximized`、`clipboard`、`siteIcon`、`projects`、`design`、`mcp`、`ask`、`preview`、
`browser`、`edge`、`desktop`、`permissions`、`changes`、`files`、`approvals`、`titles`、`memory`、
`providers`、`model`、`search`、`subscription`。
渲染层只允许用这些命名空间，新增全局变量视为破坏契约（类型见 `src/app/desktop.d.ts`）。

## 3. 主进程模块职责（`electron/` 每个子目录一句话）

| 目录 | 职责 |
| --- | --- |
| `acp/` | ACP 客户端/引擎/闸门/事件翻译：把本机 CLI（`agy acp`）当成外部 agent 运行时，并与 Mova 的工具、权限对齐。 |
| `bots/` | ★ 预留：MovaBot 服务端运行时（Bot 定义解析、会话编排、能力挂载）；现在只有 `README.md`。 |
| `browser/` | 内置浏览器/Edge 的 CDP 控制：快照、读取、动作、批处理、站点技能、凭据与计时。 |
| `context/` | 上下文账本与压缩：按段计数、超预算摘要、压缩队列与工具注入。 |
| `db/` | Postgres 迁移与仓储（会话、记忆、任务），含 `migrations/`。 |
| `desktop/` | 桌面（Computer Use）引擎：截图、元素与坐标、输入注入、互锁与审计。 |
| `logging/` | 运行日志：logger、脱敏、轮转、IPC trace、看门狗。 |
| `mcp/` | MCP 服务端：工具描述归一化与 `tools/call` 分发。 |
| `search/` | 联网检索层：多源 provider、正文选段、重排融合、引用校验与缓存预算。 |
| `services/` | 跨功能后台服务：记忆抽取/维护/检索、会话存档、队列、配额、备份与 PITR、订阅服务聚合。 |
| `skills/` | 本地能力的单一事实源：manifest + handlers + adapters（pi-ai / MCP），见 `skills/README.md`。 |
| `subscription/` | 订阅额度链路：CLI 定位与登录、Gemini ACP 授权、ChatGPT Codex OAuth、账号池与用量。 |
| `vpn/` | 代理/订阅导入的解析与存储（契约 + parser + store）。 |

主进程根目录的几个大文件：`main.cjs`（装配）、`model-ipc.cjs`（模型 IPC 与会话）、`chat-agent.mjs`（agent 循环）、
`agent-tools.cjs`（文件/命令类工具与审计）、`permissions.cjs`（权限位）、`approvals.cjs`（人工确认）、
`edge-bridge.cjs`（Edge 扩展桥）、`memory-*.cjs`（记忆持久化）、`files-view.cjs`（右侧查看器的只读文件视图 +
`locate()` 归属判定 + `openFile()` 外部打开）、`viewer-ipc.cjs`（查看器 IPC 注册）。

渲染层里与「点路径」有关的三个文件：`src/features/chat/open-target.mjs`（修饰键判定 + 两条外部打开封装，纯函数可单测）、
`src/features/chat/file-reference.js`（`[[file:…]]` 与「像路径的行内代码」的解析）、
`src/features/chat/thinking-block.jsx`（工具行里的 `FilePathChip`：左键进面板、Ctrl/⌘ 走系统默认程序）。
会话标题：`src/features/chat/chat-title-text.mjs`（新对话的**即时**标题，纯函数）、
`src/features/chat/chat-rename.js`（改名即 key 迁移）、`electron/services/chat-title.cjs`（模型取名）。
主进程侧「这次动的是哪个文件」只有一处判定：`electron/skills/tool-path.mjs`（闸门与 tool 事件共用）。

## 4. 两条聊天链路

两条链路都从渲染层 `window.movaDesktop.model.complete(...)` 发起，主进程同一个 handler 分流：
`electron/model-ipc.cjs` 的 `installModelIpc()` → `model:complete` → 两种情况都调用
`electron/chat-agent.mjs` 的 `runChatAgent()`。

**A. API Key 链路（pi-ai）**

- 凭据：`providers.loadProviderKey(provider.id)`（`electron/providers.cjs`），本机加密存储。
- 执行：`runChatAgent()` 用 `@earendil-works/pi-ai` 的 `streamSimple`（`api/openai-completions`）
  直连 provider，agent 循环由 `@earendil-works/pi-agent-core` 的 `Agent` 在主进程内跑。
- 工具：`electron/agent-tools.cjs` 的 `createProjectTools()` 等，全部过权限与审批。

**B. 订阅链路（不读 API Key，凭据在本机 CLI / 令牌服务里）**

- **Gemini（ACP）**：`isSubscriptionGeminiProvider()` 为真 → `buildAcpRequest()` 装配 CLI 路径、
  子命令、工作目录 → `runChatAgent()` 内 `runAcpSubscriptionTurn()` → `createAcpEngine()`
  （`electron/acp/engine.mjs`）+ `createGate()`（`electron/acp/gate.mjs`）。
  **agent 循环在 CLI 里**，Mova 只是 ACP 客户端；`session/set_model` 才是选模型的唯一正确入口。
  登录/授权入口：`electron/subscription/acp-auth.mjs` 的 `acpDescribe()` / `acpAuthenticate()` / `acpForceRelogin()`。
- **ChatGPT（Codex）**：`isSubscriptionChatgptProvider()` 为真 →
  `subscriptionService.acquireChatgptTurn()`（`electron/services/subscription-service.mjs`）按账号取令牌 →
  仍走 `runChatAgent()`，但协议换成 `openai-codex-responses`
  （`@earendil-works/pi-ai/api/openai-codex-responses`，POST `https://chatgpt.com/backend-api/codex/responses`）。
  登录入口：`electron/subscription/codex-oauth.mjs` 的 `createCodexLogin()`（本机 1455 回调），
  读取既有登录态用 `codex-auth.mjs` 的 `readCodexAuth()`。

**两条链路「发消息前注入了什么」**是两套完全不同的机制，逐字原文与体积见
[`docs/prompt-injection.md`](prompt-injection.md)：Codex 是 `chat-agent.mjs` 里 17 个槽位
`.join(' ')` 出来的 system prompt（pi-ai 抬成请求体 `instructions`）；Gemini 是
`chat-agent-prompt.mjs` 的 `composeAcpPrompt()` 拼出的一条 `session/prompt` 文本
（本地能力说明 + 最近对话 + 相关记忆 + 用户原话 + 附件正文）。改一边不会影响另一边。

## 5. 已知坑（踩过的，别重犯）

- `agy` **不带 `acp` 子命令会永久挂死**：必须以 `agy acp` 方式启动，超时与看门狗不能省。
- **pi-ai 的 codex 适配器只从 `messages` 里找 system 消息**（`resolveTranscript` → `collapseSystemMessages`），
  **`context.systemPrompt` 会被忽略**，然后静默退回 `"You are a helpful assistant."`：拿 systemPrompt 直接调
  `streamSimple` 的探针/工具会得到一个「提示词没生效」的假象，必须先把 systemPrompt 折成 `messages[0]`。
  正常路径不用担心——`Agent` 已经替你折好了。
- **两条链路的提示词互不引用**：`electron/chat-agent.mjs` 的 `systemPrompt` 数组（pi-ai）与
  `electron/chat-agent-prompt.mjs` 的 `ACP_LOCAL_CAPABILITY_NOTE`（ACP）串味会互相污染，
  改一边前先确认改的是哪条链路（对照 [`prompt-injection.md`](prompt-injection.md)）。
- **图片在 ACP 支路是「路径」不是 image block**：`agy acp` 只收一段文本，所以图片先 `saveImage` 落盘、
  再用 `imageFilePath(id)` 取**与实际写入目录同源**的绝对路径写进 prompt（`imageLocationBlocks`）。
  路径在 `userData/chat-images/` 下，**不在项目根内**，Mova 的项目工具会拒绝它——所以提示词必须点明
  「用你自己的文件读取工具」。临时会话的图片只在内存里，额外复制一份到系统临时目录
  （`services/attachment-temp.mjs` 的 `openImageStaging()`），**必须在 `finally` 里 `dispose()`**，
  成功/失败/取消都要删；暂存失败就如实写「读不到」，绝不能编一个不存在的路径（模型会去读、然后答非所问）。
- **残留 `agy` 进程会让 `session/new` 返回空模型列表且不报错**：遇到空模型列表先杀掉残留 CLI 再试，不要以为「模型确实不支持」。
- **选模型必须走 `session/set_model`**：靠启动参数或改配置指定模型不会生效。
- `antigravity.exe` 桌面程序的 `--version` **不可信**：不能用它判断 CLI 能力，要用 ACP 探测（`acpDescribe()`）。
- **编辑源码禁止用 PowerShell 文本 cmdlet**（`Get-Content -Raw | Set-Content`、`-replace` 写回等）：本项目出现过整文件被
  GBK 双重编码毁掉的事故。改文件只用编辑器的写入/替换或 Node `fs`。
- **桌面操控的真实工具名不是方案里写的 `desktop_click` / `desktop_type` / `desktop_key` / `desktop_scroll`**：
  只有一个入口 `desktop_act`，动作走它的 `action` 枚举（`invoke` / `click` / `type` / `key` / `scroll` / `drag` /
  `focus` / `toggle` / `select` / `setValue`）。真实导出的 10 个工具是
  `desktop_windows` / `desktop_snapshot` / `desktop_act` / `desktop_wait` / `desktop_screenshot` /
  `desktop_read` / `desktop_batch` / `desktop_app` / `desktop_skill` / `desktop_handoff`
  （`electron/desktop/tools.cjs` 的 `DESKTOP_TOOL_NAMES`）；照方案里的旧名字写 prompt 或测试，模型会拿到 unknown_tool。
- **浏览器层对 `navigate` / `tabs` / 技能库写入自身不弹审批**：`electron/browser/policy.cjs` 把
  `snapshot` / `read` / `wait` / `tabs` / `screenshot` 归为 level 0（`READ_ACTIONS`）、`navigate` 归为 level 1，
  而 `electron/browser/tools.cjs` 的 `authorize()` 对 `level <= 1` 直接放行（`browser_skill` 的 save/remove 更是
  根本不调 `authorize`）。也就是说**技能 manifest 的 `risk` / `approval` 声明就是最后一道门**：
  声明写低（`risk: 'read'` + `approval.mode: 'none'`）等于把这几个动作直接放开，没有任何下游兜底。
- **技能 manifest 的 `permissions.fs` 与七个能力位是安全判据，不是描述文案**：`fs: 'none'`，或「`fs: 'read'` +
  声明了 desktop / browser / canvas / memory + 参数里没有路径」都会让 `approval-bridge` 跳过项目根检查
  （`needsProjectRoot()`）。写错一个字段就是放宽门禁——改 manifest 的 `fs` 或能力位必须按安全变更评审，
  不要当成文案微调。
- **点击路径/链接的两种目标只有一个判定点**：`src/features/chat/open-target.mjs` 的 `decideTarget(event)`
  （左键 → 右侧面板；Ctrl/⌘ → 系统外部）。四类调用点（回答里的行内代码、`[[file:…]]`、工具行路径、网页链接）
  都必须走它，别在 DOM 事件里各写一份 `ctrlKey || metaKey`。
  - 外部打开文件 = `shell.openPath`（等同在文件管理器里双击），入口 `files:view:open-external`；
    「在资源管理器里定位」是另一件事（`changes:reveal` → `showItemInFolder`），别混用。
  - 模型给的路径常常是**绝对**的（Gemini 的 CLI 工具尤其如此），而渲染层的 `normalizePath()` 明确拒绝盘符，
    所以归属判定放在主进程：`files-view.cjs` 的 `locate()`（逐个已登记根做 `relativeTo` + `resolveInside` +
    `stat`）。**绝不允许**渲染层凭绝对路径直接读磁盘。
  - 工具行里的路径用 `<span role="link">` 而不是 `<button>`：它有时嵌在 `.trace-head`（本身是 button）里，
    嵌套 button 是非法 HTML，浏览器会重排节点，点击行为随之不可预测。
- **「这次动的是哪个文件」也只有一处判定**：`electron/skills/tool-path.mjs` 的 `firstPathOf()`
  （`path`/`file`/`filePath`/`cwd`/`dir`）。闸门（`approval-bridge.mjs`）与 tool 事件
  （`skills/index.mjs` → `events.mjs`）共用它；ACP 侧另有 `acp/translate.mjs` 的 `pathOfInput()`
  认 CLI 的 snake_case 名字（`file_path` / `target_file` / `absolute_path`）。抄第二份就会出现
  「有的工具行能点、有的不能」。
- **内置浏览器只导航 http(s)，唯一例外是「已登记项目根内的可展示类型文件」（`file:`）**：判定只有一处，
  在 `electron/browser/target.cjs` 的 `resolveLocalFileTarget()`（`fileURLToPath` → `realpath` → 根归属 →
  扩展名 → 存在性），`browser_navigate` / `browser_batch` 的 navigate 步骤 / `browser_tabs new` 都经过它；
  根外一律拒绝并给 `file_outside_roots`（文案里**不带**目标路径），没注入 `localFiles` 时仍是 `blocked-url`。
  技能层（`skills/packs/browser-automation/handlers.mjs` 的 `guardLocalFile()`）只做早失败 + 好文案，不是强制点。

- **内置浏览器现在允许「已登记项目根内」的 `file://` 导航（用户明确批准的风险）**：判定点在
  `electron/browser/target.cjs` 的 `resolveLocalFileTarget()`（realpath + 根前缀 + 类型白名单），
  根外一律 `file_outside_roots` 且错误信息不带路径；未注入 `localFiles` 时仍是 `blocked-url`。
  ⚠️ **已知且已实测的风险**：`file:` 页面在 Electron 45 里能 `fetch()` 任意本地可读文件并用
  `no-cors` POST 外发（本机探针实测读到 `C:\Windows\win.ini` 并成功外发），所以「项目目录里的任意
  HTML/SVG」等于「能读全盘」。要彻底消除必须改成自定义 scheme（如 `mova-local://` + CSP）让页面 origin
  不再是 `file:`；在那之前，不要把来路不明的 HTML 放进项目目录。

- **「同一行」的判等必须稳定序列化，删除必须按意图判定**：磁盘那侧是 Postgres `jsonb`（键序被重排）+ ISO
  时间戳 + 补出的字段，渲染层这侧是 JS 键序 + 数字毫秒。任何 `JSON.stringify(a) === JSON.stringify(b)`
  的整行全等都会**永远为假**，于是「删除」被静默丢弃、重启后内容复活。判定入口只有一处：
  `electron/session-sync.cjs` 的 `mergeRows()`（`canonical()` 折时间字段 + 递归排键，删除分支看
  `before 有 / after 没有`，只在「磁盘行更晚**且内容真的变了**」时才算并发编辑并保留）。改这里等于改
  删除语义，必须跑 `tests/chat-delete-archive-flow.test.mjs`。
- **订阅账号的会话标题：`loadProviderKey()` 对内置订阅 provider 恒返回空串**（凭据是本机 OAuth / CLI 登录态），
  所以「按 API key 打一次 HTTP 取名」那条路对订阅用户**永远**返回空——现象就是「新对话的标题一直不更新」。
  现在分两层：① 创建对话时先用 `instantChatTitle()` 起一个干净短标题（去客套/去语气词/去链接与路径，
  纯函数，左侧列表立刻有名字）；② 第一条回复结束后再请模型改名，走的是**这条对话真正在跑的模型**
  （`providerId`/`modelId` 由渲染层带上，不要用持久化的 `resolveActive()`）：
  ChatGPT 订阅走 `chat-title.cjs` 的 `chatgptTitle()`（`acquireChatgptTurn()` 取号 + pi-ai 的
  `openai-codex-responses`，有 VPN 线路时用代理 fetch 并钉死 SSE），Gemini 订阅**不**取名
  （循环在 `agy` 里，没有便宜的一次性文本接口，绝不为取名 spawn 一个 CLI）。
- **「本轮工具输出过多」这条预算按 token 算，而且随模型窗口缩放**：以前是写死的 200,000 **字符**
  （`TOOL_RUN_LIMIT`），两个后果都很难查——272k/500k 窗口的模型只用到 5–10% 的窗口，长任务（`design_read`
  一次就能到 6 万字符、`browser_snapshot` 2.4 万）动不动撞线，用户只看到「模型运行中断（tool_limit）」；
  而且字符口径对中文严重低估（20 万汉字 ≈ 30 万 token，能顶爆 128k 窗口）。
  现在判定只有一处：`electron/context/budget.mjs` 的 `toolRunBudget(contextWindow)`
  = 窗口的 1/4 **token**，夹在 [55k, 150k]（下限就是旧实现的实际容量，小窗口模型不许更紧）；
  累加用 `estimateTokens()`（与上下文台账同一个估算器）。撞线会记一条
  `tool-budget-exhausted`（verdict / budget / 实际 token / 字符 / 调用次数 / top3 工具）——没有这条日志时，
  这个错误事后完全无法复盘。单条结果仍按 40,000 **字符**截断（`TOOL_RESULT_LIMIT`），两件事别混。
  **超预算分两级**（`toolBudgetVerdict()`）：第一次只返回「预算已用尽，别再调工具，说说现在到哪了」这条指令
  （`wrap-up`，**不** terminate），模型因此还能写出有头有尾的结论并附上可点击路径；只有它收了指令**还继续调工具**
  才 `stop`（`terminate: true` + `ModelError('tool_limit')`）。硬停必须只剩这一处——多一处就退回「没有结论的中断」。
- **`@chatArchived` 里的键可能没有会话行**（临时聊天、首次发送中断、会话行被残缺快照删过）。所以
  `buildProjects()` 必须能从 `[mode, project, title]` 反解出 chat 行，时间戳来自 `@chatActivity`；
  同时 `saveSessions()` 不能按「有没有会话行」过滤归档键，而要区分「库里从来没有这行」（保留）和
  「刚被删掉」（连键一起清）。这一条修错的表现就是「归档页永远空」或「删了又回来」。
- **主进程写 stdout/stderr 的 `EPIPE` 挡不住，`try/catch` 也不行**：`Writable.write()` 只排队，真正的
  `Socket._write` 失败后由流抛异步 `'error'`，没人监听就升级成 `uncaughtException` → Electron 弹出
  「A JavaScript error occurred in the main process」，用户点掉之前界面全呆住（关终端、从任务栏启动、
  父进程退出都会触发）。唯一可靠的挡法是给流挂 `'error'` 监听器，见 `electron/stdio-guard.cjs`
  （`main.cjs` 第一条语句装上）。
- **`subscription:list` 必须自带 CLI 状态，账号视图必须带 `lastUsedAt` 与 `cli`**：渲染层首屏**不再**单独发
  `cliStatus`（`use-subscription.js` 靠 `list()` 里的 `cli` 决定「正在检测 CLI…」是否结束），
  Gemini 卡片的副标题读 `account.cli.ready`，ChatGPT 卡片读 `account.lastUsedAt`。少了任何一个，界面就会
  说「正在检测 CLI…」「CLI 未就绪」「还没有调用」，而 CLI 明明装着、额度也刚读到——自相矛盾但没人报错。
  另：CLI 版本对象是 `{major, minor, patch}`（`cli.mjs`），渲染层老代码读的是 `step`，两处都要认。
- **聊天行尾那个按钮的语义只有一处判断**：`src/features/sidebar/chat-row-action.mjs` 的
  `chatRowAction()`。临时聊天（`temporaryConversations` 里有的键）在这个位置是**删除**而不是归档——
  临时聊天在 `workspaceSnapshot()` 里整条被过滤，归档标记根本存不下来，给归档按钮只会得到一句
  「无法归档」。删除走 `app.js` 的 `deleteTemporaryChat()`（直接删、不弹确认，因为它本来就没落盘副本），
  普通聊天仍必须走带确认的「永久删除」。清理会话状态只允许用 `dropConversationKey()`——
  `chatKeysFor()` 会跨 mode 拼键，少一个 mode 就会「删了又回来」。
- **缺核心工具只写日志、不上屏**：`turn-runtime.mjs` 的 `reportMissingCore()` 现在只 `logger.warn`，
  不再往时间线发「本轮缺少 N 个核心工具」的旁白——那条旁白列出来的绝大多数是**正常状态**
  （没有项目文件夹、临时会话不加载记忆、没配提问通道、Edge 会话不开文件工具），读起来像软件坏了。
  排查看 `skills-runtime built` 的 `skipped`（每个包带 reason）就够。
  另：**临时会话只少了记忆工具**（主进程对 `temporary` 请求不注入 `memorySearch`），
  `project-fs` 的 `sessionPolicy.allowTemporary` 是 `true`——临时聊天照样能读写文件，别把它也一起关掉。
- **启动动画必须拆成外部 JS，且单独放宽 `frame-ancestors`**：`mova://` 的每个响应都带
  `script-src 'self'`，**内联 `<script>` 一律被静默拦掉**（页面只剩一张静止画面，不报错、很难发现），
  所以要 `scripts/split-splash.mjs` 拆成 `mova-startup.js`；同时默认 CSP 的 `frame-ancestors 'none'`
  会把 iframe 直接废掉，启动动画文档走 `SPLASH_CSP`（只放宽到 `'self'`）。改动画或改 CSP 都要跑一次看画面。
- **`window-all-closed` 会打断脚本**：只要注册了默认行为，关掉最后一个窗口（哪怕是离屏渲染用的临时窗口）
  进程就干净退出，后面 `await` 的写文件全部不执行——现象是「退出码 0 但只生成了一半」。
  `scripts/make-icon.cjs` 踩过一次，一次性脚本里也要显式接管这个事件。
- **附件有三类，别再当成「只有图片」**：`kind` 是 `image` / `text` / `file`（分类在 vendor composer 的
  `addFiles()` 里，按 MIME 或扩展名，`.md` 属于 `text`）。渲染层规则在
  `src/features/chat/attachment-rules.mjs`（上限 5 个附件、其中最多 4 张图、单个 4 MB），
  主进程把这些变成模型输入的是 `electron/services/attachment-text.mjs`（文本带头尾拼进用户消息，
  二进制只给「读不到正文」的说明）。两个坑：文本正文在 composer 那侧字段叫 **`extractedText`**
  （不是 `text`），只认一个就会「明明上传了却说没有内容」；`image` 判定要容忍老形状
  `{ name, dataUrl }`（没有 `kind`），否则老请求里的图片会被当成二进制文件。
：`vpn-settings.css` 里一条全局的 `.settings-section-head`
  （本意是「标题 + 右侧动作同排」）曾把「CLI 模型」页的段标题改成 `align-items: center` +
  `space-between`，于是那一页的「ChatGPT 订阅 / Gemini 订阅」全部居中——样式泄漏，改一个页面坏另一个。
  新增/修改 feature CSS 时，选择器要么带 `.vpn-page` / `.cm-page` 这类页根，要么用自己的前缀类。
- **凡是要访问 Google 的子进程都必须走「按模型线路」**：`agy` 的 `/usage` 探针（`electron/subscription/ipc.mjs`
  的 `geminiProbeEnv()`）和 ACP 对话（`model-ipc.cjs` 的 `acpEnv`）都用 `envForModel('subscription:gemini', …)`。
  漏掉任何一个，国内直连就会超时；表现不是「没网」，而是「额度未知」「没能切到模型」。
  另：**探针里别调 `runtime.refresh()`**——它会探测整段端口占用，实测能把一次探针拖到 12s 超时；
  线路缓存由开机自启（`maybeAutoStart()` → `startCore()` → `ensureCache()`）预热即可。
- **`core.autoStart` 现在真的有消费者**（`vpn/runtime.mjs` 的 `maybeAutoStart()`，main.cjs 启动 1.5s 后调用，
  判定在 `contract.mjs` 的 `shouldAutoStartCore()`）。以前它只是配置里的一个字段，于是内核往往
  十分钟都不会起来，`ports` 为空 → 全部子进程直连。判断「要不要自启」改 `shouldAutoStartCore()`，
  不要另写一份。
- **启动后第一次 `memory:read` 会慢 8–9 秒，而且不是数据库慢**：`memory-runtime.start()` 在连库前
  `await ensureServices()`，它 spawn `node scripts/services.mjs ensure` 去跑 docker compose——Windows 上
  `docker` CLI 本身就要 1s 左右一次，`status` 3.9s / `ensure` 8.7s（本机实测）。而真正的 SQL 只有
  `loadSessions()` 4.5ms、`read()` 33ms（`scripts/probes/probe-memory-read-timing.mjs` 可复现）。
  所以侧栏看起来「空的」不代表数据丢了，是还在等 docker。想彻底解决要让 `start()` 先建池再后台补
  队列/备份，但那会把 `createPostgresRepository` 构造期捕获的 `queue` 变成 null（会话同步任务再也不入队），
  属于要一起改的活，别只改一行 `await`。

> 技能化的现状（哪条链路已全量走技能包、哪几类仍是手写、继续推进要先补什么）见
> [`plans/技能化收口-剩余债务.md`](plans/技能化收口-剩余债务.md)，不要在本文件重复维护那份清单。

## 6. 扩展点

「新东西往哪放」的权威表在 [`conventions.md` §1](conventions.md#1-目录布局与预留空间)，这里只给一句话摘要与去处：

| 要新增的东西 | 放哪里 | 细则 |
| --- | --- | --- |
| 新的本地能力（工具） | `electron/skills/packs/<kebab-id>/`（`manifest.mjs` + `handlers.mjs`） | [`conventions.md` §1](conventions.md#1-目录布局与预留空间)、[`plans/Mova本地能力技能化与MCP暴露方案.md`](plans/Mova本地能力技能化与MCP暴露方案.md) |
| 新的 UI 功能块 | `src/features/<kebab-id>/`（带自己的 `*.css`，不往根 `styles.css` 加块） | [`conventions.md` §1、§2.3](conventions.md#1-目录布局与预留空间) |
| 新的 Bot 能力 / 视图 | 主进程 `electron/bots/`，渲染层 `src/features/bot/` | [`electron/bots/README.md`](../electron/bots/README.md)、[`src/features/bot/README.md`](../src/features/bot/README.md) |
| 新的方案 / 设计文档 | `docs/plans/<主题>.md`（不放根目录），并在 [`plans/README.md`](plans/README.md) 加一行 | [`conventions.md` §6](conventions.md#6-文档规范) |
| 一次性探针脚本 | `scripts/probes/`（不进 `scripts/` 根、不被 `tests/` 依赖） | [`scripts/probes/README.md`](../scripts/probes/README.md) |

## 7. 记忆写入路径（哪些会「不经确认」落盘）

产品口径：**记忆的增删改与整理由 AI 自己判断，不需要逐次向用户确认**。下面这张表是「谁在什么时候写记忆」的权威清单，
改记忆相关代码前先对照它，避免以为「只有工具才会写」。

| # | 位置 | 触发 | 经过审批 |
| --- | --- | --- | --- |
| a | `db/postgres-repository.cjs` 的 `ingest()`（默认 `MOVA_MODE=postgres`） | 每轮用户消息：渲染层 `memoryBridge.ingest()` → `memory-ipc.cjs`；条件 `shouldAutoExtract`（`memoryEnabled && autoExtract && extractorMode!=='off'`） | 否 |
| b | `memory-store.cjs` 的 `ingest()`（本地 JSON 模式） | 同上 | 否 |
| c | 两处 `ingest` 的「用户口述命令」分支（记住 / 忘掉 / 改成…） | 原话命中 `parseMemoryCommand` | 否（多候选时返回 `action:'confirm'`，但还没有 UI 消费） |
| d | `db/postgres-repository.cjs` 的 `maintenance()` | `memory-runtime.cjs` 每 24h `{apply:true}`，或设置页手动触发 | 否（定时那条完全无人参与） |
| e | `memory-runtime.cjs` 的后台 worker（启动 2s 后 + 每 60s） | `processPendingJobs` → `ingest` → `addMemory` | 否 |
| f | `browser/memory-mirror.cjs`、`desktop/memory-mirror.cjs` | 站点技能 / 桌面流程索引卡 | 否 |
| g | `services/memory-extractor.cjs` | `extract` / `rerank` | 不落盘（只产候选），真正落盘在 a/b/f |

技能侧的 `memory_write` / `memory_update` / `memory_supersede` / `memory_archive` 是**另一条路**：
它们走 `ctx.authorize()`，在 `approvalPreset` 为 `default` 时会弹审批卡，`full` 时免问（`allowSession` 让同一会话内只问一次）。
