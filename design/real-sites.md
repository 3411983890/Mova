# 真实站点只读冒烟（2026-11-11）

> 脚本：`scripts/browser-real-sites.cjs`  
> 数据：`design/real-sites.json`  
> 环境：Windows / Electron 45.2.3 / Chromium 156.0.8078.80 / 系统网络

## 方法

- 真实 Electron 窗口 + 真实 `<webview>` + 真实 CDP；
- 每个站点只做：`navigate` → `snapshot(full)` → `read`；
- 不点击、不写入、不登录；
- 成功条件：读取结果或页面标题包含预期短语。

## 结果

| 站点 | 结果 | 耗时 | 快照字符 | 正文字符 |
| --- | --- | --- | --- | --- |
| example.com | ✅ | 760 ms | 1,029 | 916 |
| iana.org/help/example-domains | ✅ | 10,731 ms | 3,509 | 791 |
| developer.mozilla.org Fetch API | ✅ | 2,139 ms | 13,601 | 2,831 |

```text
sites:        3
passed:       3
successRate:  100%
```

## 观察

- example.com 会按地区返回中文正文，但标题仍是 `Example Domain`；成功判断同时看标题和正文。
- IANA 首包较慢（10.7 s），页面本身很小；导航超时给 45 s 是必要的。
- MDN 正文快照 13.6k 字符，read 只取 2.8k，说明“读内容用 read、找控件用 snapshot”的分工有效。
- Wikipedia 在当前网络下 `ERR_CONNECTION_RESET`，属于网络环境问题，不是解析失败；基准里换成了 IANA。

## 限制

- 只读，不覆盖登录、点击、表单、下载、验证码；
- 3 个站点都是简单公开页，不代表后台系统；
- 未测量反自动化、弹窗、cookie 同意横幅等真实干扰；
- 网络耗时波动大，单次结果不能当作性能基准。

## 复现

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\browser-real-sites.cjs
```
