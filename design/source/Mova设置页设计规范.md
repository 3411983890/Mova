# Mova 设置页设计规范

> 基线：2026-11-10 的「设置 → 配置」页实现（`source/index.html` 的 `.settings-view` + `source/styles.css` 的 Settings 段）。
> 参考图：[settings-reference.png](assets/settings-reference.png)（1440×900，1440 宽窗口下的实际渲染）。
> 本文所有数值均为**当前代码的实测值**（Chromium 渲染核对），后续所有设置页（配置、使用情况、模型、记忆与存储、服务与索引、已归档的聊天，以及新增页面）都以本文为准。与本文冲突的旧页面，按第 10 节清单逐项收敛。

---

## 1. 适用范围与基本原则

1. **一个设置视图，一个骨架**：左侧导航 + 右侧内容面板，不允许页面自建顶栏、自建第二级标签或自建滚动区。
2. **内容列固定**：右侧内容永远坐在同一条居中的内容列上（第 3 节），卡片不得铺满整个面板宽度。
3. **只用一套色阶**：背景、边框、文字只取第 4 节列出的档位，不新造近似灰；**强调色只有蓝色**，不出现绿/青/紫等色相背景。
4. **卡片即白名单**：卡片里只放「行」（row）。行内右侧只有一个控件槽；需要多控件时按 6.5 的排布规则处理。
5. **文字有边界**：行标题与说明在行宽的 **66%** 处换行（第 3.3 节），右侧留白给控件与备注。

---

## 2. 页面骨架

```
┌ window-shell ─────────────────────────────────────────────────────────────┐
│ titlebar（高度 var(--titlebar-height)）                                    │
├ activity-rail ┬ settings-view ────────────────────────────────────────────┤
│  (80 × --u)   │┌ settings-nav ──────┬ settings-panel ────────────────────┐│
│               ││ 设置（标题）        │ settings-panel-head              ││
│               ││ 搜索框             │   配置（h2）                     ││
│               ││ 个人（分组标签）    │ ┌ settings-page ───────────────┐ ││
│               ││ 配置 / 使用情况…    │ │ 权限（section-title）         │ ││
│               ││  …（导航项）        │ │ ┌ settings-card ────────────┐ │ ││
│               ││                    │ │ │ settings-row              │ │ ││
│               ││                    │ │ │ settings-row              │ │ ││
│               ││                    │ │ └───────────────────────────┘ │ ││
│               ││                    │ │ 常规（section-title）         │ ││
│               ││                    │ │ ┌ settings-card ─┐            │ ││
│               │└────────────────────┴─┴─┴───────────────┴────────────┴─┘││
└───────────────┴───────────────────────────────────────────────────────────┘
```

### 2.1 设置视图容器

| 项目 | 值 |
| --- | --- |
| 定位 | `absolute`; `inset: var(--titlebar-height) calc(4 * var(--u)) calc(4 * var(--u)) var(--rail-width)` |
| 背景 | `#181818`（`--canvas`） |
| 边框 | `1px solid #2f2f2f`（`--line`） |
| 圆角 | `calc(24 * var(--u)) calc(24 * var(--u)) calc(12 * var(--u)) calc(24 * var(--u))`（右下角更小，呼应窗口外壳） |
| 层级 | `z-index: 70`；覆盖主工作区，不新建窗口 |
| 入场动效 | `180ms cubic-bezier(.22,.9,.26,1)`，`opacity 0→1 + translateY(6px)→0`；`prefers-reduced-motion` 时取消 |

### 2.2 左导航 `.settings-nav`

| 项目 | 值 |
| --- | --- |
| 宽度 | `var(--mova-settings-split, clamp(214px, 27%, 400px))`，`flex: none`；可拖动右侧分隔条调整（见 2.4） |
| 内边距 | `12px 8px 18px`（左右随 `--u` 缩放） |
| 背景 / 分隔 | 背景 `#161616`（`--menu-bg`）；右侧 `1px solid #2f2f2f` |
| 滚动 | 自身可滚，`scrollbar-width: none`（隐藏滚动条，靠滚轮/触控板） |

### 2.3 右面板 `.settings-panel`

| 项目 | 值 |
| --- | --- |
| 布局 | `flex: 1; display: flex; flex-direction: column; overflow-y: auto` |
| 背景 | `#181818` |
| 滚动条 | `scrollbar-width: thin`，`scrollbar-color: #343434 transparent`，**`scrollbar-gutter: stable`**：无论页面长短都预留滚动条宽度，切换页面时居中内容列不会左右跳动 |
| 内容对齐 | 子元素 `.settings-panel-head` 与 `.settings-page` 都居中在内容列上（第 3 节） |
| 导航项 | 7 项：配置、使用情况和计费、模型、记忆与存储、MCP 工具、已归档的聊天、服务与索引（服务版新增）。当前版本**没有权限设置页**：权限由输入栏审批条与主进程权限存储承担 |

### 2.4 可拖拽分隔条（左右比例调节）

导航与面板之间有一条与对话页同款的分隔条，用来调整左右比例。

| 项目 | 值 |
| --- | --- |
| 元素 | `.settings-divider`（`role="separator"`、`aria-orientation="vertical"`、`aria-controls="settings-nav"`、`tabindex="0"`） |
| 位置 | `position: absolute; inset-block: 0; left: var(--mova-settings-split, <默认宽度>)`，`translateX(-50%)`；命中区 **14px** |
| 视觉 | 静止时只有 1px 分隔线；悬停/聚焦时在中心淡入 SVG 抓手（40×112，描边 `#909090`），拖动中导航右边线变成 `#656565` |
| 焦点 | `outline: 1px dashed #5b9bf0; outline-offset: -3px`（与对话页一致，避免遮挡 1px 线） |
| 拖拽范围 | 最小 **176px**，最大 `min(520px, 视图宽 - 424px, 视图宽 × 0.54)`；到边界即停，不会收起导航 |
| 键盘 | `←/→` 每次 16px，`Shift + ←/→` 48px，`Home/End` 到最小/最大；`aria-valuenow/min/max/valuetext` 同步 |
| 复位 | **双击分隔条**恢复 CSS 默认宽度 |
| 状态保持 | 拖拽结果写在 `.settings-view` 的内联 `--mova-settings-split` 上，关闭再打开设置仍保留；**不写入 localStorage**，刷新后回到默认 |
| 窄屏 | `max-width: 720px` 时隐藏分隔条并强制使用默认宽度，避免面板被挤没 |
| 内容列 | 面板变窄时 `.settings-page` 的 `--mova-settings-column` 自动收缩为「面板宽 - 48px」，卡片不会被挤压 |

---

## 3. 栅格：内容列与换行边界

### 3.1 内容列（唯一宽度来源）

```css
--content-column: min(718px, calc(100% - 48px));
```

- **用途**：聊天会话、Bot 会话、设置页页头与页内容，全部使用这一个变量；设置页**不再自带左右 padding**。
- **居中**：`width: var(--content-column); margin: 0 auto;`。
- **行为**：面板比 718px 宽时，内容列固定 718px 并居中（左右留白由面板决定）；面板比 718px 窄时，列自动收缩为「面板宽 − 48px」，两侧各保留 **24px**。
- **禁止**：给 `.settings-page` / `.settings-panel-head` 再加横向 `padding` 或 `max-width`；禁止卡片铺满面板。

| 面板可用宽度 | 内容列宽 | 单侧留白 |
| --- | --- | --- |
| 1200px | 718px | 241px |
| 900px | 718px | 91px |
| 700px | 652px | 24px |
| 500px | 452px | 24px |

### 3.2 垂直节奏

```
panel-head  padding-top       20px
            h2               26px / 700（自动行高，实测 35px，页头总高 55px）
page        padding           20px 0 48px       ← 页头与第一个分区之间 20px
section     gap               10px（section-title 与 card 之间）
section → section gap          30px
card 底 → 页底 padding-bottom  48px
```

### 3.3 行内文字边界（66% 规则）

- 行内文本块：`flex: 1 1 auto; min-width: 0; max-width: 66%; overflow-wrap: anywhere;`
- 说明文字达到行宽约 **2/3** 处换行，右侧约 1/3 留给控件（开关、下拉、按钮）或右侧备注。
- 窄窗口下文本块可继续收缩（`flex-shrink: 1`），控件不会被挤出卡片。
- 右侧备注（如「按实际能力提供」）：`flex: none; max-width: min(260px, 42%); text-align: right;`，保持单行右对齐。

---

## 4. 颜色系统

### 4.1 背景阶梯（只有 5 档 + 3 个交互动效色）

| 用途 | 色值 | 现状变量 / 选择器 | 说明 |
| --- | --- | --- | --- |
| 设置视图底、内容面板底 | `#181818` | `--canvas` | 最底层画布 |
| 卡片、导航、下拉/按钮底 | `#161616` | `--menu-bg` | 抬升一级的表面 |
| 导航内搜索框底 | `#131313` | `.settings-search` | 比所在表面更深，形成凹陷感 |
| 展开的表单/内嵌面板 | `#212121` | `.provider-editor` | 卡片内的第二层，必须带 `1px #2f2f2f` 边框 + 圆角 14 |
| 行/导航项悬停 | `#232323` | `.settings-item:hover` | 平面行悬停 |
| 按钮/下拉悬停、可点整块 | `#242424` / `#2c2c2c` | `.settings-add:hover` / `.settings-button:hover` | 控件悬停比行悬停高一档 |
| 导航选中项 | `#2f2f2f` | `.settings-item.selected` | 只用于「当前页」 |
| 进度条轨道 | `#2e2e2e` | `.settings-meter` | |

> 反例（禁止）：带绿/青色调的深灰（如旧的 `#141718`、`#1d2221`、`#242a28`）；任何 `rgba()` 彩色叠层做行背景。

### 4.2 描边与分隔

| 用途 | 色值 |
| --- | --- |
| 卡片描边、行间分隔线、工具栏控件描边 | `#2a2a2a` |
| 输入框、下拉、次级按钮描边 | `#313131` |
| 分区级分隔（设置视图外框） | `#2f2f2f`（`--line`） |
| 空状态虚线框 | `#323232`（`dashed`） |

### 4.3 文字阶梯

| 层级 | 目标色 | 现状色（逐处收敛） | 用途 | 字号/字重 |
| --- | --- | --- | --- | --- |
| L1 页面标题 | `#f5f5f5` | `#f5f5f5` | `.settings-panel-head h2` | 26px / 700 / `-0.6px` |
| L1' 导航标题 | `#f5f5f5` | `#f5f5f5`（= `--mova-settings-text-strong`） | `.settings-title` | 17px / 600 |
| L2 主文字 | `#f0f0f0` | `#f0f0f0`（行标题） | 行标题、列表标题、输入值 | 13px / 500 |
| L2' 分区标题 | `#e8e8e8` | `#e8e8e8`（section）/ `#f2f2f2`（选中项） | 分区标题、导航选中、输入值 | 13.5px / 600 |
| L3 次文字 | `#e2e2e2` | `#e2e2e2`（按钮） | 按钮文字 | 12.5–13.5px / 400 |
| L3' 导航项 | `#ffffff` | `#ffffff` | 导航项文字与图标（中字重） | 13px / 500 |
| L4 说明 | `#9e9e9e` | `#9e9e9e`（行说明）/ `#949494`（分区说明）/ `#939393`（元信息） | 行说明、分区说明、状态行、路径 | 12–12.5px / 400 |
| L5 弱说明 | `#909090` | `#909090` | 导航分组标签 | 13px / 500 |
| 链接 / 可点文字 | `#8fb8f2` | `#8fb8f2` | 说明内链接（hover 加下划线） | 同所在层级 |

> 收敛要求：L4 目前有 `#9e9e9e / #949494 / #939393` 三个近似值，L2/L2' 有 `#f0f0f0 / #f3f3f3 / #f5f5f5` 三个近似值。**新增页面一律只用表中「目标色」**；旧页面在大改时顺手合并，每次合并后重新核对对比度（第 9 节）。

### 4.4 强调与语义色

| 用途 | 色值 | 说明 |
| --- | --- | --- |
| 强调蓝（进度条、图标、Badge 文字、勾选/开关选中） | `#3795f5` | 用量、信息性强调 |
| 主按钮 | 底 `#2f6bd8`，hover `#3a7ae8`，字 `#ffffff` | 每屏最多一个 |
| 焦点环 | `#5b9bf0`，`2px`，`outline-offset: 3px` | 全局统一（含 `.memory-settings`，已从 `#8fb8f2` 收敛） |
| 危险文字 | `#e0928c`，hover 底 `#2c2322` | 删除、清空 |
| 警告条 | 底 `#28251e`，边 `#6b5232`，字 `#e5cc9e` | 仅提示类横幅 |
| 错误条 | 底 `#2c2322`，边 `#74443e`，字 `#f0b9b2` | 操作失败 |
| 状态文字 ok / error | `#7fb6f5` / `#e0928c` | `.model-form-status[data-tone]` |

### 4.5 实测对比度（2026-11-10 计算）

| 组合 | 比值 | 结论 |
| --- | --- | --- |
| 页面标题 `#f5f5f5` / 画布 `#181818` | 16.29:1 | AA |
| 分区标题 `#e8e8e8` / 画布 `#181818` | 14.49:1 | AA |
| 行标题 `#f0f0f0` / 卡片 `#161616` | 15.88:1 | AA |
| 行说明 `#9e9e9e` / 卡片 `#161616` | 6.75:1 | AA |
| 分区说明 `#949494` / 卡片 `#161616` | 5.97:1 | AA |
| 元信息 `#939393` / 卡片 `#161616` | 5.89:1 | AA |
| 链接 `#8fb8f2` / 卡片 `#161616` | 8.88:1 | AA |
| 导航项 `#ffffff`（加粗）/ 导航 `#161616` | 18.10:1 | AA |
| 分组标签 `#909090` / 导航 `#161616` | 5.67:1 | AA |
| 强调蓝 `#3795f5` / 卡片 `#161616` | 5.84:1 | AA（文字） |
| 主按钮 `#ffffff` / `#2f6bd8` | 4.98:1 | AA |
| 危险 `#e0928c` / 卡片 `#161616` | 7.46:1 | AA |
| 卡片描边 `#2a2a2a` / 卡片 `#161616` | 1.26:1 | **低于 3:1** |
| 控件描边 `#313131` / 卡片 `#161616` | 1.39:1 | **低于 3:1（非文本对比）** |
| 开关轨道 `#3e3e3e` / 卡片 `#161616` | 1.69:1 | **低于 3:1（非文本对比）** |

结论：**文字全部达到 WCAG 2.2 AA**；控件与卡片的边界属于「低对比结构线」，当前未达 1.4.11 的 3:1。算法上要满足 3:1，描边需要到 `#636363`（3.01:1）、开关轨道同样需要 `#636363`（3.01:1）——视觉会明显变亮，是否接受需设计确认；不要只靠阴影补边界。

### 4.6 设计 token（`--mova-settings-*`，已落地）

所有设置页样式都已改用 token，定义在 `source/styles.css` 的 `:root` 里（紧接「Settings design tokens」注释块）。**新增界面只引用 token，不再写字面色值。**

| 分组 | token | 值 |
| --- | --- | --- |
| 栅格 | `--mova-settings-column` | `var(--content-column)` = `min(718px, 100% - 48px)` |
| | `--mova-settings-nav-width` | `clamp(214px, 27%, 400px)` |
| | `--mova-settings-text-max` | `66%` |
| 节奏 | `--mova-settings-page-gap` | `30px` |
| | `--mova-settings-row-gap` | `24px` |
| | `--mova-settings-row-pad-block` / `-inline` | `14px` / `18px` |
| 背景 | `--mova-settings-canvas` | `var(--canvas)` = `#181818` |
| | `--mova-settings-surface` | `var(--menu-bg)` = `#161616` |
| | `--mova-settings-surface-sunken` | `#131313` |
| | `--mova-settings-surface-nested` | `#212121` |
| | `--mova-settings-surface-raised` | `#1f1f1f` |
| | `--mova-settings-surface-editing` | `#1a1a1a` |
| | `--mova-settings-hover-row` / `-block` / `-control` | `#232323` / `#242424` / `#2c2c2c` |
| | `--mova-settings-selected` | `#2f2f2f` |
| | `--mova-settings-meter-track` | `#2e2e2e` |
| | `--mova-settings-switch-track` / `-on` | `#3e3e3e` / `#2f7cf6` |
| | `--mova-settings-switch-knob` / `-on` | `#e2e2e2` / `#ffffff` |
| | `--mova-settings-badge-surface` | `#303030` |
| | `--mova-settings-dot-off` | `#444444` |
| 描边 | `--mova-settings-line` | `#2a2a2a` |
| | `--mova-settings-line-frame` | `var(--line)` = `#2f2f2f` |
| | `--mova-settings-line-control` | `#313131` |
| | `--mova-settings-line-dashed` | `#323232` |
| | `--mova-settings-line-help` / `-hover` | `#525252` / `#7f7f7f` |
| | `--mova-settings-line-focus` | `#3b6ea8`（输入框聚焦描边） |
| 文字 | `--mova-settings-text-strong` | `#f5f5f5` |
| | `--mova-settings-text-title` | `#f0f0f0` |
| | `--mova-settings-text-section` | `#e8e8e8` |
| | `--mova-settings-text-body` | `#e2e2e2` |
| | `--mova-settings-text-item` | `#cccccc` |
| | `--mova-settings-text-description` | `#9e9e9e` |
| | `--mova-settings-text-note` | `#949494` |
| | `--mova-settings-text-meta` | `#939393` |
| | `--mova-settings-text-group` | `#909090` |
| | `--mova-settings-text-dim` | `#727272` |
| | `--mova-settings-text-inverse` | `#ffffff` |
| | `--mova-settings-text-link` | `#8fb8f2` |
| | `--mova-settings-text-accent` | `#8fbcf5` |
| 强调 | `--mova-settings-accent` | `#3795f5` |
| | `--mova-settings-accent-strong` / `-hover` | `#2f6bd8` / `#3a7ae8` |
| | `--mova-settings-accent-control` | `#2f7cf6`（开关/勾选） |
| | `--mova-settings-accent-surface` | `#1e2c3d`（按压态底） |
| | `--mova-settings-accent-line` | `#2d4c74`（按压态描边） |
| | `--mova-settings-accent-glow` | `rgba(55, 149, 245, .12)` |
| | `--mova-settings-focus` | `#5b9bf0`（焦点环） |
| 语义 | `--mova-settings-danger` / `-hover` / `-surface` | `#e0928c` / `#f19b94` / `#2c2322` |
| | `--mova-settings-warning-surface` / `-line` / `-text` | `#28251e` / `#6b5232` / `#e5cc9e` |
| | `--mova-settings-error-line` / `-text` | `#74443e` / `#f0b9b2` |
| | `--mova-settings-status-ok` | `#7fb6f5` |
| 尺寸 | `--mova-settings-radius-card` / `-nested` / `-control` / `-toolbar` / `-pill` | `12px` / `14px` / `8px` / `10px` / `999px` |
| | `--mova-settings-radius-dialog` | `16px` |
| | `--mova-settings-control-height` / `-toolbar-height` / `-meter-height` | `32px` / `36px` / `4px` |
| 弹层 | `--mova-settings-overlay` | `#0008`（对话框遮罩） |
| | `--mova-settings-shadow-dialog` / `-menu` | `0 24px 60px #000a` / `0 16px 36px #0008` |
| 动效 | `--mova-settings-duration` / `-ease` | `180ms` / `cubic-bezier(.22, .9, .26, 1)` |

用法约定：

- 组件内**只写** `var(--mova-settings-*)`；下文的代码片段为便于阅读仍写数值，落地时按本表替换。
- 需要新颜色时，先判断能否复用上表某一档；确实不够用时新增 token 并同步更新本表，不在组件里写裸色值。
- 组件内部仍有 3 处允许的字面值：导航滚动条 `scrollbar-color: #343434`、弹层阴影 `0 16px 36px #0008`、圆角 6px 的路径 chip 与 6px 的 provider 徽标。

---

## 5. 字体层级

| 元素 | 字号 | 字重 | 行高 | 颜色 |
| --- | --- | --- | --- | --- |
| 导航标题（设置） | 17px | 600 | 1.4 | `#f5f5f5` |
| 导航分组标签 | 13px | 500 | 1.4 | `#909090` |
| 导航项 | 13px | 500 | 1.4 | `#ffffff`（图标同色；选中靠底色区分） |
| 页面标题（配置） | 26px | 700 | 未显式设置（实测 35px） | `#f5f5f5`；字距 `-0.6px` |
| 分区标题（权限/常规） | 13.5px | 600 | 1.4 | `#e8e8e8` |
| 分区说明 | 12px | 400 | 1.6 | `#949494` |
| 行标题 | 13px | 500 | 1.4 | `#f0f0f0` |
| 行说明 | 12.5px | 400 | 1.55 | `#9e9e9e`（`text-wrap: pretty`） |
| 右侧备注 | 12px | 400 | 1.6 | `#949494`，右对齐 |
| 控件文字（按钮/下拉） | 12.5px | 400 | 1.2 | `#e2e2e2` |
| 路径（等宽） | 11.5px | 400 | 1.5 | `#9e9e9e`，省略号 |
| 元信息（时间、计数） | 11–11.5px | 400 | 1.5 | `#939393` |
| Badge | 10.5px | 500 | 1.5 | `#8fbcf5` |

字体族沿用全局：`"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif`。数字类（百分比、token 数）加 `font-variant-numeric: tabular-nums`。

---

## 6. 组件规格

### 6.1 导航标题与搜索

**标题行 + 右上角搜索图标**（默认不占位）：

```css
.settings-nav-head     { display: flex; align-items: center; justify-content: space-between;
                         gap: 8px; margin: 4px calc(10 * var(--u)) 12px; }
.settings-title        { margin: 0; font-size: 17px; font-weight: 600; color: var(--mova-settings-text-strong); }
.settings-search-toggle{ width: 28px; height: 28px; border-radius: 8px; }
.settings-search       { height: 32px; margin: 0 10px 12px; padding: 0 10px; gap: 6px;
                         border: 1px solid #2a2a2a; border-radius: 8px; background: #131313; }
```

- 搜索**默认收起**，只在标题右侧保留一个 28×28 的图标按钮（放大镜 15px）；`aria-expanded` 同步。
- 点开后展开 32px 高的搜索框并自动聚焦；再次点击图标、或按 `Esc`（此时只收搜索、不关设置）收起，收起时清空关键词并恢复全部导航项。
- 占位文字与图标 `#939393`；输入文字 `#e8e8e8` 12px。搜索只过滤导航项，不参与内容检索（如需检索内容，另立规则）。

### 6.2 导航分组与导航项

| 项目 | 值 |
| --- | --- |
| 分组标签 | `margin: 8px 10px 10px; font-size: 13px; font-weight: 500; color: #909090`（下方留 10px，与第一项拉开） |
| 导航项 | `padding: 8px calc(6 * var(--u)) 8px calc(10 * var(--u))`（实测高 **33px**）；`border-radius: 8px`；`gap: 9px`；`font-size: 13px`；`font-weight: 500`；文字与图标 `#ffffff`；`width: 100%`；`text-align: left` |
| 图标 | 13–14px（随字号 1em），文字同色 `#ffffff`（选中不变色，靠 `#2f2f2f` 底色区分） |
| hover | 背景 `#232323` |
| 选中 | 背景 `#2f2f2f`，文字保持 `#ffffff` |
| 状态表达 | 选中项必须同时有 `aria-current="page"`（不只用底色） |

### 6.3 页面头 `.settings-panel-head`

```css
width: var(--content-column); margin: 0 auto; padding: 20px 0 0;
h2 { font-size: 26px; font-weight: 700; letter-spacing: -.6px; color: #f5f5f5; }
```

- 页面头只放页面标题（可选一个右侧操作按钮，`gap: 10px`）。
- 标题文案与导航项一致（导航点「模型」，标题就是「模型」）。

### 6.4 分区 `.settings-section`

```css
.settings-section        { display: flex; flex-direction: column; gap: 10px; }
.settings-section-title  { font-size: 13.5px; font-weight: 600; color: #e8e8e8; }
.settings-section-head   { display: flex; flex-direction: column; gap: 4px; }  /* 标题 + 说明 */
.settings-section-note   { font-size: 12px; line-height: 1.6; color: #949494; max-width: 620px; }
```

- 一屏建议 **2–4 个分区**；分区之间 30px。
- 说明跟随标题时放在 `.settings-section-head` 内，与标题间距 4px。

### 6.5 卡片与行

```css
.settings-card  { border: 1px solid #2a2a2a; border-radius: 12px; background: #161616; overflow: hidden; }
.settings-row   { display: flex; align-items: center; justify-content: space-between;
                  gap: 24px; padding: 14px 18px; }
.settings-row + .settings-row { border-top: 1px solid #2a2a2a; }
```

行结构（Anatomy）：

```
┌ .settings-card ────────────────────────────────────────────────┐
│ .settings-row  padding 14 / 18                                  │
│  ┌ .settings-row-text  ≤ 66% ──────────────┐   gap 24   ┌ 控件槽 ┐│
│  │ strong 13/500 #f0f0f0                   │           │ 开关   ││
│  │ p 12.5/1.55 #9e9e9e（到 66% 换行）        │           │ 下拉   ││
│  └─────────────────────────────────────────┘           │ 按钮×≤2 ││
└─────────────────────────────────────────────────────────────────┘
```

- **行高**（1440×900 实测，`14px` 上下内边距 + `3px` 标题/说明间距）：单行说明的行 **68px**，说明两行 **87px**，说明三行 **107px**。行内不设固定 `height`，由 padding 撑开。
- **控件槽**：`flex: none`，默认右对齐。允许 2 个控件并列，间距 **8px**（按钮组）或 **10px**（`.settings-inline-control`）。超过 2 个时改为「按钮触发弹层」，不要继续横排。
- **行内不允许**：表格、滚动区、第二层卡片、彩色背景块。需要展开表单时，用「整行按钮 + 下方 `.model-form` 面板」，不要塞进行内。
- **分割线**：仅 `+` 相邻行之间有，卡片首行上方无线，末行下方无线。

### 6.6 开关 `.settings-switch`

| 项目 | 值 |
| --- | --- |
| 尺寸 | `40 × 24px`，`border-radius: 999px` |
| 关 | 轨道 `#3e3e3e`，滑块 `#e2e2e2` |
| 开 | 轨道 `#2f7cf6`，滑块 `#ffffff`，`translateX(16px)` |
| 滑块 | `18 × 18px`，`top/left: 3px` |
| 动效 | `180ms cubic-bezier(.22,.9,.26,1)` |
| 语义 | `role="switch"` + `aria-checked` + `aria-label`；不可用时 `disabled` + 说明原因 |
| 命中区 | 控件本体即命中区（40×24）；如放在整行可点的位置，行内其它按钮需 `stopPropagation` |

### 6.7 下拉与按钮 `.settings-select / .settings-button`

| 变体 | 规格 |
| --- | --- |
| 默认 | `padding: 5px 10px; border: 1px solid #313131; border-radius: 8px; background: #161616; color: #e2e2e2; font-size: 12.5px; gap: 8px; white-space: nowrap` |
| hover | 背景 `#2c2c2c` |
| 行内操作按钮（模型行） | 高度固定 `28px`，`padding: 0 10px`，`justify-content: center` |
| 主按钮 `.primary` | 底 `#2f6bd8`、边 `#2f6bd8`、字 `#fff`；hover `#3a7ae8` |
| 危险 `.danger` | 文字 `#e0928c`；hover 底 `#2c2322` |
| 整宽新增 `.settings-add` | `width: 100%; padding: 11px 16px; gap: 8px; font-size: 13px; color: #d3d3d3`；hover `#242424`；展开时 `border-bottom: 1px solid #2a2a2a` |
| 图标按钮 | `28 × 28px`，`border-radius: 8px`，色 `#9e9e9e`；hover 底 `#2d2d2d` |

按钮文案：**动词 + 对象**（「更改」「保存」「取消归档」），2–4 个汉字；不使用「确定/是」。

### 6.8 表单（展开式编辑区）

```css
.model-form       { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; }
.model-form-grid  { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
.model-field      { display: flex; flex-direction: column; gap: 5px; }
.model-field > span { font-size: 11.5px; color: #939393; }
.model-field input  { height: 32px; padding: 0 10px; border: 1px solid #313131; border-radius: 8px;
                      background: #161616; color: #e8e8e8; font-size: 12.5px; }
.model-field input:focus { border-color: #3b6ea8; }   /* 焦点环仍由全局 focus-visible 提供 */
.model-form-actions { display: flex; gap: 8px; padding-top: 2px; }
.model-form-status  { flex: 1; font-size: 12px; color: #939393; }
```

- 双列仅在内容列 ≥ 560px 时使用，否则 `@media (max-width: 860px)` 降为单列。
- 表单出现时用 180ms 的 `translateY(-4px)` 渐入，不改变周围卡片尺寸（避免跳动）。
- 保存结果就地显示在 `.model-form-status`，不弹 toast。

### 6.9 路径、百分比、进度条、Badge

| 组件 | 规格 |
| --- | --- |
| 路径 `.settings-path` | `max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: #9e9e9e`；等宽场景用 `ui-monospace, Consolas` |
| 百分比 `.settings-percent` | `12.5px; color: #cccccc; tabular-nums; flex: none` |
| 进度条 `.settings-meter` | 轨 `4px` 高、`border-radius: 999px`、`background: #2e2e2e`；填充 `#3795f5`；位于行下方时 `margin: -4px 16px 12px`（左右内缩到 16px） |
| Badge `.model-badge` | `padding: 1px 7px; border-radius: 999px; background: #303030; color: #8fbcf5; font-size: 10.5px` |
| 状态点 `.provider-dot` | `8px` 圆，离线 `#444444`，在线 `#3795f5` + `box-shadow: 0 0 0 3px rgba(55,149,245,.12)` |

### 6.10 工具栏（搜索 + 筛选，如「已归档的聊天」）

```css
.archive-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.archive-search  { height: 36px; padding: 0 12px; border: 1px solid #2a2a2a; border-radius: 10px; background: #161616; }
.archive-menu    { height: 36px; padding: 0 12px; border: 1px solid #2a2a2a; border-radius: 10px; background: #161616; }
```

- 工具栏高度统一 **36px**，圆角 **10px**（比按钮的 8px 略大，表示它在页面级而非行内）。
- 搜索框 `flex: 1`，筛选控件 `flex: none`，间距 10px；不允许换行，窄屏时筛选降级为图标按钮。

### 6.11 空状态与提示

| 类型 | 规格 |
| --- | --- |
| 空状态 | `padding: 26px 16px; border: 1px dashed #323232; border-radius: 12px;` 文案 12.5px `#9e9e9e`，一行说明 + 可选一个主操作 |
| 提示横幅 | `padding: 14px 16px; border-radius: 10px`（警告 `#28251e/#6b5232/#e5cc9e`；错误 `#2c2322/#74443e/#f0b9b2`） |
| 行内说明 | 直接放在分区标题下（`.settings-section-note`），不要为一句说明单独造卡片 |

### 6.12 行列表（带操作的条目）

用于「一条数据 = 一行」的列表，例如记忆库。整个列表放在**一个** `.settings-card` 里，条目之间只用 1px 分隔线。

```css
.memory-item { display: flex; align-items: center; justify-content: space-between;
               gap: 16px; padding: 12px 16px; }        /* 列表密度可比设置行更紧 */
.memory-item + .memory-item { border-top: 1px solid var(--mova-settings-line); }
.memory-item-main { flex: 1 1 auto; min-width: 0; max-width: var(--mova-settings-text-max);
                    display: flex; flex-direction: column; gap: 3px; text-align: left; }
.memory-item-title { font-size: 13px; font-weight: 500; color: var(--mova-settings-text-title);
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memory-item-meta  { display: flex; align-items: center; gap: 8px; font-size: 11.5px;
                     color: var(--mova-settings-text-meta); }
```

- **整行主体是按钮**：点击打开「详情」对话框；主体只承载标题（单行省略）与元信息，不承载长正文。
- **右侧操作槽**：最多 2 个图标按钮（`28 × 28`，圆角 8），示例为「置顶 + 更多」；第三个动作收进「更多」菜单。
- **更多菜单**：`min-width: 132px`，`padding: 6px`，`border: 1px solid var(--mova-settings-line-dashed)`，`background: var(--mova-settings-surface-raised)`，`box-shadow: var(--mova-settings-shadow-menu)`；危险项用 `--mova-settings-danger` 文字 + `--mova-settings-danger-surface` 悬停。
- **状态徽章**：`padding: 1px 7px`、`border-radius: var(--mova-settings-radius-pill)`、`font-size: 10.5px`；生效态用 `accent-surface + accent-line + text-accent`，停用/替代用描边 + 弱文字。
- **图标来源**：React 组件一律从 `@keyline-icons/react` 引入并渲染 SVG（`size="1em"`）；静态 HTML 里的 `i.ph` 只由 `icons.js` 的 `replaceStaticIcons()` 在初始化时替换，React 动态渲染的节点不会经过这一步，**不要**在 JSX 里写 `<i class="ph …">`。

### 6.13 对话框 `dialog.settings-dialog`

用于新增/编辑、详情查看与危险操作确认。实现用原生 `<dialog>` + `showModal()`，自带焦点陷阱与 Esc 关闭。

```
┌ dialog.settings-dialog ───────────────────────┐
│ settings-dialog-head   title 15/600     × 28px│
│ settings-dialog-body   padding 12 20 20       │
│   p 12.5/1.7 text-description                 │
│   textarea / input / 详情正文 / 确认输入框      │
│ settings-dialog-actions 右对齐 取消 + 主操作    │
└───────────────────────────────────────────────┘
```

| 项目 | 值 |
| --- | --- |
| 面板 | 宽 `min(460px, 100vw - 40px)`；`data-size="wide"` 时 `min(560px, …)`；圆角 `--mova-settings-radius-dialog`；边框 `1px --mova-settings-line-frame`；底 `--mova-settings-surface`；阴影 `--mova-settings-shadow-dialog` |
| 遮罩 | `::backdrop { background: var(--mova-settings-overlay) }`（`#0008`） |
| 内边距 | head `18px 20px 0`；body `12px 20px 20px`；actions `0 20px 20px` |
| 正文 | `font-size: 12.5px; line-height: 1.7; color: --text-description`；滚动时 body `max-height: min(58vh, 460px)` |
| 动作区 | 右对齐、间距 8px；取消在左、主操作在右；主操作高 30px、`padding: 0 14px` |
| 主操作颜色 | 普通确认用 `.settings-button.primary`；破坏性用 `.danger-solid`（`--mova-settings-danger` 实底 + **深色字** `danger-surface`，hover `danger-hover`）——白字在浅红底上只有约 2:1，禁止使用 |
| 禁用态 | `.danger-solid:disabled` 退回中性：`surface-nested` 底 + `line-control` 边 + `text-meta` 字，不保留红底 |
| 动效 | `180ms` 渐入 + `translateY(8px)`；`prefers-reduced-motion` 关闭 |

**三种对话框的内容规则**：

1. **危险确认（单条）**：标题为疑问句（「删除这条记忆？」），正文给后果与替代方案（「可以先用停用代替删除」），附被操作对象的摘要；确认按钮只需点击一次。
2. **危险确认（批量）**：标题「清空全部长期记忆？」；正文说明影响范围（所有项目、不可撤销、建议先备份）；**必须输入确认词**（按钮文案与目标一致，如「清空记忆」）才能启用确认按钮，确认词用 `--mova-settings-text-accent` 高亮。
3. **详情/表单**：标题为名词短语；表单里主操作放在 footer，用 `form` 属性或 `method="dialog"` 关联，不要把按钮散落在正文中。

### 6.14 状态徽章 `.memory-pill`

服务健康、备份状态、通道状态共用一种胶囊徽章，只用 5 档语义色，不新增色阶：

| tone | 用途 | 视觉 |
| --- | --- | --- |
| `ok` | 正常 / 已完成 / 两路可用 | 底 `accent-surface`、边 `accent-line`、字 `text-accent` |
| `warn` | 加载中 / 迁移中 / 进行中 | 底 `warning-surface`、边 `warning-line`、字 `warning-text` |
| `error` | 不可用 / 失败 | 底 `danger-surface`、边 `error-line`、字 `error-text` |
| `muted` | 未启用 | 仅 `line-control` 描边 + `text-meta` 字 |
| `unknown` | 未检测 / 未报告 | **虚线边** `line-dashed` + `text-dim` 字 |

规格：`padding: 1px 8px`、圆角 pill、11px / 500、`max-width: 46%` 截断、`white-space: nowrap`。**未接入的能力必须显示 `unknown`，不能显示成「已连接」**（服务版硬性要求）。

### 6.15 统计网格 `.memory-stats`

`<dl>` + 2 列网格（≤720px 降为 1 列），`gap: 1px` 用 `line` 色充当分隔线，整块底部一条 1px 线。

```css
.memory-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px;
                background: var(--mova-settings-line); border-bottom: 1px solid var(--mova-settings-line); }
.memory-stats > div { display: flex; align-items: baseline; justify-content: space-between;
                      gap: 12px; padding: 10px 18px; background: var(--mova-settings-surface); }
```

- 左侧 `dt`：12px `text-meta`；右侧 `dd`：13px `text-title` + `tabular-nums`。
- 只放「名 + 数」的短指标；超过 8 项拆成两组，不要出现第三列。

### 6.16 配额进度条 `.memory-quota`

| 项目 | 值 |
| --- | --- |
| 出现条件 | 仅当 `quota > 0`（上限 `0` = 不限制，不画条） |
| 表头 | 左「已用 532 MB / 1.0 GB」12px `text-description`；右百分比，按 tone 着色 |
| 轨道 | 6px、圆角 pill、`meter-track` |
| 填充 | 默认 `accent`；≥70% 用 `warning-line`；≥90% 用 `danger` |
| 最小宽度 | 2%（空数据时仍能看到一点进度） |

进度条与设置页的 `.settings-meter`（4px、无 tone）是两种语义：meter 表示「构成占比」，quota 表示「配额消耗」，不可互换。

### 6.17 权重滑块 `.settings-weight` + `.memory-range`

用于「关键词 ↔ 语义」这类**互补权重**：一个滑块，一个值，另一端自动是 `1 - v`。

- 块内三段：标题行（左「混合权重」、右「关键词 0.50 / 语义 0.50」）→ 滑块 → 底部两端文案 + 中间「恢复均衡」文字按钮。
- 轨道 4px、圆角 pill、`meter-track`；滑块 14px 圆点、`accent` + `accent-glow` 光晕；`step 0.05`。
- 键盘：原生 range 行为（←/→ 一格、Home/End 到端点）；焦点环 `2px focus`、`offset 4px`。
- 两个权重必须互补（和为 1）；需要独立权重时改用两个数字输入，不要用两个滑块。

### 6.18 整行单选 `.settings-choice`

`role="radiogroup"` 的卡片，每行一个 `role="radio"` 按钮：

- 行：`padding: 12px 18px`、`gap: 12px`、行间 1px `line` 分隔、hover 底色 `hover-row`。
- 圆点：14px，未选 `line-control` 描边，选中 `accent` 实心 + 3px `surface` 内环。
- 文案：标题 13px / 500 `text-title`，说明 12.5px / 1.55 `text-description`（与行内 66% 边界一致）。
- 选项 2–4 个时用整行单选；超过 4 个改用下拉。

### 6.19 备份行（列表内的危险动作）

备份记录复用 6.12 的行列表，但每行右侧只放一个「恢复」按钮，且**不可用状态直接禁用**（只允许 `completed`）：

- 行标题：`时间 · 类型备份`；元信息：状态徽章 + 大小 + （失败时）错误摘要用 `warning-text`。
- 恢复必须进对话框并输入确认词「恢复」（6.13 的危险确认第 2 类），不允许行内直连。
- 空态用 6.11 的虚线空状态：「服务端还没有备份记录。」

### 6.20 右下角提示（toast）

一次性反馈（保存成功、操作完成、可恢复的错误）**不再插入页面内的提示行**，统一出现在右下角。

| 项目 | 值 |
| --- | --- |
| 位置 | `position: fixed; right: 20px; bottom: 20px`，向上堆叠，`gap: 8px` |
| 宽度 | `max-width: min(360px, 100vw - 40px)`，随内容自适应 |
| 外观 | 底 `surface-nested`、边 `line-frame`、圆角 8、阴影 `0 12px 28px #0008`、12.5px / 1.55 |
| 语义色 | `default` 中性；`ok` 用 `accent-surface + accent-line + text-accent`；`error` 用 `danger-surface + error-line + error-text` |
| 时长 | **统一 3s**（含错误提示）；**悬停暂停**，移开后 1.6s 关闭；也可点 × 立即关闭 |
| 数量 | 同屏最多 3 条，超出时最早的自动退场 |
| 动效 | `180ms cubic-bezier(.22,.9,.26,1)` 上浮渐入，退场 160ms 渐隐下移；`prefers-reduced-motion` 关闭 |
| 无障碍 | 容器 `role="status" aria-live="polite"`；关闭按钮 `aria-label="关闭提示"` |
| 实现 | `src/features/ui/toast.js` 的 `notify(message, { tone, duration })`；React 与原生 DOM 共用 |

分工规则：

- **toast**：动作结果、状态变更、可重试的错误（例如「记忆设置已保存」「备份已完成」）。
- **内联横幅**：需要常驻说明或带操作按钮的状态（未接入、仓库损坏、当前为示例数据），仍放在分区标题下方，不消失。
- 同一动作只发一条 toast；连续失败不要刷屏，第二次起合并为「仍然失败：原因」。

---

## 7. 状态与动效

| 状态 | 表现 |
| --- | --- |
| hover | 行/导航项背景 `#232323`；按钮/下拉背景 `#2c2c2c`；整块可点 `#242424` |
| 按下 | 沿用 hover 底色即可，不加缩放/位移动效 |
| 选中 | 背景 `#2f2f2f` + 文字提亮；不得只靠颜色（配 `aria-current` / `aria-checked`） |
| 焦点 | 全局 `2px #5b9bf0`，`outline-offset: 3px`；不得被 `overflow: hidden` 裁掉 |
| 禁用 | `opacity: .35`（记忆页）或 `.settings-switch` 的 `disabled` + 说明；`cursor: not-allowed` |
| 过渡 | 颜色 `150ms`；开关**轨道** `180ms ease`、**滑块** `180ms cubic-bezier(.22,.9,.26,1)`；`prefers-reduced-motion` 全部取消 |

---

## 8. 响应式

| 断点 | 行为 |
| --- | --- |
| > 860px | 双列表单可用；内容列 718px 居中 |
| ≤ 860px | `.settings-panel-head` padding 改为 `12px 0 0`；`.settings-page` 改为 `10px 0 28px`；内容列自动收缩，表单降为单列 |
| ≤ 620px | 列表行改为纵向堆叠（`.model-row { flex-direction: column; align-items: flex-start; gap: 8px }`），操作区可换行 |
| ≤ 600px | 行内文本与控件换行（现状仅 `.memory-settings` 内的行生效：`flex-wrap: wrap; gap: 12px`；其它页面建议补同一条规则，避免右侧控件被压缩到不可读） |

- 窄屏仍保留左导航（宽度随 `clamp` 收缩到 214px 下限），不做抽屉化；若未来要抽屉化，需另立规范并保留键盘可达性。

---

## 9. 无障碍与验收

1. **对比度**：正文 ≥ 4.5:1，大号文字/图标 ≥ 3:1（第 4.5 节实测表；新增色必须先测）。
2. **键盘**：Tab 顺序 = 导航 → 页头 → 分区内容；焦点环始终可见；`Esc` 关闭设置视图。
3. **语义**：导航用 `<nav>` + 按钮；开关 `role="switch"`；下拉 `aria-expanded`；列表当前项 `aria-current`。
4. **命名**：图标按钮必须有 `aria-label`；只有图标没有文字的按钮不可省。
5. **命中区**：可点控件最小 `28 × 28px`（图标按钮），行内主控件不低于 `24px` 高。
6. **文案**：标题 ≤ 12 个汉字的名词短语（「项目文件与终端」）；说明 1–2 句、≤ 60 字为宜，超出拆成两句或改为分区说明。
7. **不闪烁**：展开/收起表单不得引起卡片高度跳变（用渐入 + 固定内边距）。

---

## 10. 现有页面对照（2026-11-10 已统一）

5 个设置页已全部改用 `--mova-settings-*` token，原先的偏差项已收敛：

| 页面 | 统一前 | 现在 | 说明 |
| --- | --- | --- | --- |
| 配置 | 基准 | 完全符合 | token 的参考实现 |
| 使用情况和计费 | 无偏差 | 完全符合 | 进度条改用 `--mova-settings-meter-*` / `accent` |
| 模型（行） | `padding: 10px 16px`、`gap: 20px`、`min-height: 52px` | `14px 18px`、`gap: 24px`、无固定最小高 | 行高与配置页一致；实测单行 63px |
| 模型（卡片） | 圆角 `16px` | `--mova-settings-radius-card`（12px） | 与 `.settings-card` 同圆角 |
| 模型（表单/目录） | 输入框 `34px`/`#121212`/`#2f2f2f`/`9px`；目录行底 `#1c1c1c` | `32px`/`surface`/`line-control`/`8px`；目录行底 `surface` | 目录行改为「凹于内嵌面板」的同一档表面 |
| 记忆与存储 | 输入框 `#202020` + `#3b3b3b`；焦点环 `#8fb8f2` | `surface` + `line-control`；焦点环 `--mova-settings-focus` | 见第 14 节：已改为三段结构、行列表 + 对话框，`.memory-banner/-error/-notice/-path` 也全部改用语义 token |
| 服务与索引（新增） | — | 按本文重写：健康状态、备份恢复、索引、权重、提取模式、配额六段 | 示例数据驱动，见 6.14–6.19 |
| 已归档的聊天 | 行 `padding: 12px 16px`；无徽章；永久删除直接执行 | 行内保留紧凑内边距；元信息加「本地 / 云端」徽章（`.memory-project`）；**永久删除改走确认弹窗**（`confirmAction`，danger）；操作结果走右下角 toast | 视觉与设置页一致，详见 6.20 |
| 导航隐藏滚动条 | `scrollbar-width: none` | 保持 | 长导航靠滚轮/触控板；如需改动，加渐隐提示而非显示滚动条 |

仍然允许的字面值只有三处（见 4.6 末）：导航滚动条颜色、弹层阴影、6px 圆角的小 chip 与徽标。它们不影响阶梯，属于「组件微结构」。


## 11. 页面模板（可直接复制）

```html
<div class="settings-page" id="settings-page-demo">
  <section class="settings-section">
    <div class="settings-section-head">
      <h3 class="settings-section-title">分区标题</h3>
      <p class="settings-section-note">可选的单句说明，用来说明这一组开关的整体行为。</p>
    </div>

    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-text">
          <strong>项目文件与终端 · 尚未接入</strong>
          <p>说明文字在行宽约三分之二处换行，右侧留给控件。</p>
        </div>
        <button class="settings-switch" role="switch" aria-checked="false" aria-label="项目文件与终端"><span></span></button>
      </div>

      <div class="settings-row">
        <div class="settings-row-text">
          <strong>外部服务与数据发送</strong>
          <p>需要两个以上动作时，优先收进一个按钮或弹层，不要横向堆叠。</p>
        </div>
        <span class="settings-section-note">按实际能力提供</span>
      </div>

      <div class="settings-row">
        <div class="settings-row-text">
          <strong>默认文件打开位置</strong>
          <p>下拉类选择器固定 32px 高、8px 圆角。</p>
        </div>
        <button class="settings-select" aria-expanded="false">File Explorer <i class="ph ph-caret-down"></i></button>
      </div>

      <div class="settings-row">
        <div class="settings-row-text">
          <strong>项目外聊天文件夹</strong>
          <p>路径与次操作并排时，路径截断、按钮不换行。</p>
        </div>
        <div class="settings-inline-control">
          <span class="settings-path">C:\Users\…\Documents</span>
          <button class="settings-button">更改</button>
        </div>
      </div>
    </div>
  </section>

  <section class="settings-section">
    <h3 class="settings-section-title">用量</h3>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-text">
          <strong>上下文窗口</strong>
          <p>820K / 1M 已用，剩余 18%。</p>
        </div>
        <span class="settings-percent">82%</span>
      </div>
      <div class="settings-meter"><span style="width: 82%"></span></div>
    </div>
  </section>
</div>
```

---

## 12. 检查清单

新增或改版一个设置页时，逐条确认：

- [ ] 页面放在 `.settings-view` 内，没有自建顶栏/滚动容器。
- [ ] 页头与内容都用了 `var(--content-column)` + `margin: 0 auto`，卡片没有铺满面板。
- [ ] 分区之间 30px，标题与卡片 10px，行内 14/18，行间只有 1px `#2a2a2a` 分隔。
- [ ] 行文本 `max-width: 66%`，长说明在 2/3 处换行；右侧控件不被挤压。
- [ ] 背景只用 `#181818 / #161616 / #131313 / #212121`；没有彩色底。
- [ ] 文字只用 L1–L5 档位，没有新的近似灰。
- [ ] 强调只用 `#3795f5 / #2f6bd8`，焦点环 `#5b9bf0`。
- [ ] 一屏最多一个主按钮；危险操作用 `#e0928c` 文字而非红底。
- [ ] 导航宽度可拖拽：拖动/键盘/双击复位都生效，720px 以下自动隐藏分隔条。
- [ ] 搜索默认收成右上角图标；点开可过滤，`Esc` 先收搜索再关设置。
- [ ] 开关/下拉/按钮都有 hover、focus-visible、disabled 三态。
- [ ] 键盘可完成全部操作；`Esc` 关闭；`aria-current` / `aria-checked` / `aria-expanded` 齐备。
- [ ] 对话框用原生 `<dialog>` + `showModal()`；`Esc`、遮罩点击、× 与取消都能关闭，关闭后焦点回到触发元素。
- [ ] 危险操作走对话框；批量操作用输入确认词，单条删除一次点击确认。
- [ ] 列表行只放 1 个主体 + 最多 2 个图标按钮，其余动作进「更多」菜单。
- [ ] 状态徽章只用 5 档 tone（ok / warn / error / muted / unknown），未知态必须是虚线边，不能默认显示「已连接」。
- [ ] 统计值右对齐并使用 tabular-nums；配额条只在设置了上限时出现，≥70% 转 warn、≥90% 转 error。
- [ ] 整行单选（radiogroup）有选中圆点 + 标题 + 说明，键盘方向键可切换。
- [ ] 一次性反馈用右下角 toast（≤ 3 条、可关闭、hover 暂停），页面里不再出现临时提示行。
- [ ] 常驻状态（未接入 / 示例数据 / 仓库损坏）用内联横幅，不消失、不重复弹 toast。
- [ ] 860 / 620 / 600 三个断点下无横向滚动、文字不溢出。
- [ ] 文字对比度实测 ≥ 4.5:1（贴出数值）。

---

## 13. 回归验证（2026-11-10）

token 化后按 1440×900 与 980×820 两档重拍了 5 个页面，并与改造前逐像素比对：

| 页面 | 差异像素 | 差异占比 | 结论 |
| --- | --- | --- | --- |
| 配置 | 1 792 | 0.138% | 仅导航区 < 1/255 级的文字/圆角差 |
| 使用情况和计费 | 3 180 | 0.245% | 同上（含左下小球动画） |
| 模型 | 1 799 | 0.139% | 同上（浏览器版无提供商列表，行/表单用夹具验证） |
| 记忆与存储 | 32 557 | 2.512% | 输入框底色 `#202020 → #161616`（本次有意收敛） |
| 已归档的聊天 | 3 644 | 0.281% | 仅导航区 |
| 配置（980 宽） | 1 496 | 0.186% | 仅导航区 |

- 差异的最大值集中在左侧导航（`search` 描边 `#2e2e2e → #2a2a2a`、导航项圆角 `9 → 8`）与左下情绪小球（动画抖动），正文区域基本 0 差异。
- 模型页的提供商/目录组件在浏览器版无数据，改用「组件夹具」注入真实 DOM 验证：行 `14px 18px`、卡片圆角 `12px`、输入框 `32px`、按压芯片 `#1e2c3d + #2d4c74`、进度条 `4px + #3795f5`、开关 `40×24 → #2f7cf6` 全部与本文一致。
- 冒烟测试（设置/Bot/社区/模拟对话/隔离存储）通过，0 浏览器异常与失败请求。
- 截图与夹具脚本在 `qa/regression/` 与 `qa/scripts/fixture-models.js`。
---

## 14. 案例：记忆与存储页

> 参考图：[memory-reference.png](assets/memory-reference.png)（整页）、[memory-dialog-reference.png](assets/memory-dialog-reference.png)（记忆详情）、[memory-confirm-reference.png](assets/memory-confirm-reference.png)（批量清空确认）。
> 实现：`source/src/features/memory/memory-settings.jsx` + `memory-settings.css`。

### 14.1 结构（三段）

| 分区 | 内容 | 组件 |
| --- | --- | --- |
| 长期记忆 | 3 个开关 + 3 个数字上限 + 历史保留说明 | 卡片 + 行 + 开关 + 数字输入 + 保存按钮 + 右侧备注 |
| 记忆库 | 搜索工具栏、记忆列表、空状态 | 工具栏（搜索框 + 范围下拉 + 含全局 + 搜索 + 添加）+ 行列表 + 状态徽章 + 更多菜单 |
| 存储与备份 | 仓库统计与路径、导出、清空记忆、清空历史 | 卡片 + 行 + 路径 chip + 右侧备注 + 危险文字按钮 |

- 合并「历史搜索」到「记忆库」的工具栏：搜索是列表的过滤手段，不再单独占一个分区。
- 记忆的增删改全部通过对话框完成，列表本身保持只读，避免行内表单把行高撑开。
- **卡片内的表单**按 §6.8 由卡片补 `padding: 14px 16px 16px`（`.settings-card.memory-form`）；同一表单放进对话框时由 `.settings-dialog-body` 提供内边距，不重复加。
- **隐私保险库**并入「存储与备份」段，是该段的次级分区（`.settings-subsection` + `h4.memory-subtitle`），不再单独占一个顶级分区。
- **最近记忆提取任务**并入「记忆库」段底部：默认只显示最近 3 条，其余折叠在「显示更多（还有 N 条）」后面，展开后按钮变为「收起」。
- 记忆行右侧操作槽固定为 **2 个 28×28 图标按钮**（置顶 + 更多）；编辑、停用/启用、查看来源、删除全部收进「更多」菜单（`.memory-menu`）。
- 新增与编辑记忆使用 `SettingsDialog`（原生 `<dialog>` + `showModal()`，见 §6.13），列表保持只读。
- **数值口径**：导航内边距、标题行间距等历史实现用 `calc(n * var(--u))` 换算，`--u = clamp(.58px, 100vw / 2600, .69px)`；本文出现写死 px 时以实际实现为准，新增样式不要再引入 `--u`。

### 14.1b 2026-11-10 服务版补充

主项目新增了「服务版」（PostgreSQL + pgvector / Redis 队列 / MinIO / 本地 Embedding），界面按本文拆成两页：

- **记忆与存储**（3 段）：长期记忆、记忆库、存储与备份。新增内容：
  - 搜索范围下拉提供 `当前项目 / 全局记忆 / 全部项目`；选「全部项目」时不再显示「含全局结果」，因为它是用户主动发起的跨项目检索，Agent 自动上下文永远不会用它；
  - 搜索结果行在类型后加**项目徽章**（`.memory-project`，10.5px、`surface-raised` 底），标出「全局 / 当前项目 / 其他项目」；
  - 添加记忆的对话框增加「类型」下拉（项目事实 / 用户偏好 / 项目决定 / 备注），与保存范围并排；
  - 「手动导出备份」说明里注明自动备份与整库恢复在「服务与索引」页。
- **服务与索引**（新页面，6 段 + 备份记录）：服务连接与健康状态、自动备份与恢复、备份记录、Embedding 与索引、语义检索与混合权重、记忆提取模式、存储配额与服务状态。组件规格见 6.14–6.19。

浏览器预览没有桌面桥接：两页都用示例数据渲染，顶部一条黄色提示说明「示例数据、写入不执行」，弹窗与列表仍可正常打开。

### 14.2 对话框矩阵

| 触发 | 类型 | 关键规则 |
| --- | --- | --- |
| 点击列表行 / 详情 | 详情（wide） | 全文 + 6 项元数据 + 来源按钮；footer：关闭 / 编辑 / 删除 |
| 「添加记忆」/「更多 → 编辑内容」 | 表单 | textarea + 字数 0/4000 + 保存范围；footer 主操作按 `form` 关联 |
| 「更多 → 删除」/ 详情里的删除 | 单条危险确认 | 一次点击确认，附记忆摘要 |
| 「清空记忆」「清空历史」 | 批量危险确认 | 必须输入「清空记忆」/「清空历史」；作用于所有项目 |
| 「导出备份」 | 导出说明 | 说明未加密与凭据遮盖的边界，主操作为 primary |

### 14.3 浏览器预览（无桌面端仓库）

- 顶部黄色提示条说明「当前为示例数据，写入/导出/清空已禁用」。
- 列表、详情、菜单、确认对话框**照常可打开**（便于评审视觉与交互），只有真正写入的按钮保持 disabled。
- 示例数据固定 5 条，覆盖生效 / 已停用 / 已被替代、置顶、多来源、全局与项目范围。

### 14.4 验收要点

- [ ] 三段之间 30px，卡片行 14/18，列表行 12/16，分隔线只出现在行之间。
- [ ] 搜索工具栏 36px 高、10px 圆角；无关键词时「搜索」按钮禁用。
- [ ] 列表标题单行省略，元信息一行内可截断；行主体到 66% 处结束。
- [ ] 危险按钮文字 `#e0928c`，确认按钮才用实底红；禁用时退回中性灰。
- [ ] 批量清空的确认按钮在输入正确确认词之前保持禁用。
- [ ] 关闭对话框：× 按钮、取消、Esc、点击遮罩四种方式都可用，焦点回到触发按钮。
