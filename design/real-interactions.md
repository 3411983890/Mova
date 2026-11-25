# 真实站点交互冒烟（2026-11-11）

> 脚本：`scripts/browser-real-interactions.cjs`  
> 数据：`design/real-interactions.json`  
> 环境：Windows / Electron 45.2.3 / Chromium 156.0.8078.80

## 方法

在真实 Electron + 真实 webview + 真实 CDP 上跑两个公开测试页：

1. **链接点击**：Selenium 测试站的 Web form → 点 “Return to index” → 等 URL 变 `index.html` → 页面标题为 “Index of Available Pages”；
2. **多字段表单**：同一测试站的 Web form → batch 填 text、textarea、select → 点 Submit → 等 `submitted-form.html` → read 包含 “Form submitted”；
3. **真实登录表单**：同一测试站的 `login.html` → 从 fake vault 取 `username/password` → `browser_login({submit:true})` → 页面 `alert` 返回 “successfully logged in”。

测试页是公开 Selenium 夹具，不写业务数据。

## 结果

| 任务 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| selenium-link-click | ✅ | 675 ms | ref 点击 + URL wait + 标题验证 |
| selenium-form | ✅ | 1,622 ms | 4 步 batch，填 3 个字段 + 提交 |
| selenium-login | ✅ | 242 ms | fake vault → 填 username/password → 提交 → alert 成功 |

```text
tasks: 3 / passed: 3 / successRate: 100%
```

## 顺带修掉的问题

表单提交时 `expect: {url: "submitted-form"}` 会在导航瞬间遇到：

```text
Inspected target navigated or closed
```

`wait.cjs` 之前会直接抛 `expect-failed`。现在把
`navigated or closed` / `Execution context was destroyed` / `Cannot find context`
视为导航中的瞬态错误，继续轮询新文档，而不是让整个 batch 失败。

登录任务还暴露了另一个问题：`Page.javascriptDialogClosed` 会在
`Page.handleJavaScriptDialog` 返回前清空 `this.dialog`，导致结果只剩
`{"handled":"accepted"}`。现在先复制 dialog 再发送命令，返回里保留
`type/message/prompt`。

## 限制

- 测试页是 Selenium 官方公开夹具，不是真实后台系统；
- 登录用 fake vault，没走真实保险柜 UI；验证码、下载、上传未覆盖；
- 网络和页面加载时间波动大；
- 只跑了 3 个任务，样本很小；
- `index.html` 的 body 由 GitHub API 异步填充，链接任务只断言 URL 和标题；此前“read 返回空”是这个异步页面导致的，不是正文提取失败。

## 复现

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\browser-real-interactions.cjs
```
