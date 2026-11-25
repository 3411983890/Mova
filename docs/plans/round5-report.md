# 第五轮：登录后可用性 / 模型配置 / 运行日志

这一轮针对三件事：**设置页登录后卡住 + 切页白屏**、**订阅模型要像普通 provider 一样可配置**、
**给用户一套关掉软件后还能查的日志**。

## 1. 白屏：找到了确定的 bug

`app.js` 的 `selectSettingsPage()` 用 `settingsView.querySelectorAll('.settings-page')` 遍历**所有后代**并设 `hidden`。
「CLI 模型」页由 React 挂载，它的根节点**也带 `.settings-page` 类**（需要那套 padding 与滚动），但没有 id。

- 第一次进入：React 根还没挂载，只有容器被切换 → 正常。
- 切走再切回：React 根已经在 DOM 里，`.settings-page` 又命中它，`page.id !== 'settings-page-cli-models'` 成立
  → 它被 `hidden` 掉 → **整页空白**。

修法：只切换有 `settings-page-` 前缀的容器。

证据（`scripts/probes/.probe-settings-pages.cjs`，连开三次）：

| 次数 | 容器 hidden | React 根 hidden | 根高度 | 可见文字 |
| --- | --- | --- | --- | --- |
| 第一次 | false | false | 1913 | 1395 |
| 第二次（切走再回） | false | false | 1913 | 1395 |
| 第三次 | false | false | 1913 | 1395 |

截图：`assets/settings-cli-first.png`、`assets/settings-cli-second.png`。

## 2. 卡住：两个真因，都在日志里抓到了

先做了日志系统，第一次启动就抓到：

```
slow-ipc {"channel":"providers:list","durationMs":3515,"ok":true}
cli-probe {"ms":5294,"found":true,"version":null,"compatible":null,
           "command":"...\\antigravity\\antigravity.exe",
           "detail":"CLI 无法启动，版本未知（要求 ≥ 2.0.0）"}
```

### 2.1 `list()` 每次都在等 CLI 探测（5 秒级）

`listAll()` 以前 `await getCliStatus()`，而这条路要扫 PATH 再起子进程问版本。设置页首屏用 `pending` 驱动
`busy`（全页控件 `disabled`），登录又会连推十几条事件、每条都触发一次 `reload() → list()`。
结果就是：**首屏一直转圈，控件点不动**。

修法：
- `getCliStatus` 加 20s TTL 缓存 + 并发合并 + 3.5s 硬超时（以前每次都真探测）。
- `listAll()` **不再 await 探测**，只回已知结果（可能是 `null`）；探测落定后推一条 `kind:'cli'` 事件让界面重读。
- 探测版本号的超时从 5000ms 降到 1500ms（能答的 CLI 是毫秒级，答不上的再等也没用）。
- 安装时预热一次，第一次 `list()` 不必等。

修后同一台机器：`providers:list` 不再出现在 `slow-ipc` 里。

### 2.2 读不出版本号被当成「版本太旧」

`antigravity.exe --version` 在 Electron 主进程里 5 秒都不返回（GUI 程序），`probeVersion` 只能报
`exec_failed` → `version: null` → 旧代码 `isCompatible(null) === false` → 界面说「版本过旧」，
**并且把 Gemini 登录入口整个挡下来**。这是「CLI 明明装着却不能用」最可能的直接原因。

修法：读不出版本号时 `compatible` 留 `undefined`（未知），`cliStateOf` 新增 `present` 状态
（「找到了，但版本号读不出来」），登录闸门 `ready` 与 `present` 都放行；真不兼容会在 ACP 握手时报错。
界面上 `present` 显示「CLI 已找到（版本号读不出来）」，不再劝人重装。

### 2.3 顺带修的

- Gemini 登录的 IPC 会一直 pending 到用户授权完（可能几分钟）：渲染层只等 4.5s 的「已受理」确认，
  超时后交给事件推进，面板不再假装卡死。
- Gemini 登录以前**无法取消**（没有 flow 对象，`cancelLogin` 直接返回 false，CLI 还在后台等）：
  现在有 AbortController，取消会真的掐掉子进程，`dispose()` 也会。
- 所有会改数据的操作加 30s 上限（`busyRef` 是全局锁，一路 IPC 不回就会把按钮永久锁死）。
- 顺手清了 4 处 `$${...}`（模板字符串里多写了一个 `$`，界面上会显示「已恢复$3 个」）。

## 3. 订阅模型 = 一等公民

### 3.1 后端

新增 `electron/subscription-models.cjs`（CommonJS，可注入 fs/目录，无 electron 依赖）：

- 默认目录（ChatGPT / Gemini 各 3 个模型）+ `userData/subscription-models.json` 持久化（临时文件 + rename，0o600）。
- 校验规则与 `providers.cjs` 一致：id 形态、name ≤ 80、efforts 白名单 + 排序、contextWindow/maxTokens 范围、id 唯一、≤ 80 个。
- 读不到/坏文件回落默认目录并标 `recoveredFrom: 'missing'|'corrupt'`，不抛。
- `setAccountProbe`（登录态）与 `setModelProbe`（模型枚举）都是注入；`discoverModels` **绝不抛**。

`electron/providers.cjs` 改为从这里取目录，内置 provider 的视图新增
`configured / subscription{provider,accounts,email} / editable / removable`，并新增
`saveSubscription()` / `fetchSubscriptionModels()`。`setActive()` 现在认内置订阅 provider
（以前只查 `providers.json`，选中 ChatGPT 会被回滚成 `not_found`）。

### 3.2 「模型」页

- 订阅 provider 排最前，徽标写**订阅**，状态点表示「已登录/未登录」，没有「删除」。
- 未登录的卡片下面直接说明：*到「CLI 模型」页登录，登录完成后这里的模型才会出现在右下角的模型菜单里*。
- 「编辑」里只剩**显示名称 + 模型目录**（没有密钥、没有地址/协议——Gemini 根本没有 API 地址，
  给一个能改的 URL 框等于给假的编辑权）。
- 目录里每个模型可改：模型 ID、显示名称、多模态、思考强度（6 档）、上下文窗口、最大输出。
- 「获取可用模型」走订阅侧探测：Gemini 由 CLI 报，ChatGPT 目前无法枚举 → 如实回当前目录 + 一句说明。

截图：`assets/settings-models-subscription.png`、`assets/settings-models-subscription-edit.png`。

### 3.3 右下角模型菜单

- 按 provider 显示名称分组，组头就是「ChatGPT / Gemini / 本地网关」——用户要的「DeepSeek 的模型上面写 DeepSeek」。
- 模型名用**你在配置页写的显示名称**（`model.name`）。
- `configured === false` 的订阅通道**整组不出现**（过滤发生在 `flatModels()`，不是把数据删掉）。
- 组标题是往 shadow DOM 里插的 `div.mova-model-group`（vendor 每个模型项都带 `data-menu-item`，
  用它复原分组）。`SlidingMenuList` 自带 ResizeObserver，插入标题后选中高亮会自动重测位置。

## 4. 运行日志

`electron/logging/`（1 入口 + 5 模块）：

| 文件 | 作用 |
| --- | --- |
| `mova-YYYYMMDD-HHMMSS-<pid>.log` | 每次启动一个，JSONL，一行一条 |
| `latest.txt` | 最新日志文件名 |
| 目录 | `%APPDATA%\Mova\logs`（`MOVA_LOG_DIR` 可覆盖） |

用户关掉软件后：

```powershell
npm run logs              # 目录 + 最新文件 + 最后 80 行
npm run logs -- --errors  # 只看 warn/error 和卡顿
npm run logs -- --list
npm run logs -- --copy D:\tmp   # 复制出来发给别人
```

关键记录：

- `event-loop-hang` / `event-loop-lag`：主进程被同步操作堵住，带 `driftMs` 与 `phase`（卡在哪一步）。
- `slow-ipc`：某个 IPC 超过 1 秒，带 `channel` + `durationMs`。
- `ipc-error`：通道抛错，带 `error.code`，参数预览**已脱敏**。
- `cli-probe`：CLI 探测耗时与结论。
- `uncaught-exception` / `unhandled-rejection` / `render-process-gone` / `unresponsive` / `preload-error`。

脱敏：`authorization` / `cookie` / `code=` / `state=` / `access_token` / `refresh_token` / `sk-…` / JWT / 长 base64
全部替换成 `[redacted:N]`；邮箱掩码成 `so***@example.com`。写盘异步 + 退出 `flush(1200)` 有硬超时。

## 5. 验收

```
node --test        1578 例 / 通过 1572 / 失败 3（= 已知基线，与本次无关）
npm run typecheck  通过
npm run build      通过
Electron 启动      存活 18s+，日志正常落盘与 app-quit 收尾
```

新增测试：`tests/subscription-models.test.mjs`(26)、`tests/logging-*.test.mjs`(49)、
`tests/providers-subscription.test.mjs` 加 2 条（`setActive` 认订阅模型、未知 provider 仍拒绝）。

回归探针：

```powershell
node_modules\.bin\electron.cmd scripts\.probe-settings-pages.cjs   # 切页白屏
node_modules\.bin\electron.cmd scripts\.probe-models-page.cjs      # 订阅卡片与编辑器
node scripts\.probe-logging.mjs                                    # 日志落盘 + 脱敏 + 计时
node scripts\.probe-cli-locate.mjs                                 # CLI 定位结论
```

## 6. 已知但本轮未动的

- `memory:read` 冷启动 3.1s（记忆服务 start 未完成前的读），与本功能无关，日志里会被记成 `slow-ipc`。
- ChatGPT 侧没有可用的模型枚举接口，所以「获取可用模型」只能给内置目录 + 说明。
- `refresh-token` 轮换会改变 Gemini 的 `accountId`（旧问题，未动）。

---

# 第五轮·补丁 1（用真实日志定位）

用户跑 `npm run desktop` 后的操作日志被读到了。两条关键记录直接指认了问题：

```
cli-probe {"ms":1650,"found":true,"version":null,"compatible":null,
  "command":"C:\\Users\\34119\\AppData\\Local\\Programs\\antigravity\\antigravity.exe"}
subscription usage probe returned no data {"provider":"chatgpt","account":"5b27c86a","detail":"http_401"}
```

## 1. 命中的是 antigravity **桌面程序**，不是 agy CLI

`COMMAND_NAMES` 里同时搜 `agy` 和 `antigravity`，而 `%LOCALAPPDATA%\Programs\antigravity\antigravity.exe`
是**Electron 打包的桌面程序**：它不响应 `--version`（GUI 不退出），也没有 `acp` 子命令。

旧逻辑把它当 CLI 收下 → 后面每一步都注定失败：Gemini 登录 2.5 秒就退出、额度读不到。

修法（`cli.mjs`）：名字可疑（`antigravity*`）且读不出版本时，必须有**正面证据**——
`--help` 文本里出现 `acp`——才认；否则报 `cli_missing` 并说清看到的是哪个文件。
界面在「未安装」弹窗里也会写明这一点，不再让用户以为「明明装了却找不到」。

实测（`node scripts/probes/.probe-cli-locate.mjs`，2.4s）：

```
found: false, code: "cli_missing",
foundPath: "...\\Programs\\antigravity\\antigravity.exe",
detail: "找到 …antigravity.exe，但它既不响应 --version，帮助里也没有 acp 子命令：
         这是 antigravity 桌面程序，不是 agy CLI。请安装 antigravity CLI（agy）后再回来。"
```

探测预算从 15s 压到 2.4s（每步 1.2s 上限，帮助只试一次），而且在后台跑，`list()` 不等它。

## 2. ChatGPT 额度探测 401

`probeChatgpt` 以前把所有失败都收敛成 `probeFailed`，日志里看不出原因。现在失败快照带 `detail`
（`http_401` / `no_token` / `network` / `timeout`），日志里能直接看到。

拿到 401 之后：先**强制刷新一次令牌**再重探（本地 `expiresAt` 是推算的，可能不准）；
仍然 401 才把账号标成「需要重新登录」，并记 `subscription chatgpt usage unauthorised`。
比让界面永远转「读取额度失败」有用。

## 3. 同一账号能重复登录多次

身份以前只认 JWT 的 `sub`。一旦 id_token 里没有 `sub`（或验签失败退回本地解码拿到空值），
就退化成 `hash(access_token)`——而 access token 每次登录都换，于是每登录一次多一条账号。

修法：身份按稳定度排序 `sub → chatgpt_account_id → 邮箱 → 令牌指纹`；
同账号再次登录**覆盖**同一条记录（记 `subscription account relogin`），不再抛 `duplicate_account`。

## 4. `--copy` 报 `mkdir '\\?'`

用户的复制目标是 `D:\mova-logs`，而这台机器**只有 C 盘**。Node 往不存在的盘 mkdir 只会丢出
`ENOENT … mkdir '\\?'`（长路径名空间的残骸），完全看不出是「D 盘没有」。

修法：先检查盘符是否存在，报「目标盘不存在：D:\ / 这台电脑现有的盘：C:\ / 换一个位置，
例如 `npm run logs -- --copy .\mova-logs`」；成功时把同一次运行的**所有分段**（`-2`、`-3`）一起复制。

## 5. 新增/更新的测试

- `tests/subscription-cli.test.mjs` +2：拒绝桌面程序、`--help` 里有 acp 则接受。
- `tests/subscription-usage.test.mjs`：失败快照必须带 `detail`。
- 保持 1574 通过 / 3 基线失败。

