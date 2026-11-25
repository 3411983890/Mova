# 并行开发简报（所有子智能体必读）

> 你是一个并行开发智能体。**只做分配给自己的文件**，其余一律不碰。
> 破坏别人文件的代价远高于少做一个功能：宁可留 TODO，也不要顺手改。

## 1. 仓库事实

- 工作目录：`C:\Users\34119\Documents\Mova`（**不是 git 仓库**，没有回滚兜底；快照在 `.code-backups/before-cli-models-20261113-175232/`）
- 技术栈：Electron + 原生 ESM；渲染层是「`index.html` + `app.js`（149KB 单体）+ `styles.css`」+ 局部 React
- 构建：`npm run build`（vite 把 `src/app/main.tsx` → `dist/app.js`，`main.tsx` 里 `import '../../app.js'`）
- 测试：`node --test`（Node 24，`tests/*.test.mjs`，69 个文件）
- 主进程模块：`electron/*.cjs`（CommonJS）与 `electron/*.mjs`（ESM）混用；**新模块一律用 `.mjs`**

## 2. 硬规则（违反即返工）

1. **文件所有权**：只创建/修改简报里列给你的路径。其他任何文件（尤其 `app.js`、`index.html`、`styles.css`、`chat-agent.mjs`、`ask-card.jsx`）**不要动**，接线由统筹者统一做。
2. **不新增依赖**：`package.json` 只读。已有可用的：`@earendil-works/pi-ai`、`openai`、`zod`、`react`。
3. **不改现有测试**：`tests/` 下已有文件只读。新增用例请建新文件。
4. **验收门槛**：`node --test` 相对基线的唯一标准是**不新增失败**。
   基线已知失败 3 项，属于既有问题，不要去修：
   - `tests/markdown-transcript.test.mjs`（长期记忆 · 偏好）
   - `tests/trace-rows.test.mjs`（cmd-card）
   - `scripts/popup-test.cjs`（被 `node --test` 误扫的脚本）
5. **不写死密钥/令牌**：任何日志、错误对象、测试夹具里都不得出现 access/refresh token 形态的字符串。
6. **纯函数优先**：能让核心逻辑脱离 Electron / 网络 / 磁盘单独跑，就必须拆成纯函数——这样测试才不依赖环境。需要 IO 的一律**依赖注入**（`{ fetch, readFile, now, random }` 从参数传入，不要直接 `import` 全局）。
7. **中文注释**：与仓库现有风格一致，关键决策写「为什么」，不写「是什么」。
8. **不要起 dev server、不要跑 electron 窗口、不要装包**。

## 3. 代码风格

- 2 空格缩进、单引号、行尾分号；ESM `export`。
- 单文件超过 ~400 行就拆分（纯逻辑 / IO 适配 / 编排三层）。
- 错误一律用 `SubscriptionError`（见 `electron/subscription/contract.mjs`），不要抛裸 `Error` 给上层。
- 导出前先想清楚：这个函数会被谁调用？只被测试调用的是死代码，不要留。

## 4. 必读参考（按分配）

| 文档 | 内容 |
| --- | --- |
| `Mova-CLI模型-开发文档.md` | 数据模型（§5）、登录（§7）、额度（§8）、调度（§9）、ACP 映射（§11）、前端（§12）、里程碑（§15） |
| `Mova-Gemini后台执行-前端接入方案.md` | ACP 通道逐项映射、四个缺口 |
| `Mova上下文压缩与Agent上下文工程方案.md` | 台账（§4）、缺陷清单（§5）、实施顺序 S0–S5（§7）、测试（§8） |
| `cli-models-settings.html` | 设置页视觉基准（已审查通过） |
| `schema-form-card.html` | 表单卡视觉基准（紧凑版，已审查通过） |
| `electron/subscription/contract.mjs` | **契约：通道名、错误码、状态值、isAvailable/effectiveState** |

## 5. 交付要求

1. 每个模块顶部一段 3–6 行注释：它负责什么、不负责什么、被谁调用。
2. 至少一个测试文件覆盖核心分支；测试名用英文，断言消息用中文。
3. 完成后回报：**新建/修改的文件清单** + **测试命令与结果** + **未完成项与原因**。
4. 若发现契约本身有问题（例如 `contract.mjs` 缺字段），**不要改契约**，在回报里写清楚，由统筹者统一改。

## 6. 你可能会用到的现有能力

- `electron/model-credentials.cjs`：`safeStorage` 加密单文件存储的现成写法（可参考，勿改）
- `electron/services/secret-vault.cjs`：另一套加密存储
- `tests/chat-context.test.mjs`：`fetchModel` 注入式测试的范本
- `src/features/ask/ask-card.jsx` + `.css`：对话页卡片语言（表单卡视觉对齐它，但**不要改它**）
- `src/features/memory/memory-settings.jsx`：React 设置页组件范本（参考其 props 形状）
