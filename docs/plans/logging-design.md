# Mova 运行日志（electron/logging）

目标只有一个：**用户关掉软件之后，凭日志能回答「哪里报错了、哪里卡住了」**。
不是为了做可观测性平台，所以刻意不引依赖、不上传、不采指标。

## 文件与位置

| 位置 | 说明 |
| --- | --- |
| `%APPDATA%\Mova\logs\`（= `app.getPath('userData')/logs`） | 日志目录。可用 `MOVA_LOG_DIR` 覆盖（覆盖的是**最终目录**，不会再拼一层 `logs`） |
| `mova-YYYYMMDD-HHMMSS-<pid>.log` | 每次启动一个文件，JSONL，一行一条记录 |
| `latest.txt` | 只有一行：最新日志的文件名。收集脚本靠它定位 |
| `mova-…-2.log`、`-3` | 单文件超过 8MB 后的分段 |
| 清理 | 启动时只保留最近 20 个文件，并删掉 14 天前的（正在写的那个永远不删） |

格式（每行一个 JSON）：

```json
{"t":"2026-11-13T22:30:16.845+08:00","level":"warn","scope":"app","msg":"slow-ipc","channel":"providers:list","durationMs":8500,"ok":true}
```

时间带本地偏移，`Date.parse` 可直接解析；`level` 取值 `trace|debug|info|warn|error|fatal`。

## 怎么用（用户报错时的三步）

```bash
npm run logs                 # 打印目录 + 最新文件 + 最后 80 行（人类可读）
npm run logs -- --errors     # 只看 warn / error / fatal 和卡顿记录
npm run logs -- --list       # 列出所有日志文件（大小、时间）
npm run logs -- --copy D:\tmp # 把最新日志复制出去，方便发给别人
```

排查顺序：先 `--errors`。看到 `event-loop-hang` 就是主进程被同步操作堵住了（`phase` 字段指出堵在哪一步）；
看到 `slow-ipc` 就是某个 IPC 通道慢（`channel` + `durationMs`）；看到 `ipc-error` 就是那个通道抛了错（`error.code`）。

## 设计取舍

**为什么是 JSONL。** 排查时真正想要的是 `grep '"channel":"subscription:list"'` 和「按 level 过滤」。
纯文本格式两面都不讨好；JSONL 还能在崩溃截断时保住前面完整的行。

**为什么写盘必须异步。** `appendFileSync` 在每次日志上都同步一次磁盘，正好会制造我们想抓的那种卡顿。
`sink` 内部是一条串行队列，退出时 `flush(1200)` 有硬超时——写不完就算了，不能让退出挂住。

**为什么看门狗用 drift 而不是只看 `monitorEventLoopDelay`。**
直方图只能告诉你「这段时间延迟统计变差了」，说不清是哪一次、卡在哪一步。
`setInterval` 的**实际触发间隔与预期间隔之差**是 O(1) 的一次减法，还能带上 `phase`（最近一次 `markPhase` 的值）：
「`driftMs: 4000`、`phase: subscription:list`」直接指认现场。两者并用：drift 抓单次大阻塞，直方图抓
「每次只慢 200ms 但一直慢」的漂移。

**为什么 IPC 计时用打补丁而不是逐个改 handler。**
`main.cjs` 里注册了几十个 `ipcMain.handle`，逐个包会漏、会和后续改动脱节。
`installLogging()` 在其它模块之前替换 `ipcMain.handle`，之后注册的每一个通道自动带上计时；
`PATCH_STATE` 符号保证重复安装不会嵌套。补丁**不改变 IPC 语义**：返回值原样透传，异常原样重抛。

**为什么必须脱敏。** 订阅通道的参数里有 `code`、`authorization`、`refresh_token`。
`redact.mjs` 按「header 名 / query 名 / 已知密钥前缀 / 长 base64」四类规则替换，连参数预览也先脱敏再截断
（顺序不能反：先截断会把令牌切一半，就不再匹配任何规则了）。邮箱保留但掩码成 `so***@example.com`——
排查要知道是哪个账号，但不能把完整邮箱发给别人。

## 接线（`electron/main.cjs`，已完成）

```js
// 顶部 require 区之后，必须早于其它模块注册 IPC handler
const { installLogging, installRendererLogging, getLogger } = require('./logging/index.mjs');
let appLogging = null;
try {
  appLogging = installLogging({ app, ipcMain });
} catch (error) {
  console.warn('logging unavailable', error?.message || error);
}
const log = appLogging?.logger ?? getLogger('app');

// createWindow() 里，BrowserWindow 创建之后
installRendererLogging(win, log);

// app.on('before-quit') 末尾
log.info('app-quit', { uptimeMs: Math.round(process.uptime() * 1000) });
void appLogging?.flush(1200);
```

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/logging-redact.test.mjs` | 脱敏规则、邮箱掩码、不误伤普通字段 |
| `tests/logging-logger.test.mjs` | JSONL 行格式、级别过滤、`span` 成功/失败 |
| `tests/logging-rotate.test.mjs` | 8MB 换段、20 个/14 天清理、`latest.txt`、真实落盘 |
| `tests/logging-watchdog.test.mjs` | drift 判定、phase 字段、连续卡顿、stop 后静默 |
| `tests/logging-ipc-trace.test.mjs` | 语义不变、slow-ipc、异常原样抛、幂等、restore 身份 |

端到端自检（临时目录里真写盘、真脱敏、真计时）：

```bash
node scripts/probes/.probe-logging.mjs
```

## 已知边界

- 渲染进程只上报 `warning`/`error` 级 console 与崩溃、无响应事件；`console.log` 不进日志（噪音太大）。
- 日志不跨会话合并：一次运行一个文件，不追加到同一个文件里。
- 没有上传、没有远程收集。用户要给你日志，用 `--copy` 复制出来。
