# M0 技术验证报告：浏览器 Agent 的 6 个硬假设

> 日期：2026-11-11  
> 环境：Windows / Electron 45.2.3 / Chromium 156.0.8078.80 / DPR 2  
> 脚本：`scripts/browser-spike.cjs`  
> 原始结果：`design/browser-spike/report.json`（截图同目录）

## 1. 结论

| 假设 | 结果 | 说明 |
| --- | --- | --- |
| `<webview>` guest 上能 `debugger.attach('1.3')` | ✅ | 3 个 guest 都成功；`isAttached()` 为 true |
| `Accessibility.getFullAXTree` 返回 `backendDOMNodeId` | ✅ | 29 个节点，22 个带 backend id |
| `DOM.resolveNode` + `Input.dispatchMouseEvent` 能真实点击 | ✅ | 点中 “Go”，页面 DOM 变为 `clicked` |
| 隐藏 Tab 能截图 | ❌ **会挂起，不只是空白** | offscreen / `display:none` / 窗口隐藏，三种都失败 |
| JS 对话框能拦截，不卡死 Tab | ✅ | `Page.javascriptDialogOpening` → accept → 后续 evaluate 正常 |
| AXTree 能覆盖 iframe / shadow DOM | ✅ | 跨 frame 用 `frameId`；open shadow root 的按钮直接出现 |

**一句话：除截图外，全部通过；截图必须“先让页面可见”。**

## 2. 测试明细

### 2.1 CDP attach

```text
guest 2/3/4 (main / offscreen / display:none)
debugger.attach('1.3') → isAttached() = true
Page.enable / DOM.enable / Runtime.enable / Accessibility.enable 全部成功
```

### 2.2 AXTree

```text
nodes: 29
withBackendNodeId: 22
raw JSON: 11,893 bytes
naive text: 517 bytes / 27 lines
buttons: Go (backend 14), Alert (15), Shadow (19)
```

- shadow DOM 里的 “Shadow” 按钮直接出现在 AXTree；
- iframe 通过 `Accessibility.getFullAXTree({frameId})` 取到，返回 6 个节点，包含 “Frame Button”；
- 动态插入的 “Late” 按钮在 1 秒后的第二次快照里出现（第一次没有）——**快照是时点数据，动作后必须重新取**。

### 2.3 真实点击

```text
DOM.resolveNode({backendNodeId:14}) → objectId
Runtime.callFunctionOn → getBoundingClientRect → (207, 108)
Input.dispatchMouseEvent mousePressed/mouseReleased
document.querySelector('#result').textContent === "clicked"
```

### 2.4 截图（关键失败）

| 场景 | `capturePage()` | `Page.captureScreenshot` | 结论 |
| --- | --- | --- | --- |
| 当前可见 Tab | ✅ 36 KB / 1800×1200 | ✅ | 正常 |
| 全页（可见） | — | ✅ 148 KB / 1770×5008 | `captureBeyondViewport` 正常 |
| 窗口外（position offscreen） | ❌ `UnknownVizError` | ❌ 一直挂起 | 不可用 |
| `display:none` | ❌ 0×0 空图 | ❌ 一直挂起 | 不可用 |
| 窗口 `hide()` | ❌ 超时 | ❌ 一直挂起 | 不可用 |
| `display:none` 改成 `block` 后 | ✅ 9.8 KB / 1800×300 | — | **激活即可** |
| 窗口 `show()` 后 | ✅ 37 KB | — | **激活即可** |

补充：

- `Page.bringToFront` 对不可见的 webview 也会挂起，不能当兜底；
- `guest.invalidate()` 对不可见页面无效；
- `Page.captureScreenshot` 的挂起不会自己 reject，**必须加 2–3 秒超时**，否则整个工具调用会卡死；
- DPR=2，截图是 CSS 尺寸的 2 倍（900×600 → 1800×1200），返回给模型前要缩到合理大小。

### 2.5 对话框

```json
{"type":"alert","message":"hi","settled":true,"after":2}
```

先 `Page.enable`，监听 `Page.javascriptDialogOpening`，`Page.handleJavaScriptDialog({accept:true})`，`alert()` 的 evaluate 正常结束，后续 `1+1` 返回 2。

## 3. 对方案的修改

### 3.1 截图引擎

新增 `ScreenshotEngine`，规则：

1. **可见性检查**：窗口 `isVisible()`、Tab 是当前激活 Tab、guest 未被 `display:none`；
2. 不可见时：
   - 同一 Space 内 → 自动切到该 Tab（`tabs.select`），等两帧 + 100 ms，再截；
   - 窗口隐藏/最小化 → 返回 `window-not-visible`，提示用户恢复窗口；不自动弹窗抢焦点；
   - 后台 Space → 返回 `tab-not-visible`，让模型先 `browser_tabs({action:'select'})`，避免多 Space 互相抢画面；
3. 视口截图用 `guest.capturePage()`（比 CDP 稳），全页用 `Page.captureScreenshot({captureBeyondViewport:true})`；
4. 两个调用都包 **2.5 s 超时**；超时返回 `screenshot-timeout` + 当前 Tab 状态；
5. 输出：PNG + CSS 尺寸 + 像素尺寸；长边 > 1600 px 时等比缩到 1600，控制 token 与文件大小；
6. 截图时隐藏 Agent 高亮 overlay 和密码框内容。

### 3.2 Tab 模型

`Tab` 增加 `visible:boolean`、`lastPaintedAt`；`Space.activeTabId` 是唯一可见 Tab。  
`browser_screenshot` 的 `tab` 参数默认当前 Tab；要截后台 Tab，先显式 `browser_tabs select`。

### 3.3 错误码

新增：`window-not-visible`、`tab-not-visible`、`screenshot-timeout`。  
这三个错误都带“下一步建议”，例如“先 browser_tabs select t2”。

### 3.4 批量执行

`browser_batch` 里的 `screenshot` 步骤要求目标 Tab 可见；如果 batch 在后台 Space 跑，截图步骤直接失败并停，不会静默返回黑图。

## 3.5 M1/M2 冒烟结果（2026-11-11）

`scripts/browser-spike-controller.cjs` 走真实 webview → PageTarget → 工具层：

| 调用 | 结果 |
| --- | --- |
| `browser_navigate` | ok，`t1`，标题正确 |
| `browser_snapshot` full | 10 个节点 / 434 字符 |
| `browser_read` | 136 字符，标题正确 |
| `browser_wait` selector | 1 ms 命中 |
| `browser_act` fill `css=#q` | `value="world"`，diff `~ textbox value` |
| `browser_act` click `css=#go` | 点击成功，diff `+ text: done / - text: idle` |
| `browser_batch` fill + click | 2 步成功（273/264 ms），批末 diff 一次 |
| `browser_login` 后端（fake vault） | 6 项单测：保存、读取、origin 校验、锁定、密码不进表达式 |
| `browser_handoff` | 事件 `h1` 到达 renderer，`resume` 后工具返回 `resumed:true` |
| tab new/select/close | 2 个 tab（One/Two），active 切换、关闭后剩 1 个 |
| space 分组 | tab-3 指定 `space-2`，list 中 spaceId 正确；切回 default 后 tab-1 为 active |
| 自动技能 + 重放 | batch 后生成 `sk_946a2c4c`，`browser_batch({recipe})` 2 步成功 |
| 站点卡片 / 记忆镜像 | 3 项单测：landmarks、pathPattern、≤2 KB 摘要、memory 不可用 fail-soft |
| `browser_screenshot` | 40 KB PNG，路径可写 |
| `browser_tabs` list | 1 个活动 tab |

这证明“快照 → 动作 → diff”闭环在 Electron 45 上可用；下一步把它接到聊天 UI 的审批/接管上。

## 4. 对 M1 的输入

- `PageTarget` 必须维护 `visible` 状态（由渲染进程上报或主进程根据 `Space.activeTabId` 推导）；
- `ScreenshotEngine` 的激活/恢复逻辑要幂等，避免和用户手动切 Tab 打架；
- 全页截图可能很大（本例 5008 px 高），要限制最大高度（如 12000 px）并分片或缩放；
- AXTree 原始 JSON 约 12 KB/29 节点，真实页面 300 节点预计 100 KB+，**压缩器是 M1 的重点**；
- 动态内容必须靠 `wait` 再快照，不能假设“导航完成 = 内容就绪”。

## 5. 还没验证的

- DevTools 打开时 debugger 被 detach，重连是否稳定；
- 跨域 OOPIF 的 AXTree 与截图；
- `capturePage(rect)` 截单个元素的精度；
- 真实站点上的 AX 压缩比与 token 数；
- 多显示器 / 高 DPI 下的坐标映射；
- 最小化（不是 hide）时的截图行为。

这些放到 M1 的第一周补测，不阻塞核心链路。

## 6. 复现

```powershell
# 必须在普通 PowerShell 里运行；如果继承了 ELECTRON_RUN_AS_NODE，先移除
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\browser-spike.cjs
```

结果写入 `design/browser-spike/report.json` 和同目录 PNG。
