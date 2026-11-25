# 一次性探针脚本（scripts/probes/）

> 结论先说：**这里的东西不进测试门禁，随时可以删。**

## 这是什么

本目录是「为了看一眼现象」而写的一次性脚本，来源有两个：

1. 原 `qa/` 目录下的验收探针（CDP 截图、设置页抽查、遮挡复现、账号/模型菜单检查…）；
2. 原 `scripts/` 根目录下 `.probe-*`、`.fake-*`、`browser-spike*`、`deepseek-*` 这类临时复现脚本与 Chromium 假 preload。

它们的共同点：**依赖真实 Electron 窗口、真实 `agy`/CLI 进程、真实浏览器或真实截图输出**，
所以按 `docs/conventions.md` §4 不能进 `node --test`（测试只跑纯内存 fake）。

## 使用前提

- 这些脚本大多假定仓库根为工作目录，并会启动 Electron / 打开真实窗口 / 写截图；
  跑之前先确认没有正式实例在运行，避免抢同一个用户数据目录。
- 输出（`*.png`、日志）不再回写到仓库里：原 `qa/` 下的 142 个截图/视频/日志已在 2026-11-14 的结构整理中删除，
  需要留档时请写到仓库外层目录。
- 脚本里写死的相对路径按「从仓库根执行」解析，例如 `node scripts/probes/probe-menu-shot.mjs`。

## 该不该往这里加新脚本

- 只是本次排查想看一眼 → 放这里；
- 有明确复跑价值、希望能被反复执行的检查 → 放 `scripts/` 根（例如 `browser-benchmark.cjs`、`design-*-check.cjs`、`desktop-*-smoke.cjs`）；
- 想要长期守住的行为 → 写成 `tests/*.test.mjs` 的纯函数断言。

## 已知会失败/需要环境的脚本

这些脚本不是回归项，跑不通不代表仓库坏了：`browser-spike*`（需要 Edge/CDP 附加）、
`deepseek-*`（需要本地服务与凭据）、`.fake-*-preload.cjs`（是 preload 替身，由别的探针通过参数注入加载）。

## 少数「离线且值得反复跑」的探针

`probe-session-persistence.mjs`（临时 DB 跑会话持久化）、`probe-memory-read-timing.mjs`、
`probe-prompt-injection.mjs`（两条订阅链路的提示词原文，全部请求用假 fetch 截住，不要账号也不要 VPN，
产物写到 `.test-temp/prompt-probe/`，结论见 `docs/prompt-injection.md`）不需要真实窗口或凭据。
