# Mova 开发规范（Conventions）

> 本文件是**所有人和所有子智能体**改这个仓库前必须先读的硬规则。
> 规则分三级：**必须（MUST）**、**应当（SHOULD）**、**禁止（MUST NOT）**。
> 与本文件冲突的旧代码视为待清理债务，不要为了「保持一致」而复制坏做法。

---

## 0. 项目事实

| 项 | 值 |
| --- | --- |
| 形态 | Electron 45 桌面端，单机运行，**无 git 仓库**（回滚靠 `.mova-backups/`、`.code-backups/`） |
| 运行时 | Node 24；ESM 用 `.mjs`，CommonJS 用 `.cjs`；渲染层用 `.js / .jsx / .ts / .tsx` |
| 入口 | 主进程 `electron/main.cjs`；渲染层 `index.html` → `src/app/main.tsx` → `import '../../app.js'`（根 `app.js` 是活的 UI 主控，**不是**构建产物） |
| 构建 | `npm run build` → `scripts/build.mjs` → `dist/`（Electron 只加载 `dist/`，`mova://app/index.html`） |
| 依赖 | 零新增 npm 依赖是硬约束；需要能力时先找 Node/Electron 内置或已有依赖 |

**移动端例外（2026-11-17，用户授权建立 iOS 工程）**：`mobile/` 是独立 Expo 项目，可安装与所选 Expo SDK 匹配的移动端依赖，维护自己的 `package-lock.json`；不把移动端依赖加入根项目。下文的零新增依赖限制继续适用于桌面端。移动端另外运行自己的类型检查、单测和 iOS bundle 导出；原生签名与真机验收单独执行。

### 门禁（每次改动必须跑）

```powershell
node --check <改过的 .mjs/.cjs>      # 语法
node --test                          # 全量单测
npm run typecheck                    # tsc --noEmit + tsconfig.electron.json
npm run build                        # 产物必须能构建
```

**基线锁定**：`node --test` 目前有 3 个**已知历史失败**，必须保持失败、不得新增失败：

- `scripts/popup-test.cjs`
- `tests/markdown-transcript.test.mjs`
- `tests/trace-rows.test.mjs`

除上述 3 个，任何新增失败都算回归。**不得**通过删除/跳过测试来「变绿」。

---

## 1. 目录布局与预留空间

```text
Mova/
├─ index.html  app.js  styles.css          # 渲染层三件套：保持根目录（build 与 electron 都指向这里）
├─ package.json  vite.config.js  tsconfig*.json  eslint.config.js
├─ README.md  THIRD_PARTY_NOTICES.md
├─ docs/
│  ├─ architecture.md                      # 真实结构说明（唯一树状图来源）
│  ├─ conventions.md                       # 本文件
│  └─ plans/                               # 所有「方案 / 设计 / 实施契约」类 md，一对一新文件
├─ electron/                               # 主进程
│  ├─ main.cjs  preload.cjs                # 窗口与 IPC 装配
│  ├─ skills/                              # ★ 本地能力单一事实源（manifest + handlers + adapters）
│  │  ├─ index.mjs  registry.mjs  manifest-schema.mjs  discover.mjs  events.mjs  approval-bridge.mjs
│  │  ├─ adapters/{pi-ai.mjs, mcp.mjs}
│  │  └─ packs/<pack-id>/{manifest.mjs, handlers.mjs}
│  ├─ bots/                                # ★ 预留：MovaBot 服务端运行时（空目录 + README 占位）
│  ├─ acp/  mcp/  browser/  desktop/  design*/  search/  context/  memory*/  subscription/
│  └─ logging/  db/  services/  vpn/
├─ src/                                    # 渲染层
│  ├─ app/                                 # 引导、窗口控制
│  ├─ features/<feature>/                  # 一个 feature 一个目录：视图 + 逻辑 + 自己的 css
│  └─ services/                            # 渲染层与主进程/服务端的客户端封装
├─ scripts/                                # 构建、运维、冒烟（长期保留的可重复脚本）
├─ tests/                                  # node --test 测试
└─ .mova-backups/  .code-backups/          # 回滚快照（不进工作树视野）
```

**预留扩展点（新增内容只准往这些地方放）**

| 要新增的东西 | 放哪里 |
| --- | --- |
| 新的本地能力（工具） | `electron/skills/packs/<kebab-id>/` 一个 pack，含 `manifest.mjs` + `handlers.mjs` |
| 新的 UI 功能块 | `src/features/<kebab-id>/`（含自己的 `*.css`，不要往根 `styles.css` 里加新块） |
| 新的 Bot 能力/视图 | 主进程 `electron/bots/`，渲染层 `src/features/bot/` |
| 新的方案/设计文档 | `docs/plans/<主题>.md`（**不**放根目录） |
| iOS 移动客户端 | `mobile/`，独立 Expo 工程；其路由文件名遵循 Expo Router 约定 |
| 一次性探针脚本 | `scripts/probes/`（不得进 `scripts/` 根、不得被 `tests/` 依赖） |

---

## 2. 文件级规范

### 2.1 每个非平凡源文件顶部必须有「三段式头注释」（MUST）

```js
/**
 * 负责：一句话说这个模块真的做什么。
 * 不负责：明确划出边界（最容易被人误以为它做的事）。
 * 被谁调用：列真实调用方，便于改签名时评估爆炸半径。
 */
```

这是本仓库既有风格（见 `electron/mcp/tools.mjs`、`electron/acp/engine.mjs`）。新文件不写头注释视为未完成。

### 2.2 命名

- 目录、文件名：**kebab-case**（`memory-extractor.cjs`、`cli-models-settings.jsx`），不用驼峰、不用下划线。
- 单测文件：`tests/<模块名>.test.mjs`，一个被测模块一个文件，必要时加后缀（`-wiring`、`-hardening`）。
- 导出：函数 `camelCase` 动词开头；常量 `SCREAMING_SNAKE`；类型/类 `PascalCase`。
- 不要用 `utils`、`helpers`、`common` 当文件名——名字必须说明职责。

### 2.3 模块边界

- **纯逻辑与 IO 必须分离**：schema 校验、打分、归一化、事件映射这类写成纯函数模块，**不准 import electron**，才能被 `node --test` 直接跑。
- 需要宿主能力（`sender`、`browser`、`designRuntime`、`approvals`…）一律**依赖注入**，不要在模块顶层 `require('electron')`。
- `.cjs` 与 `.mjs` 不互相深耦合：`require('../foo.cjs')` 只能从 `.cjs` 发起；`.mjs` 用 `await import()` 或由调用方传入实例。
- 渲染层 `.jsx/.tsx` 只做视图，业务逻辑放同目录的 `.js/.ts`；不要在 JSX 里直接调 `window.movaDesktop` 以外的新全局。

---

## 3. 代码质量规则

### 必须（MUST）

1. **错误不吞**：catch 里要么恢复、要么抛出带 `code` 的 `Error`（`err.code = 'xxx'`），要么记 `logger.warn` 后降级并让返回值体现降级。
2. **边界处归一**：所有外部输入（IPC 参数、MCP `tools/call` 参数、模型给的 JSON）在进入业务前必须校验类型/长度并给默认值，不能靠「模型不会传错」。
3. **日志用 `getLogger(scope)`**（`electron/logging/index.mjs`）。主进程源码里 **禁止 `console.log`**；一次性脚本例外。
4. **超长文本截断并说明**：给模型的结果要有上限（沿用 `MAX_TEXT_CHARS = 8192`），截断时附一句「已截断，原文 N 字符」。
5. **写文件前必须能预览**：涉及写入的能力要在事件里带 `diff`，让前端能展示变更。
6. **公开函数写 JSDoc**：参数与返回值的形状要能从注释看出来，仓库不开 `allowJs` 全量类型检查，注释就是唯一契约。

### 应当（SHOULD）

1. 函数体超过 ~40 行就拆；单文件超过 ~400 行就拆模块（`chat-agent.mjs` 这种历史巨文件属于待还债务，新增逻辑不许再往里堆）。
2. 常量提到文件顶部并具名；魔法数字必须带注释解释来由（例如时间预算从哪测出来的）。
3. 分支用早返回（guard clause），少用多层 `if/else` 嵌套。
4. 同一件事只允许一处实现：发现第二份拷贝时，抽出共享模块并删掉旧的那份，不要「先复制以后再合」。

### 禁止（MUST NOT）

1. 新增 npm 依赖（含 devDependencies）。
2. 手改 `dist/`、`dist-edge/` 下任何文件——它们全是生成物。
3. 用 PowerShell 文本 cmdlet（`Get-Content -Raw | Set-Content`、`-replace` 等）编辑源码：本项目出现过整文件被 GBK 双重编码毁掉的严重事故。改文件只用编辑器的写入/替换能力或 Node `fs`。
4. 在 `electron/subscription/` 下做「顺手重构」——该目录是订阅额度链路，改动必须有明确需求和单独验收。
5. 为了让测试变绿而放宽断言、跳过用例、或删除既有测试。
6. 无引用的「以后可能用到」的代码、空实现、注释掉的代码块——直接删。
7. 把方案文档写到仓库根目录。

### 安全底线（MUST）

所有文件/命令/桌面/浏览器类能力必须同时满足：

- 路径经 `electron/acp/gate.mjs` 的 `resolveInRoots`（逐级 `realpath` 祖先校验，防 symlink/junction 逃逸）；
- 能力位经 `electron/permissions.cjs` 实时复查（不缓存旧的「允许」）；
- 写操作经 `electron/approvals.cjs` 的 `ask()` 人工确认，拒绝时**零落盘**；
- 关键操作 `audit` 落盘（`electron/agent-tools.cjs` 里的审计写法）；
- `.git/` 与凭据类文件拒绝读写，除非用户显式指定。

**空 `projectRoots` 必须拒绝一切文件读写**，不允许「没有根目录就放开」。

### 技能 manifest 的安全字段（MUST 按安全变更对待）

`electron/skills/packs/*/manifest.mjs` 里有三个字段是**门禁判据**，改它们等于改安全策略，必须单独评审、写清理由：

- `risk`：决定这个工具要不要过审批闸门（`write` / `exec` 一律不许配 `approval.mode: 'none'`，manifest 校验会拒绝）；
- `approval.mode`：`none` 免人工确认，`policy` 按预设，`always` 必问人；
- `permissions.fs`：`'none'` 或「`fs: 'read'` + 声明了 desktop / browser / canvas / memory + 无路径参数」会让这个包跳过项目根检查。

另外 `exposure.mcp: 'core'` 会让工具进**每一轮**的 `tools/list`（每轮都付 token），默认一律用 `'on_demand'`，
只有「每轮都大概率要用」的工具才允许进 core。同理，工具结果预算（`maxResultChars`）只给真实产出大文本的工具声明，
不要为了「保险」给全表放大。

### 长等待必须登记（MUST）

凡是「等用户」的路径（提问卡、审批条、浏览器接管、桌面接管……）都必须让静默计时停下来：走
`electron/approvals.cjs` 的 `ask()`，或者 `humanWait.begin(sender.id, reason)` + `try/finally` 里的 `release()`
（`sender.id` 必须与 model-ipc 的 `sender.id` 同一粒度）。否则 240s 一到，`services/idle-guard.mjs`
会把这一轮判成卡死并 abort——用户只是想了想，回合却没了。登记表必须是 `main.cjs` 建的那**同一个实例**
（像 `createBrowserController` 那样注入），另建一个等于没登记。

---

## 4. 测试规范

- 测试只跑纯内存 fake，**禁止真实网络、真实 `agy` 进程、真实 Electron 窗口**（真实进程的验证放 `scripts/probes/`，人工执行）。
- 一个测试名要读得懂失败原因：`✔ 空 projectRoots 时写文件被拒绝且文件未创建`，不要 `✔ test 1`。
- 断言优先断言**可观察结果**（返回值、文件系统、事件序列），不是内部实现细节。
- 新增能力必须同时给出：正常路径、拒绝路径（权限/审批）、超长/畸形输入路径。
- 事件类能力要断言「同一 `id` 原地更新而不是新增一行」。

---

## 5. 提交前自检清单（每个子智能体必须逐条自查并在报告里回答）

1. 改过/新增的每个 `.mjs`、`.cjs` 是否 `node --check` 通过？
2. `node --test` 的失败数是否仍为 **3**（且就是那 3 个历史基线）？
3. `npm run typecheck` 与 `npm run build` 是否通过？
4. 新文件是否有三段式头注释、kebab-case 命名、纯逻辑无 electron import？
5. 是否有重复实现被顺手删掉（而不是留两份）？
6. 是否碰了 `electron/subscription/`、`dist/`、根目录 md？（应当是「没有」，除非任务明确要求）
7. 改动的文件是否都符合第 1 节的目录布局？

---

## 6. 文档规范

- 方案 / 设计 / 实施契约：`docs/plans/<中文主题>.md`，**一个主题一个文件**，文件开头写「结论」再写「论证」。
- 结构说明只允许有一份：`docs/architecture.md`。其他文档提到目录时链接过去，不要复制树状图。
- 文档里引用的代码位置用 `路径:行号` 或 Markdown 相对链接；引用行号会在重构后失效，能写函数名就写函数名。
- 已知坑必须写进 `docs/architecture.md` 的「已知坑」小节（例如 `agy` 不带 `acp` 子命令会挂死、残留 `agy` 会让 `session/new` 返回空模型列表）。
