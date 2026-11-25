# Mova 链接与文件视图开发方案

> 状态：**v1.0 已实施（2026-11-12）**，实施记录与偏差见 §10。
> 范围：右侧面板从“能看网页 / 能看纯文本”升级为**统一的链接与文件视图**（网页、代码、Markdown、图片、PDF、目录浏览），并补上**选区引用、元素引用**两条“带上下文回对话”的链路；同时把“站点技能”的手动入口撤掉，改为**由模型判断是否沉淀**。
> 不在此范围：Agent 化浏览器的动作体系（快照 / 点击 / 站点技能重放本身）、多标签体系重构、桌面操作、Git 写入。
> 设计依据：以 [design/source/Mova设计规范.md](../../design/source/Mova设计规范.md) 为准（与 [styles.css](../../styles.css#L1-L2) 实际色值一致）。根目录的 [Mova设计规范.md](Mova设计规范.md) 内容更旧（绿青色调 `#141718`）、只是文件时间较新，**本次不作为依据**，建议后续合并归档，避免两份规范继续漂移。

## 已确认的决策

| # | 决策 | 选择 |
| --- | --- | --- |
| 1 | 代码高亮引擎 | **Shiki**（VS Code 同源语法，静态内联语言包 + 自定义配色） |
| 2 | 目录视图形态 | **列表行**（图标 + 名称 + 大小/时间，32px 行高） |
| 3 | 三个点菜单 | **按位置切换**：网页模式 = 标签页（现状），文件/目录模式 = 当前文件夹条目 |
| 4 | 引用进对话的形式 | **引用 chip**：发送前是输入框上方可删除的 chip；发送时合并进消息 |
| 5 | 网页选区浮层位置 | **宿主浮层贴选区**（页面内只上报坐标，UI 在 Mova 面板里渲染） |
| 6 | 站点技能入口 | **工具栏不留入口**，由 AI 判断是否保存；设置页保留管理列表 |
| 7 | 引用发送后可见性 | **保留可见**：合并成消息开头的引用行，刷新/回溯后仍在 |

---

## 0. 一句话结论

右侧面板保留现在这套浏览器外壳（图标、43px 工具条、胶囊地址栏、三个点），把“地址栏”升级成**位置栏 + 面包屑**，把“舞台”升级成**按类型分发的渲染器**（网页 / Markdown / Shiki 代码高亮 / 图片 / PDF / 目录列表），再把“选区”和“页面元素”变成**可引用的 chip** 回到输入框。技术上分三块：主进程新增受权限约束的目录/读取 IPC；渲染层新增位置模型 + 渲染器 + 引用 chip；网页内的选区与元素选择走 CDP 注入（webview 的 preload 被主进程主动删掉了，见 §2.5）。

---

## 1. 需求拆解与验收口径

| # | 你的要求 | 现状 | 目标（可验收） |
| --- | --- | --- | --- |
| R1 | AI 回复里的链接点一下就进右侧 | HTTP(S) 与相对路径已能路由；多根目录解析弱、无“在右侧打开”提示 | 回复里的 http(s)、裸链接、Markdown 链接、相对路径**都能点开**；多根目录按“文件是否存在”自动选根；失败给明确提示；`Ctrl/⌘+点击` 走系统浏览器 |
| R2 | 右侧保持现在浏览器 UI、图标不变 | 工具条：后退 / 前进 / 刷新 / 站点技能；地址栏：地球 + 输入 + 箭头；三个点 | 图标尺寸、间距、背景**一律不动**；闪电换成“选择”图标；地址栏内容随位置类型变化 |
| R3 | 网址栏显示当前文件位置 | 文件模式把相对路径直接塞进 `<input>` | 文件/目录模式在胶囊里显示**面包屑**（`项目 › src › app.js`），聚焦后变回可编辑输入 |
| R4 | 点右侧箭头在资源管理器打开 | 文件走 `changes:reveal`，网页走系统浏览器 | 文件=选中该文件；目录=打开该目录（补 IPC）；网页=系统浏览器；无位置时禁用 |
| R5 | 点三个点看当前文件夹目录 | 三个点=标签页菜单（标签条被 CSS 隐藏，是唯一入口） | 文件/目录模式：菜单顶部展示当前文件夹条目，目录在前；网页模式保持标签页菜单 |
| R6 | 点不同文件即视渲染 | 只有 `text/plain` → `<pre>`；图片/PDF → blob iframe | Markdown 渲染格式、代码按关键字着色、图片/PDF/二进制分别处理；切换不重开面板、不闪白 |
| R7 | 点面包屑上一级 → 文件管理器视图 | 无 | 列表视图，可进入文件夹或打开文件；键盘、空态、错误态、截断提示齐全 |
| R8 | 选中 AI 回答文字 → “引用到对话” | 无选区处理 | 选区上方浮层 → 点击生成引用 chip → 输入框上方可见、可删；发送后引用在消息里保留 |
| R9 | 右侧视图选中文字同样能引用 | 无 | 文件/Markdown/代码视图同 R8；网页选区经 CDP 上报后由**宿主浮层**承接 |
| R10 | 闪电 → 选择图标，能选当前网站任意元素并引用 | 闪电打开“站点技能”浮层 | 选择模式：悬停描边 + 标签、点击捕获不跳转、浮层确认后生成引用 chip（元素摘要 + 选择器 + URL） |
| R11 | 站点技能改为 AI 判断 | 工具栏手动列表/保存 + 成功批次静默自动记录 | 工具栏无入口；一次可复用多步流程成功后由**模型调用工具**决定保存；设置页可查看/删除/清空 |

---

## 2. 现状调研（事实与代码位置）

### 2.1 右侧面板

- 面板是**原生 JS**，[side-browser.js](../../src/features/browser/side-browser.js#L4-L882) 在运行时插入 `.content-frame`，同时管工具条、标签页、工作区、登录、接管、技能浮层、宽度拖拽。没有 React。
- 工具条结构（[side-browser.js](../../src/features/browser/side-browser.js#L12-L17)）：`后退 / 前进 / 刷新 / 站点技能` + 地址表单（`地球 + input + 箭头`）+ `三个点`；下面一行标签页/工作区被 [side-browser.css](../../src/features/browser/side-browser.css#L570) `.browser-tabs{display:none!important}` 隐藏，所以**三个点是标签页唯一入口**（[L754-L801](../../src/features/browser/side-browser.js#L754-L801)）。
- 视觉参数（[side-browser.css](../../src/features/browser/side-browser.css#L3-L7)、[L50-L62](../../src/features/browser/side-browser.css#L50-L62)、[L81-L132](../../src/features/browser/side-browser.css#L81-L132)）：`--browser-bar-height:43px`、`--browser-control:23px`、`--browser-address-height:26px`、chrome `#2b2b2b`、底 `#181818`、地址字号 11px、胶囊圆角 999。**本次不改这些值。**
- 舞台三层互斥（[side-browser.js](../../src/features/browser/side-browser.js#L17)）：`<webview>`、`<iframe>`（图片/PDF blob）、`<pre class="browser-text">`；分发逻辑现在是 [navigate()](../../src/features/browser/side-browser.js#L671-L697) 里的 if/else。
- 导航：每标签独立 `history/index`（[makeTab](../../src/features/browser/side-browser.js#L232-L290)）；后退/前进优先 webview 自身历史（[L711-L735](../../src/features/browser/side-browser.js#L711-L735)）；刷新 [L731-L735](../../src/features/browser/side-browser.js#L731-L735)；箭头 [L736-L740](../../src/features/browser/side-browser.js#L736-L740)。
- 宽度：`--browser-width`，最小 320、最大 72%，与聊天最小 360 共存（[L802-L852](../../src/features/browser/side-browser.js#L802-L852)）。**320px 是硬约束**：面包屑、目录行、浮层都要在这宽度下可用。

### 2.2 聊天侧链接

- Markdown 渲染在 [markdown-renderer.js](../../src/features/chat/markdown-renderer.js#L52-L73)：`http(s)` 链接 `preventDefault` 后派发 `mova:open-reference`（[L54-L59](../../src/features/chat/markdown-renderer.js#L54-L59)）；相对路径（非绝对、无 `..`、无协议）也走同一事件（[L60-L64](../../src/features/chat/markdown-renderer.js#L60-L64)）。
- 面板侧监听（[L853-L865](../../src/features/browser/side-browser.js#L853-L865)）：URL 直接开；文件按 `rootId` 或 `项目名/路径` 前缀匹配，**匹配不到且根目录多于一个就报错**——这是“点文件偶尔打不开”的真实原因。
- 只在 `window.movaDesktop` 存在时拦截（[markdown-renderer.js](../../src/features/chat/markdown-renderer.js#L56-L58)），浏览器预览保持原生行为，保留。
- `remark-gfm` 已启用（[L81](../../src/features/chat/markdown-renderer.js#L81)），裸 URL 会被自动链接。

### 2.3 文件预览 IPC

- [main.cjs](../../electron/main.cjs#L472-L489)：`preview:file` 校验 `read` 能力 → `resolveInside()` → 20MB 上限；只有 5 种图片和 PDF 走 base64，其余含 0 字节就拒绝，否则一律 `text/plain` UTF-8。**没有类型、目录、编码、分块能力**。
- `preload.cjs` 只暴露 [preview.file](../../electron/preload.cjs#L39) 与 [files.reveal](../../electron/preload.cjs#L153-L155)（内部 `changes:reveal`）。
- `changes:reveal` 护栏在 [changes-ipc.cjs](../../electron/changes-ipc.cjs#L154-L178)：`rootId + 相对路径` → `resolveInside` → `shell.showItemInFolder`；**没有“打开目录”**。
- 目录列表可复用范式：[agent-tools.cjs](../../electron/agent-tools.cjs#L366-L401) 的 `treeWithin()`（排序、跳符号链接、`SKIPPED_DIRS`、条数上限、错误收集）。新 IPC 共用护栏，但目录视图只跳过 `.git`。

### 2.4 浏览器能力（可复用地基）

- 每 guest 一个 CDP 客户端 [cdp.cjs](../../electron/browser/cdp.cjs#L19-L103)（`Page/DOM/Runtime/Accessibility` 已 enable）；`PageTarget` 在 [controller.cjs](../../electron/browser/controller.cjs#L174-L195) 注册，带 `onUserInput` 被动接管钩子。
- “隔离世界跑脚本”范式：[read.cjs](../../electron/browser/read.cjs#L52-L72)（`Page.createIsolatedWorld` + `Runtime.evaluate`）。
- 元素引用体系：AX 快照 → `uid`（[snapshot.cjs](../../electron/browser/snapshot.cjs#L10-L60)），但**没有**“用户点选元素 / 高亮 / 选择器生成”。`highlight|picker` 在 `electron/browser/` 零命中。
- 覆盖层可行性有实证：接管卡 `.browser-takeover` 绝对定位在面板底部、盖在 webview 之上（[side-browser.css](../../src/features/browser/side-browser.css#L389-L409)），标签页菜单同样浮在舞台上（[L136-L145](../../src/features/browser/side-browser.css#L136-L145)）。

### 2.5 硬约束（决定技术选型）

1. **webview 不能用 preload。** [main.cjs](../../electron/main.cjs#L620-L627) 在 `will-attach-webview` 里 `delete preferences.preload`，并拒绝任何带 `preload` 的挂载。网页内选区/点选只能靠 **CDP 注入 + `Runtime.addBinding`** 回传。
2. **构建是 IIFE 单文件。** [scripts/build.mjs](../../scripts/build.mjs#L7-L16) 用 `lib + iife + 单 entry`，产出 `dist/app.js`（当前 2.6MB）。**动态 `import()` 分包不可用**，高亮库必须静态内联、不能用 worker（Monaco 出局）。
3. **没有现成高亮库**（`package-lock.json` 无 shiki/prism/highlight/codemirror），也**没有 DOMPurify**；Markdown 走 `react-markdown + remark-gfm`（[package.json](../../package.json#L57-L58)）。
4. **面板不是 React**，但项目有 React 19，可挂一个 React 岛渲染 Markdown，不必重写面板。

### 2.6 输入框、草稿与引用落点（关键）

- 输入框是 LeiBox 组件（[composer.js](../../src/features/composer/composer.js#L17-L106)），提交链路：组件 `submit(text, …)` → `options.onSubmit(message)`（[DeepAgentComposerEngine.js](../../vendor/leibox/DeepAgentComposerEngine.js#L184-L189)）→ [app.js](../../app.js#L2665) 的 `onSubmit: sendMessage` → `sendMessage()`（[app.js](../../app.js#L2411-L2440)）。
- 草稿真源在 [app.js](../../app.js#L233-L239) 的 `drafts` Map（按 `draftKey()` 分会话），`composer.update({ draft })` 同步（[L238](../../app.js#L238)、[L3128](../../app.js#L3128)）。草稿**只存在内存**，刷新即丢（与 README 一致）——引用 chip 可以沿用这个生命周期。
- 发送时 `content = text.trim()`（[L2415](../../app.js#L2415)）会同时用于：`turn.text`（[L2478](../../app.js#L2478)）、上下文历史（[L2506-L2524](../../app.js#L2506-L2524)）、自动记忆提取（[L2525-L2545](../../app.js#L2525-L2545)）。→ **引用合并进 `turn.text` 时要保证记忆提取只吃用户自己的话**。
- **用户气泡是纯文本渲染**：`<div className="user-message">{turn.text}</div>`（[chat-transcript.tsx](../../src/features/chat/chat-transcript.tsx#L370-L374)），不经过 Markdown。→ 引用**不能用 `>` 块语法**塞进去，否则会原样显示成 `>`；要改成可解析的行前缀 + 轻量渲染（§3.12）。

### 2.7 站点技能现状

- 存储：[procedures.cjs](../../electron/browser/procedures.cjs)：`save` / `find`（按 origin+路径模式+关键词打分）/ `saveFromTrace`（从 trace 生成步骤、按指纹去重、命中则累加成功数）/ `report` / `remove`。
- 自动沉淀已存在：[controller.cjs](../../electron/browser/controller.cjs#L480-L499) 在批量动作成功后，若 `prefs.skills.autoRecord !== false` 就 `saveFromTrace()`（`promptAtThreeSteps` 控制最少步数），并镜像一条记忆卡（[memory-mirror.cjs](../../electron/browser/memory-mirror.cjs)）。
- 模型已有一个工具 `browser_skill`（list / save / remove，[tools.cjs](../../electron/browser/tools.cjs#L358-L379)），`skillSave` 用 `target.trace` 生成步骤（[controller.cjs](../../electron/browser/controller.cjs#L509-L520)）。
- 设置项：[settings.cjs](../../electron/browser/settings.cjs#L44-L45) `skills.autoRecord=true`、`promptAtThreeSteps=true`；设置页有技能列表与站点卡片（[browser-settings.jsx](../../src/features/browser/browser-settings.jsx)）。
- 结论：**“AI 判断”不需要从零造**，需要的是把默认从“静默自动记录”改成“模型决定”，再把工具栏入口撤掉。

### 2.8 设计规范（本次遵守的具体值）

来自 [design/source/Mova设计规范.md](../../design/source/Mova设计规范.md)（与 [styles.css](../../styles.css#L1-L2) 一致）：

| 类别 | 值 |
| --- | --- |
| 表面 | canvas `#181818`、sidebar `#161616`、surface `#212121`、surface-raised `#2e2e2e`；面板 chrome 沿用现状 `#2b2b2b` |
| 文字 | `#d6d6d6` / 强 `#f3f3f3` / 弱 `#868686` |
| 边框 | `#2f2f2f`、raised `#393939` |
| 状态 | hover `#2d2d2d`、selected `#292929`、overlay-hover `#ffffff12`、focus `#5b9bf0`（2px）、danger `#e0928c`、info `#3795f5` |
| 圆角 | 行/菜单项 8、小浮层 12、输入胶囊 999（现状）、输入区 28 |
| 间距 | 4 / 8 / 12 / 16 / 24 |
| 字号 | 正文 14、菜单 12、辅助 11–12、代码 12.5 等宽 |
| 动效 | 150ms 颜色、160ms 菜单、200ms 面板/浮层、220ms 详情卡，`cubic-bezier(.22,.9,.26,1)`；`prefers-reduced-motion` 全部降级 |
| 命中区 | 工具栏 ≥ 24×24（现有 23px 按钮不缩小） |
| 浮层 | 1px 边框 + 阴影（菜单 `0 20px 44px #0008`，小卡 `0 12px 28px #0005`），距视口 10–12px |

新增的**代码语义色**（§3.6）属于内容层语义色，需要补进规范 §3.3（那里“成功/警告”仍标待设计）；界面 chrome 不新增色相。

### 2.9 之前规划里有什么、没什么

- [Mova浏览器MCP开发方案.md](Mova浏览器MCP开发方案.md) 已把面板定位成“浏览器 + Agent 操作面”，覆盖快照、站点技能、接管、审批、密码保险柜；[L160](Mova浏览器MCP开发方案.md#L160) 记录“已有地址栏、前进/后退/刷新、历史、拖拽调宽”，[L1134-L1154](Mova浏览器MCP开发方案.md#L1134-L1154) 规划了 `procedures.cjs` 与面板改造。
- 但**文件视图、面包屑、目录浏览、链接渲染分发、选区引用、元素点选、引用 chip** 都没有落地条目；[L620](Mova浏览器MCP开发方案.md#L620) 的“高亮”是给 Agent 动作看的 600ms 闪一下，不是给人选。→ 本方案是新增一块，复用它的 CDP / 接管 / 技能地基，不冲突。

---

## 3. 目标交互规格

### 3.1 链接如何进入右侧（路由表）

| 回复里的形态 | 判定 | 行为 |
| --- | --- | --- |
| `https://…` / `http://…`（含裸链接） | 现有白名单 | 右侧网页模式；面板未开先开；已开在当前标签导航（push 历史） |
| `mailto:` | 现有 | 系统邮件客户端，不进面板 |
| 相对路径 `src/app.js`、`./docs/x.md`、`a.md#L12` | 现有正则 | 右侧文件模式；`#L12` 作为行锚点（滚动 + 该行 200ms 高亮） |
| `[[file:src/app.tsx#L12]]` / 行内代码 `` `src/app.tsx:12` `` | 新增语法（`file-reference.js`） | 渲染成可点击引用，点击在右侧打开并定位到行；代码块内不转换 |
| 思考与操作里的搜索来源行 | 新增 | 桌面版点击在右侧面板打开该网页；浏览器预览保持新标签页 |
| 绝对路径 / 盘符 / `..` | 拒绝 | toast“只能打开已授权项目文件夹内的文件”，不静默失败 |
| 多根目录都能命中 | 新增 | 主进程按存在性返回候选，取第一个命中的根；都不命中提示“文件不在已授权文件夹内” |
| Windows 反斜杠路径 | 新增 | 统一转 `/` 后匹配 |

链接 `title="在右侧打开"`，文件 `title="在右侧查看"`。

### 3.2 顶部工具栏（逐控件行为矩阵）

| 控件 | 网页 | 文件 | 目录 | 无位置 |
| --- | --- | --- | --- | --- |
| 后退 | 先 `webview.canGoBack()`，到历史头再退到上一个位置 | 同左（位置栈） | 同左 | 禁用 |
| 前进 | 对称 | 对称 | 对称 | 禁用 |
| 刷新 | `webview.reload()` | 重新读取并重渲染 | 重新列目录 | 禁用 |
| 选择（原闪电） | 进入元素选择（§3.11） | 置灰，`title="仅网页可选取元素"` | 置灰 | 置灰 |
| 地址栏 | URL 输入（现状） | 面包屑（§3.3） | 面包屑 + 条目数 | 占位文案 |
| 箭头 | 系统浏览器打开 | 资源管理器选中文件 | 资源管理器打开目录 | 禁用 |
| 三个点 | 标签页菜单（现状，去掉技能项） | 当前文件夹条目（不含标签页） | 同文件 | 标签页菜单 |

图标、按钮尺寸（23px）、导航组胶囊、5px 间距、43px 工具条**保持原值**；只把闪电换成 `ph-cursor-click`（Phosphor 已内置），补 `aria-label="选择页面元素"` 与 `aria-pressed`。

### 3.3 地址栏 = 位置栏 + 面包屑

三种稳定态（都在原胶囊内，26px 高、11px 字、`#2b2b2b` 底）：

1. **网页**：保持现状（地球 + URL）。
2. **文件**：`[类型图标] 项目名 › src › app.js`。除最后一段外每段是按钮（hover 下划线 + `#ffffff12` 底、圆角 6、内边距 2×4）；最后一段纯文本，`aria-current="page"`。点上级段 → 目录模式（§3.7）。空间不足**从左侧折叠**：最左变 `…`（点击弹出被折叠的段），根名始终保留。
3. **目录**：`[文件夹图标] 项目名 › src` + 尾部弱化 `12 项`。

编辑态：点空白/回车进入编辑（内容为相对路径、全选），`Enter` 打开、`Esc` 还原；沿用现有表单提交逻辑（[side-browser.js](../../src/features/browser/side-browser.js#L698-L710)）并补越界提示。类型图标随位置切换（网页=地球、文件=`ph-file`、目录=`ph-folder`）——唯一新增的小变化。

### 3.4 渲染分发表

> 统一入口 `renderLocation(loc)`；用递增 `requestId` 丢弃过期结果；同一文件 5 分钟内命中内存缓存（会话级，不落盘）。

| 类型 | 判定 | 渲染器 | 关键规则 |
| --- | --- | --- | --- |
| Markdown | `.md .mdx .markdown` | `MarkdownView`（复用 `MarkdownContent`） | GFM、表格、任务列表、代码块同一套高亮；标题锚点；相对链接/图片按当前文件目录解析；**不执行原始 HTML、不加载远程图片** |
| 代码 | `.js .jsx .ts .tsx .mjs .cjs .json .jsonc .css .scss .less .html .htm .vue .svelte .py .rs .go .java .kt .c .h .cpp .hpp .cs .rb .php .sh .ps1 .bat .yml .yaml .toml .ini .sql .xml` | `CodeView` | Shiki 高亮 + 行号 + 换行开关 + 复制 + 语言标识；未内置语言退回纯文本 |
| 纯文本 | `.txt .log .env .gitignore .editorconfig` 或无语义扩展名且可解码 | `TextView` | 等宽、可换行、可选行号 |
| 图片 | `.png .jpg .jpeg .gif .webp .bmp .ico .avif .svg` | `ImageView` | blob URL；`object-fit: contain`，点击切换 1:1/适应；SVG 用 `<img>`（脚本不执行） |
| PDF | `.pdf` | `PdfView` | 主进程 `mova-pdf:` 协议流式读取（≤20MB），Chromium 内置阅读器隐藏工具栏、`view=FitH` 宽度自适应、可上下滚动 |
| HTML | `.html .htm` | `CodeView`（源码） | 默认不执行；不做实时预览 |
| 二进制 | 其他 | `BinaryView` | 类型、大小、前 2KB 十六进制 + “在资源管理器中显示” |
| 过大文本 | > 1.5MB 或 > 20k 行 | `CodeView`/`TextView` | 只渲染前 1MB / 前 5000 行，顶部“已截断”条 + 打开资源管理器 |
| 读取失败 | 权限/不存在/编码 | `ErrorState` | 具体原因 + 重试 + 可用的“在资源管理器中显示” |

### 3.5 Markdown 渲染细则

- 复用 [markdown-renderer.js](../../src/features/chat/markdown-renderer.js) 的组件表，通过 props 注入 `resolveLink` / `resolveImage` / `onOpenLink`；**不复制新渲染器**，避免两套排版漂移。
- 排版：内容列 `max-width:760px`、左右 18px、正文 14px/1.75；标题层级沿用 `markdown.css`；代码块同一套高亮；表格横向滚动（已有 `.markdown-table-scroll`）；引用块左侧 3px `#3f3f3f`。
- 安全：`skipHtml`、`urlTransform` 只放行 `http(s)/mailto` + 站内相对路径；图片只允许根内文件（主进程校验 + 8MB 上限）；链接点击走 §3.1 路由。
- TOC：右侧面板最窄 320px，**不做常驻侧栏**；P2 用顶部“跳到标题”下拉。

### 3.6 代码渲染细则（Shiki）

- 依赖与加载方式（受 IIFE 约束）：
  - `shiki/core` + `shiki/engine/javascript`（**JS 正则引擎，无 WASM**）；
  - 语言用 `shiki/langs/*.mjs` **静态 import**，一次 `createHighlighterCoreSync({ langs, themes, engine })`；
  - 首批语言 16 个：`js ts jsx tsx json css scss html md py rs go java c cpp sh yml sql xml`；若构建增量 > 2MB，砍到 12 个（保留 `ts/tsx/jsx/json/css/html/md/py`），其余纯文本并提示“该语言未内置高亮”。
  - 体积预算：目标 **+1.2MB 以内**；构建脚本加一条体积断言（超过阈值 `console.warn`，不阻断）。
- 渲染方式：`codeToTokens()` 得到每行 token 数组 → **创建 `<span>` 节点**，`style.color = token.color`、`fontStyle`；**禁用 `codeToHtml` + innerHTML**（避免把 HTML 字符串塞进 DOM）。
- 行号：固定 40px、右对齐、`#6f6f6f`、`user-select:none`；正文 `12.5px/1.7` 等宽（`Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace`）。
- 行锚点：`#L12` → 滚到可视区 + `background:#ffffff0d` 200ms 淡出。
- 交互：复制全文（沿用聊天代码块按钮的状态机）、换行开关、语言标识（只读）；超长文件顶部固定“已截断”条 + “重新高亮前 5000 行”提示。
- **关键字配色**（新增语义 token，需补进设计规范 §3.3；取值实现时用脚本校验 `#181818` 上 ≥ 4.5:1）：

| token | 建议值 | 覆盖 |
| --- | --- | --- |
| `--code-keyword` | `#7fa7e8` | `if/return/const/import/class/async…` |
| `--code-string` | `#a8c98a` | 字符串、模板串、字符 |
| `--code-number` | `#d8b06a` | 数字、布尔、`null` |
| `--code-function` | `#c9b6f2` | 函数/方法名、调用 |
| `--code-type` | `#72c7c2` | 类型、类名、注解 |
| `--code-tag` | `#e0a08c` | HTML/JSX 标签、选择器 |
| `--code-attr` | `#d3b6f0` | 属性、键名 |
| `--code-comment` | `#7f8a86`（斜体） | 注释、文档注释 |
| `--code-punct` | `#9a9a9a` | 运算符、标点 |
| `--code-regex` | `#d7a06a` | 正则、转义 |

### 3.7 目录视图（列表行）

- 行结构（32px 高、圆角 8、hover `#ffffff0d`、focus 2px `#5b9bf0`）：`16px 图标 | 名称（单行省略，hover 显示全名） | 右侧弱化“大小 · 修改时间”`。
- 排序：目录在前 → `localeCompare('zh')`；（P2 支持按大小/时间并记住选择）。
- 行为：单击选中；双击/Enter 打开（目录进入下一级并 push 历史，文件切渲染）；`Backspace` 回上一级；↑/↓ 移动、Home/End 首尾；右键菜单 P2（资源管理器显示、复制路径）。
- 面包屑就在地址栏（§3.3），**不新增工具条**。
- 状态：加载（6 行骨架，不用无限 spinner）、空目录（“这个文件夹是空的”）、无权限（“没有读取权限”）、条目 > 1000（“仅显示前 1000 项”）、符号链接跳过（底部注明“已跳过 N 个”）。
- 隐藏项：**只隐藏 `.git`**；`node_modules` 正常显示（懒加载，点进去才列）。

### 3.8 选区引用（聊天区）

- 触发：聊天滚动区 `mouseup` / `selectionchange`（去抖 120ms）；选区非空、长度 ≥ 2、且不在输入框/按钮/代码复制按钮里 → 显示浮层；清空或点击别处隐藏；滚动/resize 隐藏。
- 浮层（选区末行上方 6px，空间不足翻到下方；左右夹在视口 10px 内）：
  - 结构：**只有「引用文本」四个字**（28px 高、宽度随内容、无摘要、无图标），贴在选区**上沿** 2px 处，鼠标向上一滑就能点中；`aria-label="引用文本"`。
  - 视觉：`#212121` 底、1px `#393939`、圆角 12、阴影 `0 12px 28px #0005`、12px 字；按钮 26px 高、圆角 8、hover `#2d2d2d`、focus 环 2px；160ms `cubic-bezier(.22,.9,.26,1)` 位移 4px + 淡入。
- 点击后：生成引用 chip（§3.12）→ 输入框聚焦 → toast“已引用到对话”；浮层消失，选区保留（便于再次引用同一段）。
- 键盘：浮层出现后按钮可 `Tab` 到达（不抢焦点）；`Esc` 关闭。
- 作用范围：只在 ChatMova / CodeMova 的对话区生效；MovaBot 会话（`activeArea === 'messages'`）不显示浮层（P3 再评估，避免与 Bot 纯文本消息的引用语义混淆）。

### 3.9 选区引用（右侧文件视图）

- 同一套浮层组件，作用域换成 `.browser-viewport` 内我们自己的 DOM（Markdown/代码/文本）。
- 代码视图：摘要带“第 N 行”，chip 的来源写成 `src/app.js:42`。
- 浮层挂 `.browser-stage`（z 24，高于 frame 的 1、低于菜单 30），坐标相对面板计算，避免被 `overflow:hidden` 裁掉。

### 3.10 选区引用（网页 webview）

- 网页选区宿主拿不到（webview 无 preload），走 CDP 注入 + binding（§4.5）。
- 交互同 §3.8，摘要带域名；chip 来源带 URL。
- 不干扰页面：不阻止默认复制、不改选区、不动光标；浮层在宿主，页面滚动时立即隐藏。
- 兜底：注入失败（DevTools 占用 / 页面异常）→ 顶部提示“此页面不支持直接引用选区，可改用选择元素”，不静默失败。

### 3.11 元素选择（原闪电图标）

- 进入：点“选择”按钮 → 按下态（底 `#3a3a3a`、图标 `#fff`、`aria-pressed="true"`），舞台顶部浮出提示条（`#242424` 底、1px `#3b3b3b`、圆角 999、13px 字）：“点击页面上的元素引用到对话 · Esc 退出” + “退出”按钮。
- 页内：`cursor:crosshair`（仅选择期间）；悬停元素画 2px `#5b9bf0` 描边 + 左上角小标签（`button · 立即购买`，深底白字 11px、圆角 4），标签自动避让视口边缘，滚动跟随。
- 点击：`preventDefault + stopPropagation`（不跳转、不提交），退出选择态，宿主浮层出现在元素矩形旁（宽 `min(320px, 面板宽-20px)`）：
  - 第一行 `<button> · 立即购买`；第二行选择器 `#buy`（等宽、弱化、单行省略，`title` 全量）；第三行来源 `example.com/checkout`；
  - 操作：主按钮「引用到对话」+ 次按钮「取消」。
- 退出：`Esc`、点“退出”、导航/刷新、面板关闭、切标签。
- 采集：`tagName`、`id/class`、`role`、`aria-label`、可见文本（≤280 字、压缩空白）、稳定选择器（优先 `#id`；否则 `tag:nth-of-type(n)` 向上收敛，≤6 层 / ≤200 字符）、`url/title`、`rect`。
- 不采集：`input.value`（尤其 password）、跨域 iframe 内部（跳过并提示）。

### 3.12 引用 chip：生成、展示、发送

**数据结构（内存，随草稿生命周期）**

```js
draft.quotes = [{ id, text, source: { kind, label, rootId?, path?, line?, url?, selector?, tag? }, at }]
```

- 每个会话草稿独立（`drafts` Map 按 `draftKey()`）；刷新即丢，与草稿文本一致（不新增持久化）。
- 同一草稿最多 5 条；超过 toast“一次最多引用 5 段”。
- 去重：`text + source.kind + label` 相同 → 不重复添加，toast“这段已经引用过了”。

**展示（输入框上方）**

- 新增 `.quote-chip-row`，插在 `.composer-area` 内、`#composer` 之前（`approval-host` → `composer-context` → `quote-chip-row` → `#composer`）；空时 `hidden`。
- 单行横向滚动：chip 高 24、圆角 999、内边距 0 8px、`#2b2b2b` 底、1px `#3f3f3f`、11px 字 `#c9c9c9`、图标 12px、关闭 16px 命中区；hover 底 `#333`、关闭变 `#fff`；focus 环 2px `#5b9bf0`。
- 文案：`助手回复 · 这段文字…` / `src/app.js:42 · const x…` / `example.com · 页面文字…` / `button · 立即购买`；`title` 显示全文（≤300 字）。
- 交互：点 chip 主体 → 跳到来源（P2：聊天滚动到消息 / 文件定位到行 / 网页打开 URL）；点关闭 → 移除（120ms 淡出）；`Delete`/`Backspace` 在 chip 聚焦时移除。
- 无障碍：行 `role="list"`、chip `role="listitem"`、关闭按钮 `aria-label="移除引用：…"`。

**发送**

- `onSubmit` 改为包装函数：`sendMessage({ ...message, quotes: takeQuotes() })`（[app.js](../../app.js#L2665)）。
- `sendMessage` 内部：
  - `content = text.trim()`：用户自己打的字（用于记忆提取、空消息判定）；
  - `merged = renderQuotes(quotes) + content`：**写进 `turn.text`、上下文历史、60k 预算检查**；
  - 记忆提取只传 `content`（避免把引用内容写成“用户事实”）；
  - 发送后清空 `draft.quotes` 并刷新 chip 行；`renderQuotes()` 结果不再重复插入。
- **格式**（纯文本行，不用 Markdown `>`，因为用户气泡不渲染 Markdown）：

```
[引用 · 助手回复] 选中的文字……
[引用 · 文件 src/app.js:42] const x = 1……
[引用 · 网页 example.com] 页面上的这段文字……

我自己输入的问题
```

- 单段 ≤ 1000 字，超出 `……（已截断，原 1234 字）`；多条各占一行，行间不空行；与正文之间空一行。
- 解析规则：`^\[引用 · ([^\]]{1,40})\] ?(.+)$`，只认消息开头连续的行，最多 5 行；不匹配就整段按原文显示。
- 60,000 字符安全预算按**合并后**的文本检查（引用也算用户消息）。
- **渲染**：`chat-transcript.tsx` 新增 `UserMessageText`，把开头的 `[引用 · …]` 行解析成 `.user-quote` 块（左侧 2px `#3f3f3f`、12px、`#a8a8a8`、最多 3 行省略），正文在下方；解析失败整段按原文显示。**不改数据结构**，刷新后仍可见。
- 复制按钮仍复制完整文本（含引用行）；重试不重复合并（`turn.text` 已含引用，retry 不传 quotes）。

### 3.13 站点技能：撤掉入口，AI 判断

- **撤掉**：工具栏 `[data-skills]` 按钮、`.browser-skills` 浮层（[side-browser.js](../../src/features/browser/side-browser.js#L33-L38)、[L551-L620](../../src/features/browser/side-browser.js#L551-L620)）与三个点菜单里的技能项。
- **改为模型判断**：
  - 设置项从 `autoRecord + promptAtThreeSteps` 改为 `skills.mode`：`model`（默认）/ `always` / `off`；
  - `model`：批量动作成功后**不静默保存**，只在结果里附带 `skillCandidate`（≥3 步、http(s)、指纹未存在）：`{ origin, pathPattern, title, stepCount }`；提示词要求模型“这是一次可复用的多步流程、且用户没说只做一次”时调用 `browser_skill({ action:'save', title, intent })`；
  - `always`：保留现有静默 `saveFromTrace` 行为（老用户可切回）；
  - `off`：不产生候选，`save` 返回明确错误，模型不得声称已保存。
- **保留**：设置页“站点技能”列表（查看步骤数/成功率、删除）、清空站点卡片；`browser.skill:list/save/remove` IPC 只服务设置页与模型工具。
- **记忆镜像**：保存后仍写一条 `[站点技能] origin/path · title` 索引卡（[memory-mirror.cjs](../../electron/browser/memory-mirror.cjs)），让 `memory_search` 能召回。
- 失败与门槛：`steps < 3` 不产生候选；去重按指纹；保存失败只记日志，不打断主任务。

---

## 4. 技术方案

### 4.1 模块划分

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/features/browser/location.js` | 新增 | 位置模型 `{kind:'web'|'file'|'dir', …}`、每标签位置栈、面包屑分段、显示标签、类型图标 |
| `src/features/browser/viewer/viewer.js` | 新增 | 渲染分发 + 竞态 + 缓存 + 加载/错误态 |
| `src/features/browser/viewer/markdown-view.js` | 新增 | React 岛，挂 `MarkdownContent`，注入 `resolveLink/resolveImage` |
| `src/features/browser/viewer/code-view.js` | 新增 | Shiki token→DOM、行号、换行、复制、行锚点 |
| `src/features/browser/viewer/{text,image,pdf,binary}-view.js` | 新增 | 其余类型 |
| `src/features/browser/file-explorer.js` | 新增 | 目录列表、键盘、状态机 |
| `src/features/browser/address.js` | 新增 | 面包屑渲染/折叠/编辑态 |
| `src/features/browser/quote.js` | 新增 | 宿主浮层（选区/元素共用）、定位/关闭策略、派发 `mova:quote-to-chat` |
| `src/features/browser/web-inspect.js` | 新增 | CDP 桥：开始/停止选择、接收上报、坐标换算 |
| `src/features/chat/quote-source.js` | 新增 | 聊天区选区采集与来源识别 |
| `src/features/chat/quote-chips.js` | 新增 | 输入框上方 chip 行：渲染、删除、去重、上限 |
| `src/features/chat/chat-transcript.tsx` | 改造 | `UserMessageText` 解析引用行并轻量渲染 |
| `src/features/browser/side-browser.js` | 改造 | 接 location/viewer/address/quote；撤掉技能浮层；标签/工作区/登录/接管/拖拽保留 |
| `src/features/browser/side-browser.css` + `viewer.css` | 改造/新增 | 浮层、目录行、代码、面包屑、chip；**不改现有工具条数值** |
| `electron/files-view.cjs` | 新增 | `list/stat/read` + 护栏 + 上限 |
| `electron/browser/inspect.cjs` | 新增 | 注入脚本、binding、nonce、事件归一化 |
| `electron/browser/controller.cjs` | 改造 | `inspect.start/stop`；`batch` 的 `skillCandidate`；`skillSave` 门槛 |
| `electron/browser/tools.cjs` | 改造 | `browser_skill` 描述/提示词；候选结果透传 |
| `electron/browser/settings.cjs` | 改造 | `skills.mode` 校验与迁移（旧 `autoRecord` 映射） |
| `electron/preload.cjs` / `main.cjs` | 改造 | `files.view.*`、`files:open-dir`、`browser:inspect`；`senderWindow` 校验 |
| `app.js` | 改造 | `sendMessage` 合并引用；`mova:quote-to-chat` 处理器；`onSubmit` 包装 |
| `src/features/browser/browser-settings.jsx` | 改造 | 技能区改为“模式 + 列表 + 清空”，去掉“≥3 步提示保存” |

> 不迁 React：重写面板风险远大于收益；React 只作为 Markdown 渲染岛。

### 4.2 主进程 IPC 契约

```js
// files:view:list
{ rootId, path } ->
{ ok: true, value: { path, entries: [{ name, type:'file'|'dir', size, mtime, hidden? }],
  truncated, skippedLinks, total } }
// files:view:stat
{ rootId, path } -> { type, size, mtime, ext, mime, kind }
// files:view:read
{ rootId, path, maxBytes? = 1_500_000 } ->
{ kind:'text'|'image'|'pdf'|'binary', mime, encoding?, text?, base64?,
  bytes, truncated, lines? }
// files:open-dir  { rootId, path } -> { ok }
// browser:inspect:event  (主→渲染) { type:'selection'|'element'|'exit', nonce, … }
// browser:inspect:start  { tabId? }  / browser:inspect:stop
```

约束：
- 先 `permissions.get(rootId)` + `capabilities.read`，再 `resolveInside(root.path, path)`；`path` 不接受绝对路径/盘符/`..`/ADS/设备名（沿用 [permissions.cjs](../../electron/permissions.cjs)）。
- 列表：不跟随符号链接；单目录失败只影响该目录；上限 1000（`truncated`）；默认隐藏 `.git`。
- 读取：文本按字节上限读数 → UTF-8 严格解码失败后 `TextDecoder('gbk')` 兜底并返回 `encoding`（Node 自带 full-ICU，无需新依赖）；二进制只回前 2KB 十六进制；图片/PDF base64（单文件 ≤ 20MB，与现状一致）。
- `files:open-dir` 用 `shell.openPath`；文件定位继续用 `changes:reveal`。
- 旧 `preview:file` 保留一个版本用于回退，新渲染器不再调用。

### 4.3 位置模型

```js
tab.locations = [{ kind:'web', url }, { kind:'file', rootId, path }, { kind:'dir', rootId, path }]
tab.cursor = 1
breadcrumb(loc) -> [{ label:'项目名', loc:{kind:'dir',rootId,path:''} }, …, { label:'app.js', loc }]
```

- 链接打开、地址栏提交、三个点、目录双击、面包屑点击**全部**只产生 `loc`，由同一处 `push + render` 处理，避免多套导航逻辑。
- 刷新 = 对当前 `loc` 重新 `render`（网页仍 `reload()`）。

### 4.4 渲染管线（异步与竞态）

```
地址变化 → requestId++ → 骨架 → IPC 读取
  → requestId 过期：丢弃
  → 成功：先建新节点再替换旧节点（避免闪白）
  → 失败：ErrorState（保留面包屑，可重试）
```

- 卸载时撤销 blob URL、断开 React 根、清高亮缓存。
- 缓存：`Map<rootId:path:mtime, {kind,text}>`，最多 8 条 / 8MB；命中秒开。

### 4.5 网页内注入（选区 + 元素选择）

1. 复用已附着的 `createCdp` → `Runtime.addBinding({ name:'__movaInspect' })`（每 guest 一次）。
2. `Page.addScriptToEvaluateOnNewDocument({ source: INJECT_SRC, runImmediately: true })`：IIFE、幂等，只做三件事——监听选区变化、维护元素高亮层（shadow DOM、`pointer-events:none`）、选择模式下捕获 click；所有上报带**本轮随机 nonce**。
3. 主进程监听 `Runtime.bindingCalled`，校验 `name`、`payload.nonce === sessionNonce`、`payload.type ∈ {selection, element, exit}`，再经 controller 发 `browser:inspect:event`。
4. 渲染层 `web-inspect.js` 用 `webview.getBoundingClientRect() + rect` 换算宿主坐标 → `quote.js` 定位浮层；面板滚动/缩放/窗口变化**立即隐藏**。
5. 停止：`Runtime.evaluate` 调 `window.__movaInspect.stop()`；`did-navigate` 时清状态并退出选择。
6. 安全：nonce 只在内存；上报长度全截断；只读 DOM 属性，不执行页面内容；不采集密码框值；iframe 内不采。

### 4.6 浮层定位（共用）

```js
function place(popover, anchorRect /* 视口坐标 */, bounds /* 面板或窗口 */) {
  // 默认上方 6px；上方不够翻下方；左右夹在 bounds 内 10px；写 left/top（fixed/absolute）
}
```

- 聊天区：`bounds = 窗口`，`position:fixed` 挂顶层容器，避免被聊天滚动容器裁切（规范 §12）。
- 右侧：`bounds = 面板`，`position:absolute` 挂 `.browser-stage`（z 24）。

### 4.7 引用 chip 生命周期

```
选区/元素浮层「引用到对话」
  → dispatch 'mova:quote-to-chat' { text, source }
  → app.js: addQuote() → drafts.get(draftKey()).quotes.push()
  → quote-chips.render() → composer 聚焦
  → 发送：onSubmit 包装 → sendMessage({ text, quotes })
      → merged = renderQuotes(quotes) + content → turn.text / history / 预算
      → 记忆提取只用 content
      → quotes 清空，chip 行隐藏
```

- 切换会话：chip 行按 `draftKey()` 重绘；草稿未持久化，刷新丢失（与文本一致）。
- 聊天区、文件视图、网页视图三处共用同一个事件与同一个 chip 仓库。

### 4.8 站点技能自动沉淀

- `settings.skills.mode`：
  - `model`（默认）：`batch()` 成功后计算候选（`stepsFromTrace` ≥3、origin、指纹不存在）→ 结果附 `skillCandidate`；不落盘。
  - `always`：现有 `saveFromTrace` 静默保存（保留，向后兼容）。
  - `off`：不产生候选；`skillSave` 抛 `skills-disabled`。
- 旧配置迁移：`autoRecord` 默认就是 `true`，**不能**把它映射成 `always`（否则老用户和新默认都会退回静默记录）；只有显式 `autoRecord:false` 映射为 `off`，其余一律落到 `model`。`promptAtThreeSteps` 删除。
- 工具与提示：`browser_skill` 描述改为“当一次多步流程可复用时保存；用户明确只做一次、或流程只对当前数据有效时不要保存”，`save` 返回 `{ id, title, steps }` 供模型在回复里说明。
- 防滥用：按指纹去重；`title` 必填且 ≤80 字；`steps` 上限 30；保存失败只记日志。
- 设置页保留：模式三档、技能列表（标题/站点/步数/成功率/删除）、清空站点卡片。

### 4.9 安全与权限

| 威胁 | 对策 |
| --- | --- |
| 渲染层传绝对路径读盘 | 只收 `rootId + 相对路径`，`resolveInside` 拒绝绝对路径/`..`/盘符/UNC/ADS/设备名 |
| 越权读未授权文件夹 | 每次调用重新 `permissions.get`，未授予 `read` 直接拒绝 |
| Markdown XSS | `skipHtml` + 协议白名单 + 不用 `innerHTML`；高亮 token→DOM |
| Markdown 远程图片泄露 | 只解析根内文件；远程图片只显示 alt |
| HTML 文件执行脚本 | 只显示源码，不执行 |
| 大文件 | 20MB/1.5MB 双上限、blob 释放 |
| 恶意页面伪造引用上报 | nonce + 类型白名单 + 长度截断 + 面板可见时才接受 |
| 元素选择采集敏感值 | 不读 `input.value`，只读文本与属性白名单 |
| 技能被模型过度保存 | 候选门槛 + 指纹去重 + 设置页可删 + `off` 开关 |

### 4.10 性能预算

| 项 | 预算 |
| --- | --- |
| 面板打开到首帧 | ≤ 200ms（不含网页加载） |
| 切换文件到内容可见（≤200KB） | ≤ 120ms |
| Shiki 2000 行 | ≤ 200ms（首次建 highlighter ≤ 80ms，之后复用） |
| 内存（文件缓存） | ≤ 8MB / 8 条 |
| 打包增量 | 目标 ≤ +1.5MB（Shiki 语言包按 §3.6 裁剪） |

---

## 5. 设计规范落地清单

- 颜色只用 §2.8 的表面/文字/边框/状态值；代码语义色按 §3.6 单独成组，先补规范再实现。
- 尺寸：工具条 43 / 按钮 23 / 地址 26 / 导航组胶囊 / 三点不变；浮层圆角 12、目录行 8、chip 999、按钮 8。
- 浮层：1px `#393939` 边框 + 阴影；距边缘 ≥10px；不遮触发元素；`Esc` 关闭。
- 动效：150ms 颜色、160ms 菜单、200ms 面板；`prefers-reduced-motion` 取消位移与淡入（范式见 [side-browser.css](../../src/features/browser/side-browser.css#L321-L324)）。
- 无障碍：图标按钮全 `aria-label`；面包屑 `<nav aria-label="当前位置">` + `aria-current="page"`；目录行 `role="listitem"` + 焦点管理；chip 行 `role="list"`；浮层 `role="group"` + `aria-label="引用"`；焦点环 2px `#5b9bf0`。
- 文案：路径/文件名不做大小写变换；空态/错误说清“为什么 + 下一步”。
- 窄宽：320px 下面包屑折叠、浮层 `max-width: calc(100% - 20px)`、目录行元信息在 <360px 时隐藏、chip 行横向滚动。

---

## 6. 分期计划

### P0 位置与渲染（约 2 人日）

1. `electron/files-view.cjs` + IPC + 单测（路径护栏、上限、排序、符号链接）。
2. `location.js` + `address.js`：面包屑三态、编辑态、历史栈。
3. `viewer/`：Markdown、Shiki 代码、文本、图片、PDF、二进制。
4. `file-explorer.js`：列表 + 键盘 + 状态。
5. `files:open-dir`；三个点按位置切换（文件/目录模式接目录条目）。
6. 设计走查：320 / 1280 / reduced-motion。

**DoD**：从对话点开 `README.md`、`src/app/main.tsx`、`docs/x.png`、`x.pdf` 都能正确渲染；面包屑点上一级进目录并能打开文件；箭头能在资源管理器定位；工具条像素级不变。

### P1 引用 chip（约 2.5 人日）

1. `quote.js` 浮层 + 定位 + 关闭策略。
2. 聊天区选区采集（`quote-source.js`）+ 文件视图选区。
3. `quote-chips.js`：渲染、去重、上限、删除、来源跳转（P2）。
4. `app.js`：`addQuote`、`onSubmit` 包装、`sendMessage` 合并、记忆提取只用正文。
5. `chat-transcript.tsx`：`UserMessageText` 解析引用行并轻量渲染。
6. 单测：格式、去重、截断、合并、重试不重复；手测三处入口 + 临时聊天。

**DoD**：聊天/Markdown/代码三处选区都能生成 chip；发送后消息里可见引用块；刷新后仍在；记忆提取不含引用内容。

### P2 网页选择与技能改造（约 2.5 人日）

1. `inspect.cjs`：注入脚本、binding、nonce、生命周期。
2. controller / preload / IPC：`inspect.start/stop`、事件转发。
3. 选择模式 UI（按钮态、提示条、描边标签）。
4. webview 选区上报 → 宿主浮层 → 坐标换算与隐藏策略。
5. 元素采集（选择器生成、敏感字段排除、iframe 跳过）。
6. 技能：撤掉工具栏/浮层；`skills.mode` + `skillCandidate` + 提示词；设置页改为“模式 + 列表 + 清空”。

**DoD**：任意 http(s) 页面能选元素与文字并生成 chip；`Esc`/导航能退出；不影响页面交互；DevTools 占用时给明确提示；工具栏无技能入口；一次 3 步以上成功流程后模型能自主保存（或说明不保存），设置页能看到/删除。

### P3 打磨（约 1 人日）

- 目录虚拟滚动（>500 条实测）、排序、右键菜单。
- 代码跳行、Markdown TOC、图片缩放、错误态细化。
- 全量无障碍与 reduced-motion 走查、`design/qa/` 截图留档、README 更新。

---

## 7. 测试与验收

**自动**

- `tests/files-view.test.mjs`：`resolveInside` 越界、符号链接、条目上限、排序、二进制识别、GBK 兜底。
- `tests/quote.test.mjs`：chip 去重/上限、`renderQuotes` 格式、1000 字截断、合并后预算、重试不重复、`UserMessageText` 解析引用行。
- `tests/inspect-script.test.mjs`：选择器生成（id 优先、nth-of-type 收敛、6 层上限）、摘要清洗、nonce 校验、密码框排除。
- `tests/skills-mode.test.mjs`：`model` 产生候选但不落盘、`always` 落盘、`off` 拒绝、指纹去重、设置迁移。
- `tests/ui-contract.test.mjs` 增补：工具条 DOM 顺序与图标未变、chip 行 aria、面包屑 aria、目录行 role。
- `npm run typecheck` / `npm run lint` / `npm test` / `npm run build`（CI 四连）。

**手动（每次迭代）**

1. 链接：http、裸链接、相对路径、`#L12`、多根目录、越界路径。
2. 渲染：md（表格/任务/代码块/图片/相对链接）、tsx、json、css、py、未知扩展名、空文件、1.5MB+、二进制、PDF、svg。
3. 目录：空目录、无权限、1000+ 条、`node_modules`、符号链接、中文名、超长名。
4. 引用：聊天区、md、代码（含行号）、网页选区、元素（含 iframe、输入框、密码框）；chip 删除/上限/去重；发送后刷新仍在。
5. 技能：3 步流程后模型是否保存、设置页列表、`off` 模式下模型不误报。
6. 回归：接管卡、登录浮层、标签页菜单、站点卡片仍可用。

**截图留档**：`design/qa/` 新增 `viewer-*`、`quote-*`、`picker-*` 三组，沿用现有 CDP 截图脚本。

---

## 8. 风险与回退

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Shiki 体积（IIFE 单文件） | 首屏变慢 | 按 §3.6 裁剪语言；首次打开代码文件才建 highlighter；构建加体积告警 |
| webview 盖住宿主浮层（Electron 版本差异） | 浮层不可见 | 先用最小 demo 验证（接管卡是正例）；失败退化为面板底部固定引用条 |
| CDP 被 DevTools / Agent 占用 | 元素选择不可用 | 复用单实例 `createCdp`；attach 失败提示“请先关闭开发者工具” |
| 页面 CSP / Trusted Types | 选区无法上报 | `Runtime.evaluate` 不受 CSP 限制；仍失败提示并保留元素选择兜底 |
| chip 行挤压输入区 | 布局跳动 | chip 行固定 30px、横向滚动、最多 5 条；窄屏隐藏来源前缀 |
| 引用合并错位（重试/编辑） | 重复引用 | `turn.text` 已含引用则 retry 不再合并；单测覆盖 |
| 模型过度保存技能 | 技能列表变垃圾 | 候选门槛 + 指纹去重 + 设置页删除 + `off` |
| 读取大文件卡顿 | UI 冻结 | 上限 + 截断 + 分批；后续可流式 |
| 多根目录同名文件 | 打开错文件 | 存在性校验 + 优先当前项目根 + 候选提示 |
| 两份设计规范不一致 | 实现跑偏 | 以 design/source 为准；实施时归档根目录版本 |

**回退开关**：`MOVA_VIEWER=legacy` 恢复旧 `preview:file` + `<pre>`；`skills.mode=always` 回到静默记录；`browser.inspect.enabled` 单独关闭网页选择。

---

## 9. 剩余默认（已按此执行，不同意再改）

| 项 | 默认 |
| --- | --- |
| 地址栏图标 | 随位置变化：网页地球、文件 `ph-file`、目录 `ph-folder` |
| `.html` 文件 | 只显示源码，不做实时预览 |
| Markdown 图片 | 只渲染项目内文件，远程图片显示 alt |
| 目录隐藏项 | 只隐藏 `.git`，`node_modules` 正常显示 |
| 面板架构 | 不重写 React，只挂 Markdown 渲染岛 |
| 代码视图 | 行号 + 换行开关 + 复制 + 行锚点；不做折叠/搜索（P3 视需要） |
| chip 来源跳转 | P2 实现：聊天滚到消息、文件定位到行、网页打开 URL |
| 引用上限 | 单次最多 5 条、每条 ≤1000 字 |

---

## 附录 A：关键接口草案

```ts
type Location =
  | { kind: 'web'; url: string }
  | { kind: 'file'; rootId: string; path: string; line?: number }
  | { kind: 'dir'; rootId: string; path: string };

type QuoteSource =
  | { kind: 'chat'; messageId?: string; label: '助手回复' }
  | { kind: 'file'; rootId: string; path: string; line?: number }
  | { kind: 'web'; url: string; label: string }
  | { kind: 'element'; url: string; tag: string; selector: string; label: string };

type QuoteChip = { id: string; text: string; source: QuoteSource; at: number };

// app.js
sendMessage({ text, attachments, quotes }: { quotes?: QuoteChip[] }): boolean;
renderQuotes(quotes: QuoteChip[]): string; // "[引用 · …] …\n" × n + "\n"
```

## 附录 B：改动文件索引

- 新增：`electron/files-view.cjs`、`electron/browser/inspect.cjs`、`src/features/browser/location.js`、`address.js`、`file-explorer.js`、`quote.js`、`web-inspect.js`、`viewer/*`、`viewer.css`、`src/features/chat/quote-source.js`、`quote-chips.js`。
- 修改：[side-browser.js](../../src/features/browser/side-browser.js)、[side-browser.css](../../src/features/browser/side-browser.css)、[chat-transcript.tsx](../../src/features/chat/chat-transcript.tsx)、[preload.cjs](../../electron/preload.cjs)、[main.cjs](../../electron/main.cjs)、[controller.cjs](../../electron/browser/controller.cjs)、[tools.cjs](../../electron/browser/tools.cjs)、[settings.cjs](../../electron/browser/settings.cjs)、[browser-settings.jsx](../../src/features/browser/browser-settings.jsx)、[app.js](../../app.js)、[package.json](../../package.json)、[README.md](../../README.md)。
- 测试：`tests/files-view.test.mjs`、`tests/quote.test.mjs`、`tests/inspect-script.test.mjs`、`tests/skills-mode.test.mjs`、`tests/ui-contract.test.mjs`。

---

## 10. 实施记录（v1.0，2026-11-12）

### 10.1 落地结果

| 模块 | 文件 | 状态 |
| --- | --- | --- |
| 文件 IPC | `electron/files-view.cjs`、`electron/viewer-ipc.cjs`、`electron/preload.cjs`、`main.cjs` 接线 | 完成；13 项单测；未知扩展名内容嗅探 |
| 浏览器注入 | `electron/browser/inspect.cjs`、`controller.cjs`（`inspectStart/Stop` + `skillCandidate`）、`settings.cjs`（`skills.mode`）、`tools.cjs` | 完成；16 项单测；导航自动复位 |
| 面板核心 | `location.js`、`address.js`、`file-explorer.js`、`viewer/*`、`side-browser.js`、`viewer.css` | 完成；13 项单测；IIFE 构建通过 |
| 引用 chip | `quote-source.js`、`quote-chips.js`、`quote.css`、`chat-transcript.tsx`、`app.js` | 完成；9 项单测；消息内引用行渲染 |
| 右侧引用/元素选择 | `quote.js`、`web-inspect.js`、`quote-position.js`、`side-browser.js` | 完成；14 项定位单测；宿主浮层 + 顶部提示条 |
| 设置页 | `browser-settings.jsx/.css` | 完成；`skills.mode` 三档 + 列表管理 |

### 10.2 与方案的偏差（均已验证）

- **Shiki 语言**：未内置 `cpp`（单体 534KB），`.cpp/.hpp` 用 C 语法；`.kt/.cs/.rb/.php/.ps1/.bat/.toml/.ini` 无语法 → 代码视图提示后按纯文本显示。实际 14 个语法、构建 +0.99MB（3.61MB）。
- **引用格式**：用户气泡不渲染 Markdown，最终采用 `[引用 · 来源] 内容` 纯文本行 + `UserMessageText` 轻量解析渲染；合并进 `turn.text`，不新增持久化字段。
- **技能列表**：设置页保留管理；面板入口与浮层删除；`promptAtThreeSteps` 删除，旧 `autoRecord:false → off`，其余 → `model`。
- **工具条第 4 钮**：`ph-cursor-click`；文件/目录模式置灰并提示“仅网页可选取元素”。
- **网页内滚动**：无法从宿主探测（webview 无 preload），目前用“指针回到页面 / 导航 / 宿主滚动 / resize”隐藏浮层；要精确跟随页面滚动需后端补 scroll 上报。
- **元素浮层按钮顺序**：取消在左、主按钮在右（设计规范的主操作靠右）。

### 10.3 验证证据

- `node --test`：908 项、903 通过；**2 项失败为既有问题**（`markdown-transcript` / `trace-rows`，源于当天 10:33 的 Activity 默认折叠改动，与本次无关）。
- `npx tsc --noEmit` 0；`npx eslint src electron app.js icons.js` 0 error（28 条既有 warning）。
- `npm run build` 通过；隔离 profile + CDP 冒烟（`qa/viewer-final.png`）：面板挂载、4 个导航按钮、技能入口已删、43px 工具条、URL 路由、选择按钮按下态 + 提示条、Esc 复位、引用 chip + toast 均正常。
- **主进程 IPC 冒烟（真实项目根，只读授权）**：`files.view.list` 返回 63 项（16 个目录，`.git` 已隐藏）；`README.md` → `kind:text`、257 行；`src/app/main.tsx` → `kind:code`；`THIRD_PARTY_NOTICES.md` → `markdown`；`../package.json` → `path-escape`；不存在文件 → `not-found`；`src` → `dir`。
- **文件视图 UI 冒烟**：`Mova › README.md` 面包屑；Markdown 渲染出 1 个 h1、2 张表、4 个代码块；目录视图 63 行（含大小/时间）；`src/app` 3 行 → 双击 `main.tsx` 进入代码视图（tsx、14 行、729 个带色 token）；面包屑点 `src` 回到 4 行目录。
- **引用冒烟**：文件视图选中代码行 → 浮层「第 1 行 · …」→ chip `文件 src/app/main.tsx:1`；网页选中正文 → 浮层 `example.com · …` → chip `网页 example.com`；元素选择（`h1`/`body`）→ 浮层 headline + `html > body` + `example.com` → chip；截图见 `qa/file-view-2.png`、`qa/clean-check.png`、`qa/pick-check.png`。
- **设置冒烟**：`browser.settings.set({skills:{mode}})` 三档往返正确，非法值回落 `model`。
- 文件/目录渲染与面包屑：纯函数单测覆盖；**像素级交互需在真实项目文件夹授权后手测**（隔离 profile 无法走原生授权对话框）。

### 10.4 已知遗留

- 文件视图的视觉/交互（面包屑折叠、目录双击、代码配色对比度）需要在真实项目里走查一遍。
- 引用 chip 点击跳回来源（聊天定位 / 文件行 / 网页 URL）未做（方案里的 P2）。
- 目录虚拟滚动、排序记忆、右键菜单、Markdown TOC、图片缩放未做（P3）。
- 网页内滚动跟随浮层（见 10.2）。

