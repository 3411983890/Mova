# Mova 项目权限设计

> 版本：0.1｜对应实现：`electron/permissions.cjs`、`electron/agent-tools.cjs`
>
> **现状提醒（2026-11-11）**：权限设置界面（`src/features/permissions/`）已整体移除，本文描述的是底层权限模型与目标交互；界面恢复前，逐文件夹的能力授予暂时没有渲染层入口，审批级别仍由输入框左侧的三档切换。

> 本文描述 CodeMova 的本地文件与命令权限模型：谁能授权、模型能做什么、边界在哪里、出问题怎么查。

## 1. 目标与原则

CodeMova 要能在用户的项目里真实读写文件、执行命令。这带来三个必须同时满足的要求：

1. **模型不能自己扩大权限。** 权限只能由用户在系统级对话框里确认。
2. **权限必须按文件夹收敛。** 授权是"这个文件夹的读取"，不是"这台机器的读取"。
3. **每一次操作都要可解释、可追溯、可撤销。** 用户要能看到模型做了什么，并且随时收回。

对应四条实现原则：

| 原则 | 落地方式 |
| --- | --- |
| 渲染层不可信 | 权限状态只在主进程；渲染层只能读，不能自行授予 |
| 授权有物理锚点 | 扩权与写/命令审批都走原生 `dialog`，绕过渲染层无效 |
| 默认拒绝 | 登记文件夹不等于授权；读取、修改、执行分别默认关闭 |
| 失败透明 | 拒绝、越界、超时都作为工具结果返回给模型，不允许静默重试或谎报成功 |

## 2. 信任边界

```text
┌──────────────────────────────┐
│ 渲染层（不可信）              │  React 设置页、聊天记录、请求参数
│  · 只能携带 rootId（不透明）  │  · 不能携带绝对路径
│  · 不能授予权限               │  · 不能批准写/命令
└──────────────┬───────────────┘
               │ IPC（senderWindow 校验 + 通道白名单）
┌──────────────▼───────────────┐
│ 主进程（可信）                │
│  · permissions.json           │  唯一权威状态，0600
│  · permissions-audit.jsonl    │  追加式审计
│  · 原生 dialog 确认           │  授权 / 单次批准 / 会话批准
│  · 路径解析 + realpath 校验   │  越界与链接逃逸拦截
└──────────────┬───────────────┘
               │ 工具调用（每次重新校验权限）
┌──────────────▼───────────────┐
│ 项目文件夹（用户授权范围）     │  list / read / write / replace / run
└──────────────────────────────┘
```

关键点：

- 文件夹**只从原生选择器登记**（`projects:pick-folders`），渲染层拿到的只是 `{ id, name, path }` 元数据。
- 请求里只允许出现 `projectRootIds`（不透明 id）。主进程用自己的登记表把 id 映射成路径，渲染层无法用伪造路径指向别处。
- 每次工具调用都重新读权限存储，**不是**在会话开始时就固定下来。撤销在下一调用立刻生效。

## 3. 能力模型

三种能力，按文件夹独立授予：

| 能力 | 允许的工具 | 默认 | 额外确认 |
| --- | --- | --- | --- |
| `read` | `list_files`、`read_file`、`search_files`、`git_status`、`git_diff`、`list_changes` | 关闭 | 无（授权时的原生对话框即确认） |
| `write` | `write_file`、`replace_in_file`、`undo_change` | 关闭 | 每次操作应用内确认，直到开启"自动接受" |
| `exec` | `run_command` | 关闭 | 每次操作应用内确认，直到开启"自动接受" |

依赖规则：**开启 `write` 必须先有 `read`**，否则模型会在看不到内容的情况下覆盖文件；撤销 `read` 会连带撤销 `write` 与它的自动接受。`exec` 不依赖 `read`（命令输出本身就是观察结果）。

`git_status` / `git_diff` 归在 `read` 下：它们用固定参数（`git status`、`git diff`）直接 `execFile`，不经过 shell，也不带模型输入，属于只读观察，因此不逐次确认。写操作（`git commit`、`git checkout`）仍要走 `run_command` 的 `exec` 审批。

### 3.1 单轮预算

**次数不受限**：工具调用、写入、命令都没有"每轮 N 次"的上限，也没有"最多 N 轮模型回合"的上限。原因是真实编码任务的形状就是 `读 → 改 → 跑测试 → 再改`，卡在 16 轮或 20 次写入会让任务在半路硬停。循环的终点只有三个：模型自己不再调用工具、用户点停止、输出预算耗尽。

保留的只有**输出预算**，它不是策略而是模型上下文：

| 限制 | 值 | 作用 |
| --- | --- | --- |
| 单个工具结果 | 40k 字符 | 一次 `read_file` / `git_diff` 不会顶爆上下文 |
| 单轮工具输出 | 200k 字符 | 多次读取的累计上限，超出返回 `tool_limit` 并结束本轮 |
| 总输出预算 | 1MB | 与文本流共用，超出即中止本轮 |

超限作为正常的工具结果回给模型（能看到"输出太多，请缩小范围"），不是静默截断，也不是静默继续。代价说明：没有次数上限之后，**唯一能阻止一次跑飞的刹车是停止按钮和每一次写入审批**——这也是为什么审批默认不自动接受。

两个开关维度：

- **能力开关**：是否允许这一类操作。开启必须经过原生对话框（显示完整文件夹路径）。
- **自动接受**（仅 write / exec）：跳过逐次确认。开启同样要原生确认，并明确告知"不再逐次询问"。

会话级授予：在单次确认对话框里选择"本次会话允许"，会在内存中记住 `(窗口, 文件夹, 能力)`，直到窗口刷新或导航离开。它不落盘，重启即失效。

## 4. 授权流程

### 4.1 登记

```text
用户点「添加文件夹」→ 原生选择器 → projects:pick-folders
  → 返回元数据 → 同时写入 permissions.json（三种能力全部 false）
```

登记只是让这个文件夹出现在「设置 → 权限」里。**登记本身不授予任何访问权。**

历史项目（该功能之前创建的）不会自动登记，会在设置页显示为"尚未登记"，由用户点「登记文件夹」补登记。

移除项目时，属于该项目、且没有其他项目引用的文件夹会被 `forget`：权限与登记一并清除。忘记只能收窄权限，所以不需要确认。

重新登记一个**已授权**的文件夹会先问一次「保留之前授予的权限？」——因为授权是按文件夹路径记的，不按项目，否则"删掉项目再建一个指向同一目录的项目"就能绕过扩权确认。选择重置会把三种能力和自动接受全部关掉。

「移除登记」是彻底删除这条记录（`permissions:forget`），之后重新添加需要重新授权。

### 4.2 授权

```text
设置 → 权限 → 打开「读取文件」
  → permissions:set
  → 主进程 dialog.showMessageBox（显示完整路径）
  → 用户点「允许」→ capabilities.read = true → 写盘 + 审计
```

拒绝时返回 `{ ok: false, error: 'denied' }`，状态不变。

### 4.3 单次操作

```text
模型调用 write_file
  → 工具层 resolveTarget（路径校验）
  → permissions.authorize({ capability: 'write' })
      ├─ 未授予 write → 直接拒绝，审批条不会出现
      ├─ 会话已允许 → 放行
      ├─ 自动接受已开 → 放行并审计
      └─ 否则主进程通过 approval:request 发给渲染层
           输入框上方出现审批条：拒绝 / 允许一次 / 本次会话允许
           渲染层 approval:respond → 主进程放行或拒绝
  → 通过后才真正写盘
```

**为什么单次砍价不用系统对话框**：原生 `showMessageBox` 是窗口级模态，跑一次"读→改→测"会连弹好几个，取消运行时对话框也无法用代码关闭，只能一直挂在屏幕上。所以：

- **授予能力**（把某个文件夹的 `read`/`write`/`exec` 打开）→ 仍然是原生对话框，这是唯一能扩大权限的入口；
- **单次写入 / 命令**（已经授权范围内的一步）→ 应用内审批条，主进程按 `webContents` 校验归属、120 秒无响应自动拒绝、运行取消或页面导航时自动关闭。

审批条内容是**具体动作**而不是抽象权限：写入显示目标路径和字节数，修改显示行级 diff（预览内容每侧最多 300 行 / 100k 字符），命令显示命令行和工作目录。渲染层可以自动应答（这是该方案的已知代价），但它无法改变已授予的能力范围——扩权仍然只能走原生对话框。

**审批级别与范围（2026-11-12 调整）**：`请求批准` / `替我审批` 只影响逐次确认，范围仍是当前项目的已授权文件夹。选中 `完全访问权限` 时，本轮请求会带上**所有已登记的项目文件夹**（跨项目、跨模式），并在归一化时把 `read/write/exec` 全开、命令不再逐次确认；文件工具仍只接受已登记文件夹内的路径（`resolveInside` 护栏保留），**不会**因此获得任意磁盘路径。shell 命令本来就不受路径护栏约束，授予 `exec` 等于把这份信任交给模型。

### 4.3.1 取消语义

取消必须是硬的，三层都要断：

1. `model:cancel` 中止本轮请求，并让审批 broker 立即取消该窗口所有待批请求（审批条随即消失）；
2. broker 绑定本轮的中止信号，用户点停止时挂起的审批直接按"拒绝"结算；
3. 工具在 `await authorize(...)` 返回后**再检查一次**中止状态，并在路径锁内、真正落盘前再核对一次（顺带核对能力是否已被撤销），已取消则抛错、不落盘、不启动命令。

任何一层单独存在都不够：只做 1/2，用户仍可能在条消失前点中"允许"；只做 3，审批条会滞留 120 秒。

### 4.4 撤销

每次写入**成功后**把修改前内容存进 `userData/file-history/<rootId>.json`（最近 60 条、总量 4MB 上限）。记录和写入在同一个路径锁内完成，所以并发写入不会让 `before` 指向别人的内容；代价是进程若在"写入成功、记录落盘"之间崩溃，那次修改无法撤销（结果里会带 `historyWarning`，而不是假装可以撤销）。`changeId` 随写入结果返回给模型：

```text
write_file → { path, bytes, created, changeId }
replace_in_file → { path, replacements, bytes, changeId }
undo_change({ changeId }) → 恢复修改前内容（若该文件是那次新建的，则删除）
```

撤销自身也是一次写入：要 `write` 能力、要审批、也会记入历史，所以可以再撤销一次。`list_changes` 用来找较旧的 `changeId`。

撤销前会先比对当前内容与那条记录的 `after`：**不一致就返回 `conflict` 并且什么都不写**。否则"撤销一个旧修改"会把之后的所有编辑一起抹掉。要强行回到旧内容，就先读文件再 `write_file`，这样审批条显示的才是真实的"当前内容 → 目标内容"。

同一文件的并发写入按绝对路径串行化（两条 run 同时改同一个文件时不会交错写坏），不同文件仍然并行。审批基于某一份内容；真正落盘前会在锁内重新读取并比对哈希，与审批时不一致就返回 `conflict` 且不写（审批条显示的预览因此永远不会与实际写入的内容不一致）。

## 5. 路径与执行边界

`resolveInside(rootPath, relativePath)` 是所有文件操作的唯一入口：

| 拦截 | 说明 |
| --- | --- |
| 非字符串 / 空 / 含 NUL | `invalid-path` |
| 绝对路径、盘符、UNC | `absolute-path` |
| `..` 段（含 `a/../../b`） | `path-escape` |
| 归一化后不在根下 | `path-escape` |
| 真实路径（跟随 junction / symlink）不在真实根下 | `path-escape` |
| 目标不存在且不允许新建 | `not-found` |
| 根不存在或被移动 | `root-missing` |
| 任一段含 `:`（NTFS 备用数据流） | `invalid-path` |
| Windows 上段尾为 `.` 或空格、或为 `CON`/`NUL.txt`/`COM1` 等设备名 | `invalid-path` |

最后三条是 Windows 特有的"同一路径字符串实际指向别处"的情况：`a.txt:stream` 写的是备用数据流（资源管理器里看不见），`a.txt.` 会被抹掉尾点写到 `a.txt`，`CON` 会命中设备。全部按拒绝处理，而不是试图猜用户意图。

写入额外限制：

- `.git` 内部文件禁止写入（`protected-path`），避免模型破坏版本库。
- 写入走"临时文件（随机名）+ rename"，并保留目标原有权限位。
- 写入单文件上限 4 MB，单次写入上限 512 KB 字符，单次读取结果上限 40 KB 字符（超出用 `startLine` / `endLine` 分段）。
- **读取没有 4 MB 墙**：≤4 MB 的文本整份读取；更大的文件按行范围流式读取（`createReadStream`，只保留请求的行），单次仍是 40 KB 字符；超过 512 MB 才直接拒绝，避免拖死主进程。
- **二进制不再拒绝**：按魔数识别 PNG/JPEG/GIF/WebP/BMP/PDF/ZIP/7z/gzip/wasm/ELF/Mach-O/PE，返回 `binary:true`、`mime`、`bytes`、前 4 KB 的 `excerptBase64`，以及最多 40 条可打印片段（类似 `strings`）。二进制文件不能被 `write_file` / `apply_changes` 覆盖（没有可撤销的文本快照），要替换先 `delete_path`。

命令执行（**不是沙箱**）：

- 工作目录固定为已授予 `exec` 的项目文件夹，Windows 用 `cmd /d /s /c`，其它平台用 `/bin/sh -c`。
- 命令以用户账户权限运行：可以读写项目文件夹之外的文件、访问网络、启动其它进程。路径护栏只约束文件工具，约束不了 shell 里的命令；授予 `exec` 等于把这份信任交给模型。
- 默认超时 60 秒，上限 120 秒；超时用 `taskkill /T /F` 杀掉整棵进程树。
- stdout / stderr 各截断到 64 KB，超出标记 `truncated`。
- 审批通过后、启动 shell 前会再核对一次 `exec` 能力和中止状态，所以审批期间撤销能力同样能拦住命令。

## 6. 工具清单

| 工具 | 能力 | 参数 | 结果 |
| --- | --- | --- | --- |
| `list_files` | read | `path?`、`depth?` (1–3) | `entries[]`（root、path、type、size），跳过 `.git` / `node_modules` / `.mova-backups` |
| `read_file` | read | `path`、`startLine?`、`endLine?` | 文本：`content`、`totalLines`、`truncated`，>4 MB 走流式（`streamed:true`，可能 `totalLines:null`）；二进制：`binary:true`、`mime`、`bytes`、`excerptBase64`、`strings[]` |
| `search_files` | read | `query`、`path?`、`regex?`、`ignoreCase?`、`maxResults?` | `matches[]`（root、path、line、text）；`path` 可以是文件或目录（目录会递归搜索）；默认字面量；超过 8 MB 的文件会跳过并返回 `skippedTooLarge` 计数，不再静默漏搜；含嵌套量词的常见回溯爆炸形态（`(a+)+`）直接拒绝——这是启发式拦截，不是完备的 ReDoS 防护 |
| `git_status` | read | `path?` | `branch`、`entries[]`、`clean`（`--porcelain=v1 --branch`）；多文件夹项目会依次尝试，直到找到仓库 |
| `git_diff` | read | `path?`、`staged?` | `diff`（unified=3，40k 字符上限）；同上，多文件夹按顺序尝试 |
| `list_changes` | read | `limit?` | 最近修改的 `changeId` 摘要（不含内容） |
| `project_tree` | read | `path?`、`depth?` (1–4)、`maxEntries?` | 有界目录树快照（`tree`、`truncated`、`ignored`、`errors`）；跳过 `.git`/`node_modules`/`.mova-backups` 与符号链接 |
| `find_symbol` | read | `name`、`kind?`、`path?`、`maxResults?`、`ignoreCase?` | `definitions[]` / `references[]`（root、path、line、text）；纯字面量匹配，不接正则 |
| `write_file` | write | `path`、`content` | `bytes`、`created`、`changeId` |
| `replace_in_file` | write | `path`、`oldText`、`newText?`、`all?` | `replacements`、`changeId`；原文缺失或多次匹配报错 |
| `delete_path` | write | `path`、`recursive?` | `deleted`、`files`、`bytes`、`changeId`/`changeIds`；文件删除需可快照（≤4 MB、非二进制），文件夹需 ≤50 个文件、合计 ≤2 MB、内部无 `.git` |
| `move_path` | write | `from`、`to`、`overwrite?` | 同项目文件夹内的重命名/移动；文件可撤销，文件夹移动写明不可撤销；跨文件夹报 `cross-root-move` |
| `apply_changes` | write | `changes[]`（1–20，`{path, content}` 或 `{path, oldText, newText, all?}`） | 一次审批写多个文件：先全量校验，再在锁内核对全部哈希，然后逐个写入；失败时回滚已写文件并回报 `rollbackFailed` |
| `undo_change` | write | `changeId` | `restored`；恢复、重建（删除类）或删除（新建类） |
| `run_command` | exec | `command`（shell 行，≤2000 字符）**或** `argv`（`[程序, ...参数]`，不经 shell）、`shell?`、`path?`、`timeoutMs?` | `exitCode`、`stdout`、`stderr`、`timedOut`、`truncated`、`encoding` |

工具只在对应能力被授予时才出现在模型的工具列表里——模型看不到自己无权执行的动作，这比"调用了再报错"更可靠。

多文件夹项目：路径可以写成 `文件夹名/相对路径`；不写前缀时，工具会在所有可用文件夹里查找，命中唯一一个才执行，命中多个返回 `ambiguous-path`，绝不猜。`path: "."`（以及 `"./"`、`".\\"`）等同于省略，表示项目文件夹本身——模型常这么写，过去会被 `resolveInside` 当作非法路径段报 `invalid-path`；`..` 仍然按 `path-escape` 拒绝。只读检索类工具（`list_files`、`search_files`、`project_tree`、`find_symbol`、`git_status`、`git_diff`）在省略或传 `.` 时覆盖所有可读文件夹，传具体子路径时只看那一个。

### 6.1 `run_command`：两种写法、长度上限与输出编码

- `command` 是一整行，交给 `cmd.exe /d /s /c`（Windows）或 `/bin/sh -c`（其他平台）。引号、空格、`%`、`!`、`^`、`$` 都先由 shell 解释一遍，嵌套引号很容易碎——这正是过去 `-e` / `-c` 类内联脚本不可用的原因。两个 Windows 特有的坑已经堵上：Node 默认会按 C 运行时的"反斜杠转义引号"规则重新加引号，而 cmd 不认这条规则，于是 `node -e "console.log(2+2)"` 到 node 手里变成一段语法破碎的脚本——退出码 0、stdout 空，静默错误；现在用 `windowsVerbatimArguments` 原样把整行交给 cmd，并在外层多包一对引号（`cmd /s` 会剥掉首尾各一个引号），所以以引号开头的行——例如 `"C:\Program Files\nodejs\node.exe" -e "…"`——也不会再被剥掉首引号而变成 `'C:\Program' 不是内部或外部命令`。
- `argv` 是 `[程序, ...参数]`，用 `shell: false` 直接 spawn，参数原样到达进程，没有引号地狱：`["node", "-e", "console.log('a b')"]` 里的脚本不需要任何转义。`command` 与 `argv` 只能二选一；`shell: false` 必须配 `argv`（`command` 本身就是交给 shell 的一行），`shell: true` 配 `argv` 直接报错。`dir`、`echo`、`copy` 这类 cmd 内置命令和 `.cmd` / `.bat` 脚本在 Windows 上没有可执行文件，仍要用 `command`——用 `argv` 调用会得到一句"找不到可执行文件 / 请改用 command"的提示，而不是一句系统错误。
- 长度：`command` 上限 **2000 字符**（cmd 自身 8191，但审批条要能看清一整行），`argv` 单项 8000、合计 16000、最多 64 项（仍远低于 CreateProcess 的 32767）。这两种上限都**不再写进 JSON Schema**，而是在执行前检查：超限返回 `command-too-long` 并说明"拆成多条，或用 argv 把脚本交给解释器"，而不是让模型收到一条把整条命令回显一遍的 `Validation failed for tool` 报错。
- 输出编码：先按严格 UTF-8 解码；失败再按 Windows 控制台代码页转成 UTF-8（`chcp` 检测一次并缓存，中文系统常见 936 → `gbk`；`MOVA_COMMAND_ENCODING` 可覆盖，填代码页数字或 WHATWG 编码名）。返回的 `encoding` 说明 stdout 用了哪一种。Node、Git、Python 写 UTF-8 的进程照原样透传，只有 cmd 内置命令的 GBK 回显需要这一次转码。
- 输出预算（背压）：每条流**只回 8000 字符**——开头 2000 字符 + 结尾 6000 字符，中间换成 `…（中间已省略 N 字符）…`，`truncated: true`。字节侧同样有界：头部 64 KB + 滚动尾部 64 KB，30 万行、上百 MB 的构建日志不会先整个读进内存再截断。之所以要卡在 8000 而不是 64k：`chat-agent.mjs` 的单条工具结果上限是 40k 字符，而工具结果是 JSON（换行会转义成两个字符），一旦超过 40k，被砍掉的是 JSON 的尾巴——`truncated` 字段本身都没了，模型只看到半截 stdout，还以为那就是全部。需要完整输出时把命令输出重定向到文件，再用 `read_file` 按行读。

## 7. 系统提示

有文件工具时，系统提示会：

- 列出可用的项目文件夹名（**不发绝对路径**，避免把本机用户名路径带进模型上下文）；
- 要求"只报告工具真实返回的结果"，拒绝和失败必须如实说明；
- 要求"破坏性或大范围操作先解释再执行"。

没有工具时保留原来的硬约束（不能访问本地文件、终端、电脑），防止模型凭空声称已经改过文件。

## 8. 事件与界面

工具调用通过 `model:delta` 推送 `{ type: 'tool', id, name, label, status, detail }`：

- `running` → 聊天记录里显示"列出文件 · src/"，状态"执行中"；
- `done` / `error` → 显示结果摘要（行数、字节数、退出码）；
- `denied` → 显示拒绝原因，图标变为错误态。

中断（用户停止、刷新、进程退出）会把仍为 `running` 的行标记为"上次操作已中断"，不会留下假的"执行中"。

审批条独立于聊天记录，挂在输入框上方（`#approval-host`），一次显示一个请求，多余请求排队并显示"还有 N 个请求"。工具栏显示动作类型徽标（修改文件 / 删除文件 / 移动文件 / 批量修改 / 运行命令）、目标摘要和行级 diff：旧/新两列行号、`+`/`−` 着色、保留空白，默认 300 行、可展开全部，单侧超过 200k 字符时不计算 diff 而退回全文对照。批量请求（`preview.kind === 'batch'`）按文件折叠，标题带 `+X −Y`，顶部汇总文件数与增删行数；未知的 `kind` 一律降级为"修改前/修改后"两栏。点 diff 行复制 `path:行号`。超时或窗口取消时主进程发 `approval:close`，条自动消失。

预览数据仍由主进程生成：单个文件的 `before`/`after` 每侧按 300 行或 100k 字符截断并置 `truncated`，所以文件很大时前端会提示"主进程只发送了预览片段"；批量预览逐文件保留同样的字段，最多 20 个文件。

### 8.1 改动历史与定位

`electron/changes-ipc.cjs` 提供三个只读通道，全部先做 sender 授权，返回 `{ ok, value }` / `{ ok, error }`：

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `changes:list` | `{ rootId }` | `changes[]`（id、time、path、kind、bytes），按时间倒序、最多 100 条，**不含内容** |
| `changes:diff` | `{ rootId, changeId }` | `before`/`after`（每侧 300 行 / 100k 字符截断）、`truncated`；只读历史文件，不读磁盘当前内容 |
| `changes:reveal` | `{ rootId, path }` | `shell.showItemInFolder` 的定位结果；路径先经 `resolveInside` 校验，越界返回 `path-escape` |

`rootId` 是不透明 id（`project-<sha256>`），渲染层拿不到根路径；`reveal` 也绝不接受绝对路径。`rootId` 同时随审批请求下发，审批条的"在资源管理器中显示"只用它和 `rootName` 精确剥出根内相对路径，不靠显示名反查文件夹。

历史的损坏处理与权限库一致：`changes:list` 遇到无法解析的 JSON 返回 `history-unreadable`，不会删除或覆盖那个文件。

## 9. 审计

`permissions-audit.jsonl` 逐行记录（best effort，写失败不影响主流程）：

```json
{"time":1762,"action":"grant","rootId":"project-…","capability":"write"}
{"time":1763,"action":"allowed","rootId":"project-…","capability":"write","via":"once","summary":"写入 demo/a.ts"}
{"time":1764,"action":"denied","rootId":"project-…","capability":"exec","via":"user","summary":"npm run build"}
{"time":1765,"action":"revoke-all","rootId":"project-…"}
{"time":1766,"action":"store-error","detail":"corrupt","backup":"permissions.json.corrupt-1766"}
{"time":1767,"action":"reveal","rootId":"project-…","path":"demo/a.ts"}
```

文件与 `permissions.json` 同在 `app.getPath('userData')`，权限 0600。

`permissions.json` 损坏时**不会**被下一次保存覆盖：解析失败会先把它改名成 `permissions.json.corrupt-<时间戳>`，再以空状态（fail-closed）继续，审计里留下 `store-error`。

## 9.1 修改历史与撤销

每次写入**成功后**把原内容存进 `userData/file-history/<rootId>.json`：

- 写入、锁内比对、记录在同一个路径锁内完成，所以并发写入不会错记 `before`；
- 每个文件夹最多 60 条，总量 4MB，超出丢弃最旧；
- 只存内容，不存权限快照；撤销是一次普通写入，需要 `write` 能力并再次审批；
- `changeId` 通过工具结果返回给模型，也可以先 `list_changes` 找到；
- 历史是**明文**放在用户目录里的，不是加密保险箱；
- 记录失败不会被吞掉：写入已经发生时会返回 `historyWarning`，明确告诉模型这次修改无法撤销。

## 10. 已知边界

当前**不做**的事，避免误解：

- **批量修改的"原子性"是尽力而为**：`apply_changes` 先校验全部、再写全部，任何写入失败会把已写的文件按审批时内容回滚，但进程若在写入过程中崩溃，磁盘上可能只写了一半；回滚失败的文件会在结果里以 `rollbackFailed` 列出。
- **文件夹删除与移动有边界**：文件夹删除只接受 ≤50 个文件、合计 ≤2 MB、全部是可读文本、树内没有 `.git`；符号链接只删链接不跟随。文件夹移动不写撤销记录，审批条里会写明不可撤销。
- **审批可以是应用内自动应答**：审批条由渲染层渲染，理论上被攻破的渲染层能自行点"允许"。这是选择"应用内审批条"的已知代价；**扩大能力范围**仍然只能走原生对话框，所以影响面被限制在"已授权能力内的一次操作"。
- **审批预览仍有上限**：每侧最多 300 行 / 100k 字符，超过就只发片段并在审批条上标注；改动位于 800 行文件的第 500 行时，diff 是"片段 → 片段"的对比，不是整文件 diff。`git_diff` 能补上已跟踪文件的完整差异，但未跟踪的新文件不在其中。
- **Git 只读**：`git_status` / `git_diff` 是 `execFile('git', [...固定参数])`，不经过 shell；提交、切换分支等仍走 `run_command`。
- **没有网络出口控制**：`run_command` 继承启动 Mova 的环境变量，模型可以用命令访问网络；权限模型约束的是"能不能执行"，不是"命令能做什么"。
- **没有多用户隔离**：单用户 owner 模型，权限按机器账户隔离。
- **没有跨项目授权**：一个请求只能使用该项目声明的 rootId，跨项目需要用户显式另开项目。
- **浏览器版无文件访问**：`window.movaDesktop.permissions` 不存在时设置页只显示说明。

## 11. 测试

`tests/permissions.test.mjs`（29 例）覆盖：

- 路径归一化与 id 稳定性、相对路径拒绝；
- 登记不授权、重复登记幂等、渲染层发起的登记需原生确认；
- 授权必须确认、撤销不弹窗、自动接受需先有能力；
- `write` 依赖 `read`，撤销 `read` 连带撤销 `write`；
- 每次写都确认 / 会话授予 / 拒绝；
- 未知根、被撤销的能力；
- 权限持久化、损坏文件另存不覆盖；
- 路径穿越、绝对路径、链接逃逸、NTFS 备用数据流、Windows 设备名与尾点；
- 工具按能力生成、读取/二进制/越界、写入被拒后文件不变、`.git` 保护、多处匹配、撤销后立刻失效、命令退出码与工作目录；
- `search_files` 的字面量/正则/非法正则；
- `git_status` / `git_diff` 在真实仓库上的输出；
- 写入历史的撤销与 `list_changes`；
- 保存失败时回滚内存里的授权；审批请求带 `rootId`；没有每轮次数上限（25 次写入全部放行）；
- IPC 全通道鉴权与错误码脱敏。

`tests/agent-tools-hardening.test.mjs`（8 例）覆盖取消与竞态：审批后到达的批准不会落盘、等待锁时取消不会写入、审批期间文件被改动返回 `conflict` 且不写历史、审批期间撤销能力会拦住写入、并发写同一路径只有一个成功、撤销不会抹掉之后的编辑。

`tests/agent-tools-features.test.mjs`（10 例）覆盖新增工具：删除（含撤销与递归边界）、移动（含跨根与覆盖冲突）、一次审批的批量修改及其整体失败/冲突回滚、项目树截断、符号查找，以及审批预览按 300 行/100k 字符截断。

`tests/changes-ipc.test.mjs`（12 例）覆盖改动历史 IPC：摘要不倒序错、未登记与损坏历史、diff 截断、`reveal` 的路径校验（越界时 shell 不被调用）、sender 授权。

`tests/approvals.test.mjs`（5 例）覆盖审批条：决策回传、跨窗口拒绝、超时自动拒绝、窗口取消时全部拒绝、IPC 鉴权与过期 id。

`tests/pi-chat.test.mjs` 另有端到端两例：未授权时模型看不到文件工具且系统提示仍是"不能访问文件"；授权后模型调用 `write_file`、审批通过、文件真的落盘、结果回传给模型。
