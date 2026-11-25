# Mova 桌面操作 · 实施拆分与接口契约

> 这是 `Mova桌面操作开发方案.md` 的施工版：只写“谁做什么、接口长什么样、怎么算通过”。
> 所有子任务以本文件为准；与本文件冲突时先改本文件，再改代码。

## 0. 环境事实（2026-11-12 实测）

| 项 | 结果 | 影响 |
| --- | --- | --- |
| .NET SDK | **没有**（`dotnet` 不可用） | 原方案里的 C# sidecar **不做**，改用「常驻 PowerShell UIA worker」 |
| `System.Windows.Automation` | 可用（`powershell.exe` 加载 `UIAutomationClient`） | 树读取、Pattern 调用都走它 |
| UIA 速度 | 从 RootElement 走 3 层 36 节点 ≈ 330ms（含托盘等噪声）；枚举顶层窗口 9 个 | 常驻进程 + 缓存后可接受 |
| `koffi` | 已安装且 `require('koffi')` 可用（3.3.7） | 输入注入/热键/屏幕边缘 API 在主进程内做，无子进程 |
| Electron | `node_modules/electron/dist/electron.exe` 存在 | `npm run desktop` 可跑 |
| 微信 | `C:\Program Files\Tencent\Weixin\Weixin.exe`，进程已在跑，窗口类 `Qt51514QWindowIcon`，标题「微信」 | 最终验收目标 |
| 设置界面 | `index.html` 的 `.settings-view` + `[data-settings-item]` + `#settings-page-<id>`；浏览器页是空容器、由 JS 渲染 | 「电脑操作」照这个模式加 |

## 1. 架构（施工版）

```text
Electron Main
 electron/desktop/index.cjs        createDesktopEngine()  ← 唯一出口
   ├─ host.cjs                     PowerShell worker 客户端：start/call/on/dispose
   ├─ host/uia-worker.ps1          stdin/stdout JSON-lines：UIA + 少量 user32
   ├─ windows.cjs                  顶层窗口枚举/前台/矩形/进程（可走 worker 或 koffi）
   ├─ tree.cjs + compact.cjs       tree → 紧凑文本（纯函数，可单测）
   ├─ diff.cjs                     ΔTree（纯函数）
   ├─ actions.cjs                  ref → Pattern → 坐标回退（调用 worker）
   ├─ input.cjs                    koffi: SendInput/键序/滚轮/拖拽/光标
   ├─ capture.cjs                  desktopCapturer → 裁剪/缩放/DPR
   ├─ geometry.cjs                 坐标换算（纯函数）
   ├─ vision/{som,ocr,grounder}.cjs
   ├─ verify.cjs                   后置条件
   ├─ policy.cjs                   R0–R4 + 应用规则 + 预算
   ├─ session.cjs                  状态机/锁/预算/终止
   ├─ trace.cjs / elements.cjs / procedures.cjs / compiler.cjs / memory-mirror.cjs
   ├─ audit.cjs                    desktop-audit.jsonl
   ├─ overlay/{overlay.cjs,overlay.html,overlay.css}
   ├─ guard.cjs                    长按 Ctrl+Shift / 真人输入抢占 / 释放按键
   ├─ tools.cjs                    10 个 desktop_* 工具
   └─ ipc.cjs                      renderer 桥（status/stop/resume/settings）
 Renderer
   src/features/desktop/desktop-settings.js + .css   设置 → 集成 → 电脑操作
```

## 2. 接口契约（写死，改动需同步本文件）

### 2.1 `host.cjs`（Agent A）

```js
const host = createHost({ scriptPath, cwd, timeoutMs = 15000, logger });
await host.start();                       // 拉起 powershell，握手 {"ok":true,"pid":...}
const res = await host.call('tree', { hwnd, maxDepth: 6, maxNodes: 2000 });
host.on('event', (evt) => {});            // {type:'hotkey', ...} 之类
await host.dispose();
```

- 传输：一行一个 JSON（`\n` 分隔），请求 `{id, cmd, args}`，响应 `{id, ok:true, result}` 或 `{id, ok:false, code, message}`。
- 超时：默认 15s；超时后 `kill` 并自动重启一次（进程内记 `restartCount`）。
- 编码：**worker 必须 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`**，Node 侧用 `utf8` 解码；禁止依赖系统代码页。
- 退出：`dispose()` 先发 `{cmd:'quit'}`，200ms 后 `kill`。

### 2.2 worker 命令（Agent A 实现，Agent C/E 消费）

| cmd | args | result |
| --- | --- | --- |
| `ping` | — | `{pid, uia:true, version}` |
| `windows` | `{includeMinimized?}` | `{windows:[{hwnd,pid,exe,title,class,rect:[x,y,w,h],foreground,minimized}]}` |
| `foreground` | — | 同上单条 |
| `tree` | `{hwnd, maxDepth=6, maxNodes=2000, deadlineMs=1500, includeOffscreen=false}` | `{truncated, timedOut, nodes:[{ref, role, name, automationId, className, rect, states:{enabled,focusable,offscreen,password,selected,expanded,toggled}, value?, patterns:[...]}]}` |
| `find` | `{hwnd, by:{automationId?|name?|role?|path?[]}}` | `{node}` 或 `{code:'not-found'}` |
| `invoke` | `{ref}` | `{ok:true}` / `{code:'pattern-unsupported'|'stale-ref'|'disabled'}` |
| `setValue` | `{ref, text}` | 同上 |
| `pattern` | `{ref, name, args?}` | `{ok, value?}`（Toggle/SelectionItem/ExpandCollapse/Scroll/RangeValue） |
| `rect` | `{ref}` | `{rect, clickable:[x,y]}` |
| `focus` | `{ref}` | `{ok}` |
| `readText` | `{ref, maxChars}` | `{text, truncated}` |
| `activate` | `{hwnd}` | `{ok}`（SetForegroundWindow 尽力） |
| `screenInfo` | — | `{displays:[{id,x,y,w,h,scaleFactor,primary}]}` |
| `quit` | — | `{ok}` |

- `ref` 形如 `w1.b7`（会话内显示用）；worker 内部维护 `ref → AutomationElement` 映射，`tree` 重建时整体失效（返回 `stale-ref`）。
- 所有坐标是**物理像素**（worker 手动声明 PerMonitorV2：启动时调用 `SetProcessDpiAwarenessContext`，失败则用 `SetProcessDPIAware`）。

### 2.3 `index.cjs`（Agent A 骨架 / Agent C 补全）

```js
const desktop = createDesktopEngine({ app, screen, approvals, audit, getWin });
desktop.tools({ emit, approve, signal });      // [{name,label,description,parameters,execute}]
desktop.status();                              // {available, reason, worker, session}
desktop.stop('user'); desktop.dispose();
desktop.overlay.show({ displayId, emotion });  // 由 session 调用（Agent B 实现）
desktop.settings.get() / .set(patch);          // 由 settings 页调用
```

### 2.4 工具（Agent C）

`desktop_windows` / `desktop_snapshot` / `desktop_act` / `desktop_wait` / `desktop_screenshot` /
`desktop_read` / `desktop_batch` / `desktop_app` / `desktop_skill` / `desktop_handoff`，
参数与语义见 `Mova桌面操作开发方案.md` §13。所有工具返回 JSON 文本 + 可选 `{type:'image'}`。

### 2.5 overlay（Agent B）

```js
createOverlay({ app, screen });      // → { show(opts), hide(), update(text), setEmotion(id), exists(), dispose() }
```
- 位置：目标显示器左下角；内容：小球（vendor/emotion-ball）+ 气泡列（`.bot-bubble-content` 原样）。
- 必须：`setIgnoreMouseEvents(true,{forward:true})`、`setContentProtection(true)`、`showInactive()`、`focusable:false`。
- 呼吸光：四条线性渐变，`opacity .34↔1`，5.4s。
- 气泡：新气泡贴底冒出，旧的上移，2s 后淡出；最多 3 条；`?freeze=` 不需要，真实组件用真实计时。

### 2.6 guard（Agent B）

```js
createGuard({ onAbort, pollMs = 50 });   // start()/stop()；koffi 轮询 GetAsyncKeyState
```
- 长按 `Ctrl+Shift` ≥ 600ms → `onAbort('hotkey')`；只在该会话活跃时轮询。
- `isUserActive()`：`GetLastInputInfo` 变化且不在注入窗口 ±80ms 内 → 供 session 判定接管。

## 3. 文件归属（谁都不许改别人的文件）

| Agent | 独占文件 |
| --- | --- |
| A 核心通道 | `electron/desktop/host.cjs`、`electron/desktop/host/uia-worker.ps1`、`windows.cjs`、`tree.cjs`、`compact.cjs`、`diff.cjs`、`actions.cjs`、`session.cjs`、`index.cjs`、`tests/desktop/*` |
| B 浮层守护 | `electron/desktop/overlay/*`、`electron/desktop/guard.cjs`、`electron/desktop/input.cjs` |
| C 工具与接线 | `electron/desktop/tools.cjs`、`policy.cjs`、`audit.cjs`、`ipc.cjs`、`memory/*`、`electron/main.cjs`、`electron/preload.cjs`、`electron/chat-agent.mjs`、`package.json` |
| D 设置界面 | `index.html`、`app.js`、`styles.css`、`src/features/desktop/*` |
| E 视觉 | `electron/desktop/capture.cjs`、`geometry.cjs`、`verify.cjs`、`vision/*` |
| F 文档测试 | `Mova*.md`、`tests/desktop/*.test.cjs`（与 A 冲突时改 `tests/desktop/` 子目录） |

## 4. 验收标准（我负责）

1. `npm run lint`、`npm run typecheck`、`node --test` 全绿。
2. `node scripts/desktop-smoke.cjs` 能枚举窗口、读微信窗口树、用 Pattern 或坐标点击、ΔTree 有变化。
3. 设置 → 集成 → 电脑操作 可打开、可保存、高级项默认折叠、刷新后保留。
4. 真机：打开微信 → 找到「文件传输助手」→ 发送「你已经完成了」+ 完成清单 + 一个表情包。
5. 文档：`Mova桌面操作开发方案.md` 的实施状态、`Mova设计规范.md`（如新增组件）同步更新。

## 5. 风险与取舍

- **PowerShell worker 慢**：单条命令 10–40ms 可接受；`tree` 用 depth/节点上限 + deadline 控制；病态应用进排除名单。
- **UIA2（托管）能力弱于 UIA3**：拿不到部分 `IsOffscreen`/`ToggleState` 时降级为“按 name+role 定位 + 坐标点击”。
- **微信 4.x 是 Qt 自绘**：`Qt51514QWindowIcon` 的控件树可能很浅 → 最终验收预计要走「树定位窗口 + 坐标点击输入框 + 剪贴板粘贴 + Enter」的混合路径，这正是方案里 T1→T2 的降级策略，不算作弊。
- **不可用环境**（锁屏/无桌面）：引擎返回 `unavailable`，设置页显示原因，不崩。

## 6. 施工进度（2026-11-12）

按 §3 的文件归属逐项标状态：✅ 已实现（文件在、且被生产代码引用）/ 🚧 部分实现（在但没接线、或只覆盖一部分）/ ⛔ 未实现（文件不存在或是桩）。能力级说明与「待验证」项见 `Mova桌面操作开发方案.md` §23。

| Agent | 文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| A 核心通道 | `host.cjs` | ✅ | 一行一个 JSON、15s 超时、超时/退出后重启一次、`dispose()` 先 `quit` 再 `kill` |
| A | `host/uia-worker.ps1` | ✅ | 替代原 C# sidecar：UIA2 + 少量 user32，14 个命令（`ping` / `windows` / `foreground` / `tree` / `find` / `invoke` / `setValue` / `pattern` / `rect` / `focus` / `readText` / `activate` / `screenInfo` / `quit`）；源文件纯 ASCII（PS 5.1 按系统代码页解析）、stdin/stdout 强制 UTF-8 |
| A | `windows.cjs` | ✅ | 顶层窗口 / 前台 / 矩形 / 进程 / `screenInfo` / `displayForRect` |
| A | `tree.cjs` | ✅ | `normalizeNodes` / `buildTree` / `fingerprintOf` |
| A | `compact.cjs` | ✅ | 有单测（`tests/desktop/compact.test.cjs`） |
| A | `diff.cjs` | ✅ | ΔTree，有单测；`session.verify()` 用它判 `changed` |
| A | `actions.cjs` | ✅ | Pattern 优先 → 坐标 / 注入回退，结果带 `via` |
| A | `session.cjs` | ✅ | 状态机 / 预算 / 懒启动 / 终止清理顺序 |
| A | `index.cjs` | ✅ | 唯一出口：懒建 host、`screenshot()`、`handoff()`、`tools()`、`settings` |
| A | `tests/desktop/*` | 🚧 | 8 个测试文件（compact/diff/geometry/input/policy/procedures/som/tools）；`session`/`index`/`host`/`actions`/`tree`/`overlay`/`hook`/`interlock` 无测试；`node --test tests/desktop/`（目录形式）在 Node 24.18.0 报 `MODULE_NOT_FOUND`，要用 glob |
| B 浮层守护 | `overlay/*` | ✅ | 每显示器一窗、点击穿透、`setContentProtection`、`showInactive`、3s watchdog、小球 + 气泡 + 四边呼吸光 + 光标箭头描边 + 暂停态 |
| B | `guard.cjs` | ✅ | `GetAsyncKeyState` 50ms 轮询、Ctrl+Shift ≥600ms、注入窗口 ±80ms 判定 |
| B | `input.cjs` | ✅ | SendInput / 键序 / 滚轮 / 拖拽 / `typeText`（unicode｜clipboard）/ `releaseAll` |
| B（方案外新增） | `hook.cjs` | ✅ | `WH_MOUSE_LL` 低级鼠标钩子，`koffi.register` 注册回调，`LLMHF_INJECTED` 放行注入事件 |
| B（方案外新增） | `interlock.cjs` | ✅ | 150ms 轮询会话状态装/卸钩子：running 吞真人移动/点击，paused 只处理“点球恢复” |
| C 工具与接线 | `tools.cjs` | ✅ | 10 个 `desktop_*` + `DESKTOP_SYSTEM_PROMPT` + `createEngineOperations` 适配层 |
| C | `policy.cjs` | ✅ | R0–R4、危险键、排除名单、预算；`visionAllowed()` 目前无调用点 |
| C | `audit.cjs` | ✅ | `desktop-audit.jsonl`，5MB 轮转保留 2 份 |
| C | `ipc.cjs` | ✅ | 七个 `desktop:*` 通道 + 设置持久化（`policy.json`） |
| C | `memory/*` | 🚧 | `trace`/`elements`/`procedures`/`compiler`/`memory-mirror` 五件齐；只有 `procedures`（+ `compiler`）接入；端到端未跑通 |
| C | `electron/main.cjs` | ✅ | 引擎 / overlay / guard / audit / procedures 装配，`before-quit` 释放按键、销毁 overlay |
| C | `electron/preload.cjs` | ✅ | `window.movaDesktop.desktop`（status/stop/resume/getSettings/setSettings/skills/removeSkill/onStep/onState/onUnavailable） |
| C | `electron/chat-agent.mjs` | ✅ | 工具注入 + `approveDesktop` 审批 + 系统提示 + 图片块透传 |
| C | `package.json` | ✅ | `koffi ^3.3.7`、`sharp 0.34.5` 已装；`dbus-next` 未装（Linux 没做） |
| D 设置界面 | `index.html` | ✅ | `[data-settings-item="desktop"]` + `#settings-page-desktop`（空容器，由 JS 渲染） |
| D | `app.js` | ✅ | `mountDesktopSettings` 挂载 |
| D | `src/features/desktop/*` | 🚧 | 八段结构（状态/权限/应用规则/会话预算/浮层/记忆/高级/重置）齐；真实 app 内未联调 |
| E 视觉 | `capture.cjs` | ✅ | 已接引擎（`desktopCapturer` + `sharp` 注入，长边 1280、20 帧缓存、黑帧/蓝边检测） |
| E | `geometry.cjs` | ✅ | 有单测 |
| E | `verify.cjs` | 🚧 | 六类后置条件已实现，但未被引擎引用（`session.verify()` 自己用 `diff.cjs`） |
| E | `vision/som.cjs` | 🚧 | 已实现 + 有单测，未接进引擎（`desktop_screenshot` 不画标注） |
| E | `vision/grounder.cjs` | 🚧 | 契约/校验/缓存/预算齐，需注入 `callModel`；未接真实模型 |
| E | `vision/ocr.cjs` | ⛔ | 桩：`probe()` 恒 `available:false`，`recognize()` 抛 `ocr-unavailable` |
| F 文档测试 | `Mova*.md` | 🚧 | 本轮更新：方案 §23 新增、§12.1/§12.2/§12.3、§13.1、§14.1；规范 §8.6 新增、§3.3；本文件 §6 |
| F | `tests/desktop/*.test.cjs` | 🚧 | 覆盖 8 个模块，见 A 的 `tests/desktop/*` 一行 |

三条要点：

- **screenshot / handoff 已接线**：`index.cjs` 的 `screenshot()` 走 `capture.cjs`，`handoff()` 暂停会话并轮询等用户点 Mova 恢复；两者都从 `createEngineOperations` 暴露给 `desktop_screenshot` / `desktop_handoff`。
- **interlock + hook 已实现**（方案里没有这两个文件）：`hook.cjs` 装 `WH_MOUSE_LL`，`interlock.cjs` 按会话状态决定装/卸；running 吞真人移动/点击，paused 只处理“点在球上 → 恢复”。
- **微信输入未打通**：`Qt51514QWindowIcon` 的 UIA 树只有 3 个节点，只能走「坐标点击 + 剪贴板粘贴 + Enter」；`input.typeText` 对微信尚未验证成功。因此 §4 的第 4 条真机验收**还没过**。

缺项（方案里有、代码里没有）：`sidecar/`、Linux（`linux-atspi` / `linux-input`）、目标控件矩形描边、OCR、应用 `launch`/`close`、T0–T4 分层编排与升级触发器。
