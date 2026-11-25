# 桌面操作 · 工具层与接线说明（Agent C）

> 配套 `design/desktop-build-plan.md`。本文件只写「我这半边交出去了什么、`index.cjs` 还要补什么」。
> 文件归属见契约 §3：`electron/desktop/{tools,policy,audit,ipc,trace,elements,procedures,compiler,memory-mirror}.cjs`
> 与 `electron/{main,preload,chat-agent}`、`package.json`、`tests/desktop/*.test.cjs` 由本分支维护。

## 1. 交付清单

| 文件 | 作用 | 依赖 |
| --- | --- | --- |
| `desktop/policy.cjs` | `classifyDesktopAction` / `appRule` / 危险词表 / 危险键 / 预算 / 设置归一化。纯函数、无 electron | 无 |
| `desktop/audit.cjs` | `desktop-audit.jsonl`，5MB 轮转保留 2 份，只写 10 个字段 | 无 |
| `desktop/tools.cjs` | 10 个 `desktop_*` 工具 + `DESKTOP_SYSTEM_PROMPT` + `createEngineOperations`（引擎适配层） | policy、compiler |
| `desktop/trace.cjs` | L0 轨迹环形缓冲（50 条 / 7 天）+ `stableKeyOf` + 名称脱敏 | 无 |
| `desktop/elements.cjs` | L1 元素记忆（LRU 2000，`elements.json`，原子写） | trace（redactName） |
| `desktop/procedures.cjs` | L2 流程技能（主键 appKey，指纹去重，上限 300） | 无 |
| `desktop/compiler.cjs` | trace → steps（确定性，≥3 步）+ 可选 `nameIt()` | procedures |
| `desktop/memory-mirror.cjs` | 技能摘要 → `memory.saveMemory({kind:'note',key:'desktop.procedure.<id>'})` | 无 |
| `desktop/ipc.cjs` | `desktop:*` 通道 + 设置持久化/投影 + 事件推送 + `currentDesktop()` | policy |
| `main.cjs` | 创建引擎（容错）、注册 IPC、退出清理 | index.cjs（可缺） |
| `preload.cjs` | `window.movaDesktop.desktop.*` | — |
| `chat-agent.mjs` | 注入 `desktopTools`、系统提示、图片块透传 | tools.cjs、ipc.cjs |

## 2. `tools.cjs` 的 `operations` 契约

`createDesktopTools(operations, { approve, emit, vision, audit })` 里 `operations` 的形状。
**所有函数都可以缺省**：缺了就在调用时返回 `{ok:false, code:'not-implemented'}`，不会崩。
别名按顺序探测（括号内是备选名），实现任意一个即可。

```js
operations = {
  status()                        // → {available, reason, worker, session, app, appKey, window}
  windows(input)                  // (listWindows) {action:'list'|'active'|'displays', app, includeMinimized, limit}
  displays()                      // 可选；有就用于 action=displays
  snapshot(input)                 // (tree) {mode:'auto'|'full'|'diff', window, scope, depth, maxChars, boxes}
                                  //   → {mode, text, appKey?, window?, changed?, truncated?, refs?}
  read(input)                     // (readText/readWindow) {window, scope, format, maxChars} → {text, truncated}
  wait(input)                     // (waitFor) {for:'window'|'element'|'text'|'idle'|'stable'|'time', title, ref, text, ms, timeout}
  screenshot(input)               // (capture) {mode, window, region, maxLongEdge, annotate, zoom, reason}
                                  //   → {path, mimeType, width, height, mode?}
  act(input)                      // {action, target, value, keys?, to?, expect?, tier, timeout, snapshot}
                                  //   → {ok, changed?, diff?, tier?, code?, coords?, state?}
  app(input)                      // (appAction/launchApp) {action:'launch'|'activate'|'close', app, args, cwd}
  inspect(target)                 // 可选：{role,name,password,rect,stableKey,enabled}；用于密码框 R4 拦截
  handoff(input, signal)          // (takeOver) {reason, note} → {ok, resumed, ...}
  procedures | skills             // 技能库：list/get/find/save/report/retire(remove)
  recentTrace() | trace()         // 可选：返回本会话轨迹，desktop_skill save 无 steps 时用它编译
  nameIt({appKey, steps, params}) // 可选：编译器的命名钩子（便宜模型调用），可返回 string 或 {title,intent,verify}
  settings: { get() }             // 可选：桌面设置；没有则用 policy 默认值（最保守）
  getSettings()                   // 可选：同上，另一种写法
}
```

要点：

- `desktop_batch` **在 tools.cjs 内自己跑**（逐步授权、失败即停、最多 30 步），只调用 `act/wait/app`。
  如果 `index.cjs` 也实现了 `batch()`，不会被用到 —— 那是给 smoke 脚本用的。
- 引擎可以复用我的记忆四件套，把 `procedures` 直接传给 `operations`（`createProcedureStore({directory})`）。
- `tools()` 的返回必须是 `[{name,label,description,parameters,execute}]`；`execute(id, input, signal)`。

### 2.1 `createEngineOperations(engine)` 兜底适配层（已实现）

`index.cjs` 现在的 `tools()` 仍返回 `[]`（核心通道的 TODO）。为了不让接线悬空，
`tools.cjs` 导出 `createEngineOperations(engine)`，按引擎**已经暴露**的公开能力拼出上面的形状：

| 工具能力 | 依赖的引擎 API | 备注 |
| --- | --- | --- |
| `status()` | `engine.status()` + 最近一次快照的窗口 | 补 `app/appKey/window` 给审批卡与策略 |
| `windows()` | `engine.windows.list({includeMinimized})`、`foreground()` | 标题/exe 子串过滤、limit=50 上限 |
| `displays()` | `engine.windows.screenInfo()` | 只回 id/bounds/scaleFactor/primary |
| `snapshot()` | `session.observe({hwnd,maxDepth,maxChars,boxes})` + `engine.diff(prev,next)` | `mode:'auto'` 有上一次快照时给 ΔTree，否则全量 |
| `read()` | `session.observe()` 的紧凑文本 | 与 snapshot 同源，省一次树读取 |
| `act()` | `session.act({type,ref,text,key,...})` + `session.verify()` | 动作后 verify 得到 `changed/diff`；`no-change` 视为失败（batch 会停） |
| `wait()` | `windows.list` 轮询 / `session.observe` 轮询 | `stable`/`idle` 立即返回 |
| `app(activate)` | `engine.windows.activate(hwnd)` | `launch`/`close` 未实现 → `not-implemented`（见 §7） |
| `inspect()` | `session.snapshot.nodes` 按 ref/stableKey 查 | 密码框/disabled 在**执行前**拦截 |
| `recentTrace()` | 适配层内存里记的动作元数据 | 只记 `{op,stableKey,role,name,rect,ts,ok}`，不记输入值 |
| `procedures` | `engine.procedures`（`main.cjs` 挂上去的同一实例） | |
| `settings.get()` | `engine.settingsView()`（`main.cjs` 挂的），否则投影 `engine.settings.get()` | |

`chat-agent.mjs` 的取值顺序：`desktop` 参数 → `ipc.cjs#currentDesktop()` → 若 `engine.tools()` 返回空数组，
自动改用 `createDesktopTools(createEngineOperations(engine), {approve, emit, vision})`。
**引擎一旦自己实现 `tools()`，就走引擎的版本，兜底自动失效**（无需改 chat-agent）。

## 3. 设置契约（`desktop:get-settings` 返回的对象）

设置页（Agent D）拿到的就是下面这个对象；`desktop:set-settings` 接受同一个形状的**部分 patch**
（一层合并），类型不对回到默认值，未知字段忽略。持久化位置：`userData/desktop/policy.json` 的 `settings` 段
（其余顶层键原样保留）。

```json
{
  "enabled": false,
  "profile": "standard",
  "apps": {},
  "budget": { "maxMinutes": 10, "maxActions": 60, "maxVisionFrames": 20 },
  "overlay": { "glow": true, "targetOutline": true, "bubbles": true },
  "memory": { "auto": true },
  "advanced": {
    "maxDepth": 6,
    "treeTimeoutMs": 1500,
    "excludeProcesses": [],
    "vision": true,
    "groundingModel": "",
    "auditPath": ""
  }
}
```

- `profile`: `read-only` | `standard` | `full`（`read-only` 下 R2+ 一律走审批）。
- `apps`: `"excel.exe": "allow" | "ask" | "deny" | "route-to-browser"`，
  或 `{"allow":"allow","vision":false,"reason":"财务系统"}`；支持 `*` 通配（`*.bank*`）。
- 预算硬边界：`maxMinutes 1–60`、`maxActions 5–300`、`maxVisionFrames 0–60`；
  `maxDepth 1–12`、`treeTimeoutMs 200–15000`。
- 常量都从 `policy.cjs` 导出（`BUDGET_DEFAULTS` / `BUDGET_LIMITS` / `DEFAULT_SETTINGS` /
  `settingsDefaults()` / `normalizeSettings()`），设置页不要再写一份默认值。
- **投影**：`index.cjs` 自己的 `DEFAULT_SETTINGS` 是平铺的（`maxMinutes/maxActions/maxDepth/deadlineMs`）。
  `main.cjs` 创建引擎时把上面这份设置投影成平铺键当初始值；之后每次 `set-settings`
  由 `ipc.cjs` 调 `engine.settings.set({enabled,maxMinutes,maxActions,maxDepth,deadlineMs,excludeApps})`。
  渲染进程永远只看到嵌套形状，不存在两套真相。

## 4. IPC 通道

| 通道 | 类型 | 返回 |
| --- | --- | --- |
| `desktop:status` | invoke | `{available, reason, worker, session, enabled}` |
| `desktop:stop` | invoke | `{ok:true}`（引擎缺失 → `{ok:false, code:'desktop-unavailable'}`） |
| `desktop:resume` | invoke | `{ok:true}`（引擎无 `resume` 时自动退到 `desktop.session.resume`） |
| `desktop:get-settings` | invoke | 上面那个设置对象（出错也返回默认值） |
| `desktop:set-settings` | invoke | `{ok:true, settings}` |
| `desktop:skills` | invoke | `{ok:true, skills:[{id,title,appKey,stepCount,version,status,stats}]}` |
| `desktop:skills:remove` | invoke(id) | `{ok:boolean}` |
| `desktop:step` | 推送 | `{text, emotion?}` |
| `desktop:state` | 推送 | `{state:'running'|'paused'|'aborted'|'done', text?, reason?}` |
| `desktop:unavailable` | 推送 | `{available:false, reason}` |

- 所有 handler 都先 `authorize(event)`（`main.cjs` 的 `senderWindow`）；未授权返回 `{ok:false,error:'unauthorized'}`。
- 引擎存在 `desktop.on(name, fn)` 时自动桥接 `step/state/unavailable` 三个事件；
  `installDesktopIpc()` 还会返回 `{emitStep, emitState, emitUnavailable}` 供引擎直接调用。
- `installDesktopIpc()` 返回的 `dispose()` 会注销全部 handler（`main.cjs` 的 `before-quit` 已调用）。

## 5. 需要 `index.cjs` / 其它文件补的补丁

### 5.1 `electron/desktop/index.cjs`（Agent A）—— 可选但建议

**不补也能跑**：`tools()` 返回 `[]` 时 chat-agent 用 `createEngineOperations` 兜底（见 §2.1）。
补上则接的是引擎自己的编排，能力更强（真正走 session 的 tier 选择/升级/overlay）。建议：

```js
const { createDesktopTools } = require('./tools.cjs');

// 在 createDesktopEngine 内：
const procedures = options.procedures || createProcedureStore({ directory: root });

tools({ emit, approve, signal } = {}) {
  return createDesktopTools({
    // 有 session 编排时优先给这些（没有就返回 not-implemented，不会崩）
    status,                        // engine.status()
    windows: input => windows.list({ includeMinimized: input.includeMinimized }),
    snapshot: input => /* 建议：session.observe + ΔTree 缓存 */,
    act: input => /* 建议：session.act + session.verify */,
    read: input => /* session.observe/readText */,
    wait: input => /* 轮询 */,
    app: input => /* windows.activate / launch / close */,
    inspect: ref => /* 从当前快照按 ref 找节点，返回 {password, enabled, stableKey...} */,
    procedures,
    recentTrace: () => trace.recent(50),
    settings: { get: () => settingsView() },
    nameIt,                        // 可选
  }, { approve, emit });
},
```

同时建议给 `status()` 的 `reason` 用可读字符串（`unsupported-platform` / `uia-unavailable` /
`worker-exit` / `disabled`）—— 设置页会原样显示。

`main.cjs` 已经把这些东西准备好并挂在引擎对象上（不改 index.cjs 也能用）：

```js
desktop.procedures = desktopProcedures;        // 与 tools/设置页共享同一实例
desktop.settingsView = () => desktopSettings.read();   // 嵌套形状的设置
```

### 5.2 `electron/model-ipc.cjs`（**不在我的文件白名单内，未改**）—— 建议补 3 行

目前 `chat-agent.mjs` 用 `require('./desktop/ipc.cjs').currentDesktop()` 兜底拿引擎（`installDesktopIpc` 时记住的），
所以**不改也能跑**。若要让注入更显式：

```diff
   const browser = options.browser ?? null;
   const browserSettings = options.browserSettings ?? null;
+  const desktop = options.desktop ?? null;
...
           await runChatAgent({
...
             browser,
             browserSettings,
+            desktop,
```

`main.cjs` 已经把 `desktop` 放进 `installModelIpc(..., { ..., desktop })` 的 options 了。

### 5.3 `electron/desktop/overlay/*`（Agent B）

`desktop:step` 的 `{text, emotion}` 与 `desktop:state` 的 `running/paused/aborted/done`
已经是渲染进程的最终形状；overlay 不需要经过这两条通道（它自己在该进程里画），
但**主窗口状态条**要用它们。emotion 编号沿用 §12.1：`32 处理中 / 33 完成 / 34 出错 / 41 终止 / 35 等待输入`。

## 6. 与 `desktop-build-plan.md` 的差异 / 已决定的取舍

1. **工具是 10 个**（契约 §2.4 与 §13.1 都是 10 个；方案标题写“9 个”是笔误）。
2. `desktop_batch` 不在引擎侧实现（tools.cjs 自己跑），这样逐步授权、失败即停、
   `{recipe, inputs}` 参数替换、技能统计回写都在一处，测试也只需要假 operations。
3. 轨迹里的输入值只留 `valueHash + valueLength`，编译器把 `type/setValue` 一律编译成
   `{{p1}}` 占位符 —— 隐私优先，代价是重放时要传 `inputs`。
4. 审计字段固定 10 个（`ts/app/windowHash/action/targetHash/tier/ok/code/ms/approvalId`），
   窗口标题也哈希（标题常含业务信息）。没有 `valueHash` 字段：需求里没列，就不写。
5. 危险键 `Ctrl+Alt+Del / Win+L / Win+R` 一律 R4 → 直接 handoff，不尝试注入。
6. `enabled` 只做显示与设定页开关，不当作工具层的硬闸：工具是否注入由
   `desktop.status().available` 决定（避免“设置默认 false 导致 smoke 全挂”）。
7. 引擎的 `appKey` 目前只有 `exe`（worker 不给版本号），技能作用域实际上等于 exe；
   等 worker 的 `windows` 命令返回 `version` 后会自动变成 `exe|version`（`createEngineOperations` 已支持）。

## 7. TODO（下一轮）

- `index.cjs`：`tools()` 接上真正的编排；`windows.cjs` 补 `launch/close`（否则 `desktop_app` 只有 activate）。
- `capture.cjs`（视觉）落地后在 `createEngineOperations` 里补 `screenshot`，`desktop_screenshot` 即刻可用。
- `chat-agent.mjs` 的图片块现在只在 `model.input` 含 `image` 时透传；工具结果的图片不计入
  `TOOL_RUN_LIMIT` 字节预算，视觉预算应在引擎侧（`maxVisionFrames`）扣。
- `elements.cjs` 的 `name` 只做了轻量脱敏（邮箱/手机/长数字）；若要复用
  `services/memory-redaction.cjs` 的规则，需要把它改成可注入。
- `desktop_skill save` 的命名仍可接 `nameIt()`（引擎传 `operations.nameIt` 即可），当前默认模板标题。
