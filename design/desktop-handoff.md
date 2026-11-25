# 桌面操作（Computer Use）交接单

> 日期：2026-11-12 · 状态：**核心能力已通，记忆闭环/设置页联调/微信验收未完成**
> 这个文件给"接手的下一个会话"看，读完不用翻历史对话。

## 1. 三十秒判断现状

能做的事（全部有实机证据）：

```text
枚举窗口 / 读 UIA 树 / 压缩成文本树 / ΔTree 差异        ✅ 96 个单测
点击（Pattern 优先，坐标回退）/ 平滑移动光标            ✅
截屏（Electron 失败自动退 PowerShell GDI）              ✅
Windows OCR（zh-Hans-CN，带坐标）+ SoM 编号框           ✅
desktop_act {target:"#12"} 按编号点 OCR 文字框          ✅
浮层：小球 + 气泡 + 半宽呼吸光 + 箭头形光标描边          ✅
暂停：球变红 + 边光转红 + 气泡“点击 Mova 恢复操作”       ✅
鼠标闸门：运行中吞真人移动/点击，放行注入；长按 Ctrl+Shift 终止 ✅
10 个 desktop_* 工具（含 screenshot / handoff / app.launch·close） ✅
```

还差的事（按优先级）：

1. **记忆闭环没跑通一次**：`trace → compiler → procedures.save → desktop_batch {recipe}`。
2. 设置页只对 mock 验过，`desktop:get-settings/set-settings/status/skills` 未在真实 app 联调。
3. 记事本纯视觉端到端（截图→点编号→输入→截图验证）没做。
4. 微信全流程验收（用户要求暂缓）。
5. §12.7 目标控件矩形描边未实现（现只有光标箭头）。

## 2. 文件地图（`electron/desktop/`）

| 文件 | 职责 |
| --- | --- |
| `index.cjs` | 唯一出口：`createDesktopEngine()`；懒启动 host；`screenshot()`（Electron→PS 兜底 + 可选 OCR + SoM）、`handoff()`、`resolveMark()`、`settings.get/set` |
| `host.cjs` + `host/uia-worker.ps1` | 常驻 PowerShell UIA worker（无 .NET SDK 的替代）：ping/windows/foreground/tree/find/invoke/setValue/pattern/rect/focus/readText/activate/screenInfo |
| `host/capture.ps1` | GDI 截屏（不依赖 Electron/sharp） |
| `host/ocr.ps1` | `Windows.Media.Ocr`（WinRT + AsTask 桥接），输出带坐标文本行 |
| `windows.cjs` `tree.cjs` `compact.cjs` `diff.cjs` | 窗口/树/压缩/ΔTree |
| `actions.cjs` | ref → Pattern → 坐标回退 |
| `input.cjs` | koffi → user32：`glideTo`（平滑）、`click`（默认不还原光标）、`typeText`、`pressCombo`、`releaseAll` |
| `hook.cjs` | `WH_MOUSE_LL`（koffi `register` 注册回调），`LLMHF_INJECTED` 区分注入 |
| `interlock.cjs` | 闸门编排：running 吞输入、paused 只吞球上的点击 |
| `session.cjs` | 状态机 + 预算 + **首次 act 自动 start**（浮层/守护靠这个） |
| `overlay/` | 浮层窗口 + 渲染层（小球/气泡/呼吸光/箭头描边/暂停红） |
| `tools.cjs` | 10 个工具 + `DESKTOP_SYSTEM_PROMPT` + `createEngineOperations(engine)`；`#N` 点击在此解析 |
| `policy.cjs` `audit.cjs` `ipc.cjs` | R0–R4 / 审计 / 渲染进程 IPC |
| `trace.cjs` `elements.cjs` `procedures.cjs` `compiler.cjs` `memory-mirror.cjs` | 记忆四件套（**只有 procedures/compiler 进了生产路径**） |
| `capture.cjs` `capture-ps.cjs` `geometry.cjs` `verify.cjs` `vision/{som,grounder,ocr}.cjs` | 视觉层（`som`/`ocr` 已用，`grounder` 未接模型） |

渲染层：`src/features/desktop/desktop-settings.{js,css}` + `index.html` 的 `data-settings-item="desktop"`。

## 3. 下一步怎么做（照抄即可）

### 3.1 记忆闭环（先做这个）

> **2026-11-12 新发现（重要）**：`compile(trace, opts)` 是 **async**，而且**喂 session 的 trace 会返回 `{ok:false, code:'too-short', steps:[]}`**。
> 原因：`compiler.stepsFromTrace` 认的是 `{op, stableKey|path|name|role|rect, ts}`，
> 而 `session.act` 写入的是 `{at, type, ref, ok, code, via, ms}` —— **没有 `op` 字段，直接被过滤掉**；也没有可持久化的 locator。
> 所以记忆闭环卡在第一步，不是"没接线"，是"数据形状对不上"。`tests/desktop/compiler.test.cjs` 里有一条 `todo` 用例钉住了这个缺口。
>
> 两条修法（择一，约 10 行）：
> - **A（推荐）**：`session.act` 落 trace 时补上 locator。它已经拿得到 `action.ref`，在 `actions` 里再取一次 `rect/stableKey`（`actions.clickByRef` 内部就有 `rect` 调用，可顺手回传），写入 `{op:type, ts:at, stableKey|rect|name}`。
> - **B（便宜）**：`compiler` 入口做兼容归一化（`type→op`、`at→ts`、`ref→stableKey`）+ 在 `tools.cjs` 的 act 里把已经 `inspect()` 到的节点信息挂到调用参数上。
>
> 修完再往下走下面 4 步。

1. `session.cjs` 的 `act()` 已经在 push `trace` 条目（`{at,type,ref,ok,code,via,ms}`）。
2. 编译：`require('./compiler.cjs').compile(trace, { appKey, title })` → steps（≥3 步才产出）。
3. 落盘：`procedures.save(candidate)`；可选 `memory-mirror.mirror(procedure)` 镜像到 `mova_memories`。
4. 重放：`desktop_batch { recipe: id, inputs }`（`tools.cjs` 内已实现逐步授权/失败即停/≤30 步）。
5. 验证：同一任务第二次的 `actions` 计数与 token 应显著下降；连续失败 2 次调用 `procedures.retire(id)`。

### 3.2 设置页联调

在真实 Mova 里打开"设置 → 集成 → 电脑操作"，确认这四个 IPC 有返回：
`desktop:status` / `desktop:get-settings` / `desktop:set-settings` / `desktop:skills`。
`ipc.cjs` 里已有 handler；缺的多半是 `preload.cjs` 暴露或 `main.cjs` 注入。

> 2026-11-12：字段契约已经逐字段对齐并用脚本验证过（**不需要开 GUI**），见 §7。
> 真机点击链路仍未验，见 §7.6。

### 3.3 记事本纯视觉端到端（不碰微信）

```text
desktop_app {action:'activate', app:'notepad'}
desktop_screenshot {ocr:true, annotate:'som'}   → marks
desktop_act {action:'click', target:'#N'}       → 点在文字框中心
desktop_act {action:'type', value:'hello'}
desktop_screenshot {ocr:true}                   → 断言文本里出现 hello
```

### 3.4 微信验收（用户要求最后做）

已知前提：微信 4.x 是 Qt 自绘，UIA 只有 3 个节点 → **只能用"OCR 编号 + 坐标点击 + 剪贴板"**。
坐标实测（窗口摆在 60,40 / 约 1060×901 时）：搜索框 ≈ `(654,170)`，输入框 ≈ `(582,639)`，发送 ≈ `(533,745)`。
仍有未解问题：`input.typeText()` 返回 ok 但微信输入框不出字（Unicode `SendInput` 与剪贴板 `Ctrl+V` 都试过）——**先定位这一条**，再谈验收。

## 4. 踩过的坑（别再踩）

- **PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码**，中文字面量必坏 → `node scripts/add-bom.mjs <file>`。
- **PowerShell 里内联多行 JS 会被解析炸掉** → 写 `.mjs` 文件再 `node` 跑，别用 `node -e "…"`。
- **Electron 在 app ready 前访问 `screen` 会抛** → overlay 里必须延迟解析（已修）。
- **`node --test tests/desktop/`（目录形式）在 Node 24.18 报 MODULE_NOT_FOUND** → 用 `tests/desktop/*.test.cjs`。
- **koffi 回调必须 `koffi.register()`**，否则 `Cannot use non-registered callback beyond FFI call`。
- **不要用 Ctrl+A / Delete 清输入框**：焦点不在目标时会把桌面图标全选并删进回收站（真实事故）。
- `desktopCapturer + sharp` 在部分机器上会报 colourspace → 已接 PowerShell 截屏兜底。

## 5. 验收口径（微信一条未达成，别写成已完成）

- 单测：`node --test tests/desktop/*.test.cjs` → **129 pass / 0 fail / 0 todo**（2026-11-12 实测）。
- 设置页契约：`node scripts/desktop-settings-verify.cjs` → **30/30 OK**（退出码 0）。
- 纯视觉链路：`scripts/desktop-vision-e2e.cjs` → **8/8 PASS**（真机记事本，见 §8.1）。
- 记忆技能：`scripts/desktop-memory-e2e.cjs` → **5/5 PASS**，首次 4 次调用 → 重放 1 次调用（见 §8.2）。
- 微信：给"文件传输助手"发「你已经完成了」+ 完成清单 + 一个表情图 —— **未达成**，卡点与复现见 §8.3。

## 6. TODO（按顺序勾，别跳）

- [x] **P0 记忆闭环**：`rows → compile → procedures.save → get/find/report/retire → desktop_batch {recipe}` 全部在真实 store 上跑通；真机数字已拿到（首次 4 次工具调用 / 重放 1 次 `desktop_batch`，§8.2）
- [x] **P0 只读档没真正生效（安全项）**：`policy.cjs` 已改成 `risk = 3`；同时修掉同一处的反效果 —— `appRule()` 在只读档曾返回 `ask`，导致 **R0 读取也被拉成 R3**（只读档什么都不让读）。现在拦截只在风险档做，`tests/desktop/readonly.test.cjs` 三条护栏（R2→R3 / standard 不变 / R0-R1 不升档）
- [x] **P1 设置页联调**：`node scripts/desktop-settings-verify.cjs` 30/30；顺带修掉 6 个"看起来存进去了其实没有"的真 bug（见 §7.5）
- [x] **P1 记事本纯视觉端到端**：`scripts/desktop-vision-e2e.cjs` 8/8（§8.1）
- [x] **P2 §12.7 目标控件矩形描边**：`overlay.setTarget(rect, {label})`，只在真实注入前画、1.2s 自动收、Pattern 后台调用立刻收（`tests/desktop/overlay-target.test.cjs` 10 条）
- [x] **P2 grounder 接模型**：`main.cjs` 注入真实 `callModel`（走 providers + pi-ai 通道），`tools.act` 在 UIA 找不到目标时自动走 SoM 接地兜底（`tests/desktop/grounder.test.cjs` 7 条）
- [ ] **P3 微信全流程验收**（用户要求最后做）：发「你已经完成了」+ 完成清单 + 表情图
      **当前状态：未通过。** 卡点不是打字（文字/中文/剪贴板都验证过）而是**进不了会话**：微信 4.x 自绘，搜索面板里同时有「文件传输助手」会话行和「文件传输助手 - 功能」章节行，OCR + 点击 8 次都没稳定命中会话行；详情与下一步见 §8.3。
      **安全前提**：脚本已加 `assertWeChatForeground()`，打字/粘贴/回车前若前台不是 `Weixin.exe` 直接抛错退出（曾因为焦点漂移把 273 字粘进了别的窗口，虽然用户确认没有实际后果，但这个守卫必须保留）。
- [ ] **P3 文档补最后一笔**：`Mova桌面操作开发方案.md` §23 状态表已同步本轮修复，微信验收仍标"未达成"

## 7 设置页 ↔ IPC 契约（已验证）

> 2026-11-12 · 验证脚本 `scripts/desktop-settings-verify.cjs`（**不启动 Electron**）
> 结论：修复后 **30/30 通过，退出码 0**；修复前 `desktop:get-settings` 层本来就对，
> 但设置页只把 `profile` 对齐过，`apps` / `overlay` / `memory` / `advanced` 四组字段名全错，
> 表现为「界面上改了、刷新回来还是默认值」。§5 里写的「96/96」也已过时（现为 129/129）。

### 7.1 唯一权威：`electron/desktop/policy.cjs` 的 `DEFAULT_SETTINGS`

设置页有一套**只服务界面**的显示名字段，两套形状之间只有一个换算点（§7.3）。
下表左列是 IPC 契约（唯一权威），右列是设置页显示名。

| # | 主进程字段（`policy.cjs`） | 设置页字段 | 类型 | 合法值 / 范围 | 缺省值 | 非法值时主进程怎么兜底 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `enabled` | `enabled` | boolean | `true` / `false` | `false` | 非布尔 → `false`（`bool(top,false)`） |
| 2 | `profile` | `permission` | string | `read-only` \| `standard` \| `full` | `standard` | `oneOf(PROFILES)` → 其它值（含 `careful`/`trust`/数字）一律 `standard` |
| 3 | `apps` | `apps`（数组） | object：`appKey → rule` 或 `appKey → {allow,vision,reason}` | `allow` \| `ask` \| `deny` \| `route-to-browser`，key 支持 `*` | `{}` | 非法规则整条丢弃；key trim 后 ≤120 字符、最多 500 条 |
| 4 | `apps.*.vision` / `*.reason` | —（页面不改） | boolean / string | — | 不写 | 页面只显示 `allow|ask|deny`，这些形式和 `route-to-browser` 由页面原样保留（§7.3） |
| 5 | `budget.maxMinutes` | 同名 | number | 1–60（整数） | `10` | `int()` 夹取到边界 |
| 6 | `budget.maxActions` | 同名 | number | 5–300 | `60` | 夹到 300 / 5；`'abc'` → 回退上次值 |
| 7 | `budget.maxVisionFrames` | 同名 | number | 0–60 | `20` | 夹取 |
| 8 | `overlay.glow` | `overlay.edgeGlow` | boolean | — | `true` | 页面**只读**（安全设施，禁止关闭）；主进程 `bool()` 兜底 |
| 9 | `overlay.targetOutline` | `overlay.highlight` | boolean | `true` / `false` | `true` | 非布尔 → 上次值 |
| 10 | `overlay.bubbles` | `overlay.bubble` | boolean | 同上 | `true` | 同上 |
| 11 | `memory.auto` | `memory.autoSkill` | boolean | 同上 | `true` | 同上 |
| 12 | `advanced.maxDepth` | `advanced.uiaDepth` | number | 1–12 | `6` | 夹取 |
| 13 | `advanced.treeTimeoutMs` | `advanced.timeoutMs` | number | 200–15000 | `1500` | 夹取 |
| 14 | `advanced.excludeProcesses` | `advanced.denyExe` | string[] | ≤64 项，每项 ≤64 字符，小写去重 | `[]` | 非数组 → `[]`；非字符串项丢弃 |
| 15 | `advanced.vision` | `advanced.visionFallback` | boolean | `true` / `false` | `true` | 非布尔 → 上次值 |
| 16 | `advanced.groundingModel` | `advanced.grounderModel` | string | ≤120 字符 | `''` | 非字符串 → `''`，超长截断 |
| 17 | `advanced.auditPath` | `advanced.auditPath` | string | ≤400 字符 | `''` | 同上；页面只读展示 |

**一致性结论**：修复前 17 行里有 **10 个键名对不上**（第 3、9、10、11、12、13、14、15、16 行 + 第 6/7/13 行的范围越界）；
`enabled` / `budget.*` / `advanced.auditPath` 早就同名，`profile` 是上次事故里单独修过的一行。
现在全部由 §7.3 的映射函数换算，脚本 C1–C12 锁住。

### 7.2 通道与回包形状

| 通道 | 方向 | 回包 |
| --- | --- | --- |
| `desktop:status` | invoke | **裸对象** `{available, reason, worker, session, enabled}`；未授权 → `{available:false,reason:'unauthorized',...}` |
| `desktop:stop` | invoke(reason?) | `{ok:true}`；无引擎 → `{ok:false,code:'desktop-unavailable'}` |
| `desktop:resume` | invoke | 同上（无 `resume` 时自动退到 `desktop.session.resume`） |
| `desktop:get-settings` | invoke | **裸设置对象**；未授权/出错 → `policy.settingsDefaults()`（不抛） |
| `desktop:set-settings` | invoke(patch) | `{ok:true, settings}`；非对象 → `{ok:false,error:'invalid-input'}`；未授权 → `{ok:false,error:'unauthorized'}` |
| `desktop:skills` | invoke | `{ok:true, skills:[...]}`（永远数组，无引擎为 `[]`） |
| `desktop:skills:remove` | invoke(id) | `{ok:boolean}`；id 非字符串 → `{ok:false,error:'invalid-input'}` |
| `desktop:step` / `desktop:state` / `desktop:unavailable` | 推送 | `{text,emotion?}` / `{state,text?,reason?}` / `{available:false,reason}` |

`desktop:get-settings` 是裸对象、`set-settings` 是 `{ok,settings}`，两者形状不同 —— 所以设置页的
`unwrap()`（`desktop-settings.js:108`）必须三种都认：`{ok,value}` / `{ok,settings}` / `{ok,skills}`，
再退到裸对象。

### 7.3 两套形状的唯一换算点（`src/features/desktop/desktop-settings.js`）

| 函数 | 行 | 作用 |
| --- | --- | --- |
| `fromMain(raw)` | `:211` | 主进程形状 → 页面显示形状；缺字段/非法值回页面默认值（通道不可用时也能画） |
| `toMainPatch(patch, prevApps, baseApps)` | `:242` | 页面 patch → 主进程 patch；**只发 patch 里出现的分节** |
| `appsFromMain(raw)` | `:196` | `apps` 映射 → 页面数组（只列 `allow|ask|deny`） |
| `appKeyOf(app)` | `:188` | 页面应用 → `policy.appRule()` 认的 appKey；裸名字补 `.exe`（否则 exe 比对永远命不中） |

`apps` 的三条语义（主进程 `store.patch` 只按 key 做一层合并，删不掉键）：

1. **整份发送**：改一条规则的级别时会带上全部规则；
2. **显式置 `null` = 删除**：`policy.normalizeSettings` 丢弃非法值，键就没了；
3. **看不见的形式原样保留**：`baseApps`（主进程上次回包的原始 `apps`）保证 `route-to-browser`、
   `{allow,vision,reason}` 这类页面显示不了的形式不会被一次开关操作抹掉。

### 7.4 怎么重跑

```powershell
cd C:\Users\34119\Documents\Mova
node scripts/desktop-settings-verify.cjs      # 契约验证：30 项；全过 → 退出码 0
node --test tests/desktop/*.test.cjs          # 单测基线（Node 24 必须用 glob，不能传目录）
```

正常输出尾部（先打印每条 `OK`/`FAIL`，再打汇总）：

```text
OK   C10 删应用规则：显式置 null 才会被主进程丢掉  (excel.exe 已删除，word.exe 保留)
OK   C11 设置页 unwrap 认得三种回包：{ok,value} / {ok,settings} / {ok,skills}  (4 种形状)
OK   C12 设置页不再把显示用 patch 直接发给主进程  (updateSettings / resetAll 都过映射)
----------------------------------------
OK   全部 30 项通过：三档 read-only|standard|full 往返一致，非法值归一化成 standard，desktop:skills 回数组
```

脚本分三层，**不需要 Electron**：

- **A 纯函数层**（A1–A5）：直接 `require('../electron/desktop/policy.cjs')`，锁默认值、三档枚举、边界夹取、纯函数性。
- **B handler 层**（B0–B9）：用假 `ipcMain`（`handle/removeHandler` 记在 Map 里）+ 临时目录 store 调
  `installDesktopIpc()`，然后把注册进去的 handler 当普通函数 `invoke`。`ipc.cjs` 只在 `resolveWindows()`
  里惰性 `require('electron')`，注入 ``getWin: () => null`` 之后与 Electron 完全解耦。
  覆盖：通道集、默认值、三档 set→get 往返、非法值归一化、边界、未知字段、落盘重读、
  `desktop:skills` 回数组、未授权降级、坏输入不抛。
- **C 静态层**（C0–C12）：设置页是前端 ESM，抓不到运行时，所以把源码里
  `const PERMISSIONS = [` 到 `/* ── 页面骨架` 之间的**纯逻辑段**（常量 + 归一化 + 映射函数，
  没有 DOM/import）抠出来用 `new Function` 求值，再用与主进程相同的形状做
  「主进程 → 页面 → 主进程」往返。这是**降级验证**：不是跑真渲染进程，见 §7.6。

### 7.5 本次修掉的真 bug（只改了设置页，主进程一行没动）

1. **字段名错配（主要问题，10 个键）**：`overlay.highlight/bubble`、`memory.autoSkill`、
   `advanced.uiaDepth/timeoutMs/denyExe/visionFallback/grounderModel`、`apps` 用数组 ——
   主进程 `normalizeSettings` 不认识这些名字，读的时候永远回默认值、写的时候直接丢弃。
   **表现**：改任何开关都"看起来成功了"，重新打开设置页又变回默认。
   修法：加 `fromMain`/`toMainPatch` 两个映射函数（`:211`、`:242`），
   `loadSettings`（`:1059`）、`updateSettings`（`:892`）、`resetAll`（`:1002`）全部走映射 ——
   这正是上次 `{permission:'careful'}` 事故的同一类根因，只是当时只修了 `profile` 这一行。
2. **数字输入区间越界**：页面允许 `maxActions 1–500`、`maxVisionFrames 0–200`、`timeoutMs 500–60000`，
   主进程硬边界是 `5–300` / `0–60` / `200–15000` → 用户能选到"存进去被夹成另一个数"的值。
   修法：`NUMBER_FIELDS`（`:60–63`）与三个 `<input>` 的 `min/max` 一起对齐。
3. **默认值不一致**：`advanced.timeoutMs` 页面写 8000、主进程是 1500（`:54`）。
4. **`unwrap` 只认 `{ok,value}`**：`desktop:set-settings` 回的是 `{ok:true,settings}`，
   `unwrap` 拿到 `undefined`，保存后前端用不上主进程归一化后的真相（`:108`）。
5. **技能列表永远读不到**：`preload.cjs` 暴露的是 `desktop.skills()`（函数），页面却只找
   `skills.list()` / `listSkills()` → 永远显示"通道不可用"（`:767–785`）。
6. **应用规则删不掉 / 重置清不空**（主进程按 key 合并的特性）：改为整份发送 + 删除项显式 `null`
   （`:248–265`），同时保留页面显示不了的规则形式。

> 主进程侧 `policy.cjs` / `ipc.cjs` / `preload.cjs` **没改**：A/B 层验证本来就通过（三档往返、
> 非法值归一化、`desktop:skills` 回数组都是对的），所以 `node --test tests/desktop/*.test.cjs` 基线不变。

### 7.6 已知未验证的部分（要人工/GUI）

- **真实跨进程链路**：设置页 → `preload.cjs` 的 `contextBridge` → `ipcRenderer.invoke` → handler。
  脚本用假 `ipcMain` 直接调 handler，跨进程这一段没跑。
- **真实窗口里的 UI 交互**：三档单选的点击与方向键切换、开关的 `aria-checked`、`toast`/`confirm` 文案。
- **应用规则表单**：添加/取消/删除只验了数据映射，没验 DOM 事件与 CSS 表现。
- **重置与「立即停止」**：`confirmAction` 流程未点过；`clearElements` / `openAuditFolder` / `resetSettings`
  preload 目前**没有暴露**，页面会降级提示"当前版本不支持"（不是 bug，但也没验过）。
- **整进程重启后的持久化**：脚本只在同一目录新建 store 模拟重读，没真的重启 Mova。
- **技能列表/删除**：只验了假 store 的 `list`/`retire` 返回形状，没验真实 `procedures.cjs` 落盘。
- `overlay.glow` 页面只读，因此不在往返覆盖内；主进程仍允许被 patch 改成 `false`（界面没有入口）。

## 8. 真机验收记录（2026-11-12，本机 1440×900 DIP / scaleFactor 2）

复跑方式统一是：
```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\<脚本>.cjs
```
日志与证据都落在 `design/e2e/`。

### 8.1 纯视觉链路（`scripts/desktop-vision-e2e.cjs`）→ 8/8 PASS

`design/e2e/vision-e2e.log`

| 检查 | 结果 |
| --- | --- |
| 找到记事本窗口 + 拉到前台 | PASS |
| 窗口级截图 + OCR + SoM | PASS（1082×1063，marks 10，`crop={344,260,1468,1442}`，`captureScale=0.737`）|
| OCR 找到「文件」菜单编号 | PASS（`#3`，box `[29,75,42,21]`）|
| `#N` 换算屏幕坐标 | `(412,376)` —— 344 + (29+21)/0.737 |
| `#N` 点击 | PASS（`via: coordinate`）|
| 点击后菜单弹出（视觉可见新条目）| PASS（`新建/另存为/退出`）|
| 拿到编辑区矩形并聚焦 | PASS |
| 输入后 OCR 读回 | PASS（`mova-test-900257`）|

这一轮同时修掉三个让"视觉兜底看着有、其实点不准"的问题：
`resolveMark` 没乘 `captureScale`（1440 屏缩到 1280 时偏 11%）、`screenshot({hwnd})` 没真的裁窗口（OCR 读到别的窗口）、
`windows.activate` 抢不到前台（补 ALT 键解锁 + `SetWindowPos`/`BringWindowToTop`，见 `host/uia-worker.ps1`）。

### 8.2 记忆技能（`scripts/desktop-memory-e2e.cjs`）→ 5/5 PASS

`design/e2e/memory-e2e.log`

```
第一次执行  {"calls":4,"tools":["desktop_snapshot","desktop_act(click)","desktop_act(type)","desktop_act(key)"]}
编译结果    {"ok":true,"stepCount":3,"steps":["click","type","key"],"params":["p1"]}
技能存盘    dp_xxx
重放        desktop_batch {recipe} → {"ok":true,"steps":[click,type,key]}   ← 1 次调用
OCR 复核    PASS（换参数后的新文字真的写进记事本）
调用次数对比 {"firstRun":4,"secondRun":1,"saved":3}
```

这一轮补上的重放断点（都是真 bug，不是测试写法问题）：
1. `tools.act` 的轨迹行不记 `keys` → 回车那一步被 compiler 整步丢掉（技能少一步）；
2. 技能里的 `target` 是 `{stableKey|path|point}` 对象，重放直接塞给 `session.act` → `unknown ref [object Object]`；
   现在 `resolveTarget()` 先取一次会话快照换成活 ref，换不到才退 `stable:<key>`，再不行报 `target-unresolved`；
3. `desktop_batch` 把 `no-change` 当失败中断重放（点空白处/聚焦输入框都会这样）→ 现在按软失败处理并继续；
4. 动作后会话快照作废，后续动作拿不到 locator → 加 `nodeCache`（ref → 节点）让连续动作仍能记下目标。

### 8.3 微信全流程 → **未达成**

`design/e2e/wechat-accept.log`（8 次尝试，最好一次 `5 pass / 8`）
> 注意：脚本每次运行都会重写这个日志，所以它**只保留最近一次**。当前里面是 round 27 的 dry-run
> （`找到微信窗口 FAIL`，因为微信主窗口当时不在前台/已收进托盘）。历史那 8 次尝试的结论见本节文字描述。

已验证可行的部分：
- 找到主窗口：`Weixin.exe`「微信」1888×901 @ (61,40)；`WeChatAppEx.exe`（小程序/支付详情）必须排除，否则会往支付页打字；
- 拉到前台：`activate` + ALT 解锁后 `foreground=true`；
- 视觉搜索：OCR 找到搜索框占位「文件传输助手 · 搜一搜」并点中，中文名经剪贴板写进搜索框（`typeText` 返回 `clipboard` / 273 字）；
- 表情包：`sharp` 生成 280×280 PNG（`design/e2e/mova-sticker.png`）；Electron 的 `clipboard.writeImage` 在此环境**不可用**，
  改用 `powershell -sta` + `System.Windows.Forms.Clipboard::SetImage`（脚本会落一个 `set-clipboard-image.ps1`）。

卡点：**进不了会话**。搜索面板里同时出现「文件传输助手」会话行与「文件传输助手 - 功能」章节行，
按文本匹配会点到章节行；按 y 最大取会话行再双击仍然停在面板里（`panelGone=false`），随后焦点被抢，脚本按守卫中止。

下一步（按可靠性排序）：
1. **人工先打开一次「文件传输助手」会话**，脚本只需「点输入框 → 粘贴 → 回车」，一次就能过（最稳，推荐先这样验收）；
2. 用 `screenshot({hwnd})` 存下来的 PNG 人工标一次会话行坐标，写进脚本当锚点（窗口尺寸/DPI 变化会失效，需断言校验）；
3. 试 `Ctrl+F` → 输入 → `Down` → `Enter` 组合（曾试过 `Down+Enter` 未生效，可能是面板需要先在结果列表内聚焦一次）。

**脚本已改成默认 dry-run（2026-11-12 晚）**：
- 不加参数 = 只验证「能进到会话」就停手，**不打字、不发送**；
- 真发送必须显式 `--send`；
- 打开会话优先走**左侧会话列表直接点**（`tryOpenFromList()`，只认左栏 x < 窗口左边 + 360DIP 的精确匹配行），
  失败才退回搜索面板（`tryOpenFromSearch()`），从根上避开「- 功能」章节行。

本轮（round 27）跑 dry-run 时微信主窗口不在（`Weixin.exe` 有进程但无 `MainWindowTitle`，收在托盘/未登录），
所以连 dry-run 也没跑成；下次要验首先让微信主窗口可见。

**安全说明**：微信脚本新增 `assertWeChatForeground()`，打字/粘贴/回车前若前台不是 `Weixin.exe` 立即抛错退出。
起因是中段有几次焦点漂移，273 字粘贴可能落进了别的窗口（用户已确认没有实际后果）。以后任何"往某个应用打字"的脚本都该带这个守卫。

### 8.4 小球点击恢复 + 终止收尾（用户报的两个 bug，2026-11-12 修）

现象：① 点左下角小球不恢复操作；② 终止对话后浮层不消失、电脑操作也没停。

**① 点球不恢复：两个原因叠加**
1. **命中区算错**：`BALL = {left:12, bottom:92, size:96}` 算出来是 `y∈[H-188, H-92]`，
   而 CSS 里球是 `--hud-offset-bottom:22 / --ball-size:44` → 球在 `y∈[H-66, H-22]`，**根本不在命中区里**。
   现在 `BALL = {left:12, bottom:78, size:68}`（球外扩 12px）。
2. **坐标系错**：`WH_MOUSE_LL` 回调给的是**物理像素**，`ballRect()` 用的是 `display.bounds`（DIP）。
   scaleFactor=2 时 y 差一倍，必然判不中。现在 `interlock.toDip()` 按光标所在显示器的 `scaleFactor`
   把物理点折回 DIP，`insideBall()` 再按**该屏**的 bounds 判（副屏负坐标也对）。

**② 终止不收尾**：`model:cancel` 以前只 abort 模型 run + 取消审批，没有碰桌面引擎。
现在两处兜底：
- `model:cancel` handler 里 `void desktop?.stop?.('user-cancel')`；
- `model:complete` 的 `finally`：`aborted || session in (running|paused)` → `desktop.stop('user-cancel' | 'turn-end')`
  （一轮对话结束就不该留着浮层和鼠标钩子）。

**验证**
- `node --test tests/desktop/interlock.test.cjs` → 6/6（命中区/CSS 对齐、scaleFactor=2 物理点命中、旧 bug 回归"把 DIP 当物理"必须不命中、球外不命中、副屏负坐标、screen 缺失不抛）。
- `scripts/desktop-ball-smoke.cjs` → **8/8 PASS**（`design/e2e/ball-smoke.log`）：
  命中区 `{12,822,68,68}` / 球心 DIP `(46,856)` → 物理 `(92,1712)` / 真人点击→`paused` / 点球→`running` /
  终止后 `state=aborted, hooked=false, overlay exists=false`。
- 说明：真实鼠标点击无法自动化（我们的注入带 `LLMHF_INJECTED`，钩子按设计放行），
  所以冒烟用 `interlock.handleClick(物理坐标)` 走同一条分支；坐标换算的正确性由单测覆盖。
- 全套：`node --test tests/desktop/*.test.cjs` → **135 pass / 0 fail**。

### 8.5 收尾三件（verify 接入 / 技能记忆镜像 / 暂停样式收口）

**① verify.cjs 接进引擎（有真实功能缺口的那件）**
- `index.cjs` 里懒创建 `createVerifier({ diff: diffTrees, sharp })`，作为 `deps.verify` 交给 session；
- `session.verify({conditions:[...]})` 会走条件引擎（`pixels / focused / element / window / text`），
  失败时透出**条件自己的错误码**（`pixels-unchanged` 等），不再一律 `no-change`；没有 `conditions` 时保持原 ΔTree 行为；
- `tools.act` 新增 `pixels:true`（或 `expect:{kind:'pixels'}`）：动作前拍一帧、动作后拍一帧，交给 `pixels` 条件判。
  **按点击点裁 ±260px 区域**再比——全屏比对时一个下拉菜单只占 0.3%，远低于 2% 阈值（实测 `meanAbsDiff 0.0033` 被判"没变"）。
  区域比对后实测 `meanAbsDiff 0.33 / 阈值 0.012`；
- 顺带修掉一个自己引入的 bug：内部取帧不能污染 `lastFrameCtx`/`lastMarks`（否则下一次 `#N` 会按全屏帧换算，点到屏幕外
  `y=4094`）。`engine.screenshot` 新增 `internal:true` 供内部取帧用。

**② 桌面技能镜像到 `mova_memories`**
- 新增 `electron/desktop/memory-mirror.cjs`（与 `browser/memory-mirror.cjs` 同构）：`summaryOf()` 生成
  「[桌面技能] appKey · 标题 / 适用 / 步骤 / 成功率」，`mirror()` 写 `kind:'note'`、`key:'desktop.procedure.<id>'`；
- `main.cjs` 在 `desktopProcedures` 创建后包一层 `save`：保存成功就 `void mirror(record)`（`memoryRepository` 还没创建，用 getter 惰性取）；
- 写记忆失败一律返回 null，不影响技能保存；同一技能重复保存由 `addMemory` 按 `text + key` 去重。

**③ 暂停样式收口**
- 删掉 `overlay.html` 的 `setPaused()`（没有任何 JS 调用它）与 `.stage[data-paused="1"]` 两条死样式
  （只压暗边光、从不生效），暂停视觉只剩 `body.paused` 一套（球变红 + 边光转红 + `paused-pulse`）；
- `scripts/desktop-ball-smoke.cjs` 截图 `design/e2e/ball-1-paused.png` 复核过：红球 + 红边光 + 「点击 Mova 恢复操作」气泡都在。

**验证（本轮）**
| 项 | 结果 |
| --- | --- |
| `tests/desktop/*.test.cjs` | **148 pass / 0 fail**（新增 `verify-wire` 7 条、`memory-mirror` 6 条） |
| `scripts/desktop-pixels-e2e.cjs` | **5/5 PASS**（`design/e2e/pixels-e2e.log`）：`#3 文件菜单` → `pixels:{ok:true, meanAbsDiff:0.3392}` → `changed:true` |
| `scripts/desktop-ball-smoke.cjs` | 8/8 PASS（CSS 清理后无回归） |



