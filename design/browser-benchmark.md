# 浏览器 Agent 本地基准（2026-11-11）

> 脚本：`scripts/browser-benchmark.cjs`  
> 原始数据：`design/browser-benchmark.json`  
> 环境：Windows / Electron 45.2.3 / Chromium 156.0.8078.80

## 方法

- 一个真实 Electron 窗口 + 真实 `<webview>` + 真实 CDP，不走 mock；
- 本地 HTTP 夹具，12 个确定性任务；
- 通过和聊天相同的 `controller.tools()` 执行，统计每个任务的调用次数、返回字符数、耗时；
- 审批用 `approve: async () => 'once'`，避免 UI 等待；
- 多标签页走 `tabReady/tabActive` 协议。

## 结果

| 任务 | 结果 | 耗时 | 调用 | 返回字符 |
| --- | --- | --- | --- | --- |
| read-article | ✅ | 125 ms | 2 | 1249 |
| snapshot-controls | ✅ | 37 ms | 2 | 493 |
| click-and-expect | ✅ | 288 ms | 2 | 248 |
| site-search | ✅ | 580 ms | 4 | 702 |
| table-pagination | ✅ | 311 ms | 3 | 443 |
| js-batch | ✅ | 569 ms | 1 | 37 |
| batch-form | ✅ | 862 ms | 2 | 596 |
| dialog-auto-accept | ✅ | 288 ms | 2 | 371 |
| confirm-dismiss | ✅ | 301 ms | 3 | 538 |
| confirm-accept | ✅ | 279 ms | 4 | 566 |
| login-fill | ✅ | 244 ms | 3 | 530 |
| download | ✅ | 272 ms | 2 | 400 |
| upload | ✅ | 26 ms | 3 | 498 |
| upload-chooser（按钮弹选择器） | ✅ | 147 ms | 3 | 672 |
| iframe（同源） | ✅ | 450 ms | 3 | 673 |
| iframe-cross-origin | ✅ | 919 ms | 4 | 1020 |
| dual-account（隔离 Space） | ✅ | 506 ms | 9 | 1180 |
| background-space | ✅ | 147 ms | 9 | 1543 |
| smart-wait | ✅ | 759 ms | 2 | 140 |
| snapshot-diff | ✅ | 282 ms | 4 | 732 |
| tabs | ✅ | 124 ms | 5 | 563 |
| skill-replay | ✅ | 1075 ms | 3 | 960 |
| site-card | ✅ | 18 ms | 3 | 1039 |
| screenshot | ✅ | 57 ms | 2 | 243 |
| handoff | ✅ | 106 ms | 1 | 44 |

汇总：

```text
tasks:        25
passed:       25
successRate:  100%
calls:        81
chars:        15761
approxTokens: 3940
p50TaskMs:    300
actCalls:     11
p50ActMs:     287
```

## 解读

- 一次 batch 做 3 步（填两个字段 + 保存）只用了 2 次工具调用，返回 596 字符；
- 技能重放 3 次调用，包含自动学习/重放；命中技能时仍能一次 batch 完成；
- 快照 diff 只有 732 字符，而首屏全量快照约 500 字符量级（夹具很小，真实站点会放大差异）；
- 本地夹具的 100% 不代表真实站点成功率；真实站点还要处理登录、验证码、改版、反自动化。

## 覆盖与缺口

覆盖：读取、快照、真实点击、声明式批量、JavaScript 批处理、alert/confirm（accept 与 dismiss）、登录填充、文件下载、文件上传（直接 input / 按钮弹选择器）、同源/跨域 iframe、双账号隔离 Space、后台 Space 操作、等待、diff、标签页、技能重放、站点卡片、截图、人工接管。

动作级延迟：11 次 `browser_act`，P50 286 ms（含 120 ms 动作后沉降等待），低于 §19 的 300 ms 目标。

`background-space` 任务验证：Agent 通过 `space` 参数在后台 Space 导航/读取，前台 active Space 不变；截图仍然只对可见 Tab 有效。

跨域 iframe 的点击使用“在 iframe 自己的 context 里 `element.click()`”兜底；由于跨域无法读取 `frameElement` 的位置，坐标点击仍只对同源 iframe 精确。需要真实鼠标事件的跨域控件（canvas、自定义下拉）仍可能失败。

未覆盖（方案 §19 中剩余）：

- 首次登录“保存到保险柜”的 HTML 卡片交互（基准直接预置 fake vault）；
- 真实站点上的压缩比、成功率与反自动化差异；
- 12 个真实业务任务的完整基准（当前是本地夹具）。

## 登录卡 UI 端到端

`scripts/login-ui-check.cjs` 用远程调试驱动真实 Mova 渲染进程：

1. 打开右栏，输入本地登录页地址；
2. 点钥匙按钮，登录卡出现；
3. 填用户名/密码，取消“保存到保险柜”（避免写用户 vault）；
4. 提交 → 页面状态 `Welcome ada`，卡片自动关闭。

这验证了 HTML 卡片、IPC、主进程填充、页面提交整条链路，不只测后端。

## 复现

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\browser-benchmark.cjs
```

结果写入 `design/browser-benchmark.json`。
