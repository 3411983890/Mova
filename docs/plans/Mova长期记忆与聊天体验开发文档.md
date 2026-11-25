# Mova 长期记忆与聊天体验开发文档

> 文档版本：1.0  
> 基线日期：2026-11-10  
> 适用代码：`C:\Users\34119\Documents\Mova`  
> 文档性质：现状说明 + 目标架构 + 迁移与验收方案  
> 当前状态：本机 Docker 服务版已接入（PostgreSQL + pgvector、Redis/BullMQ、本地 Embedding、逻辑备份/恢复、WAL 归档/PITR、MinIO 图片镜像、配额、兼容事件存储）；Dot、官方 Pi SessionManager 和多用户仍未实施。详见 0.1 实施更新。

---

## 0. 摘要

Mova 的聊天和记忆系统分为两层：

- **当前已经实现的本地版**：Electron 桌面端、PostgreSQL + pgvector 仓库、混合检索、LLM 记忆提取与重排、`memory_search` 工具、自动备份与应用级会话快照。它解决了“个人单机可用、重启不丢、能搜索、能编辑记忆”的问题；本地 JSON 仅作为显式 `MOVA_MODE=local` 兼容模式。
- **完整目标版**：PostgreSQL + pgvector 持久化、语义向量检索、Redis/BullMQ 异步任务、自动备份、Pi `SessionManager` 恢复、Dot Worker 检查点恢复。它解决的是“海量历史、跨设备/多用户、可运维、可恢复、长任务可靠执行”的问题。

本文件同时说明两者差异、完整版的数据模型和接口、分阶段迁移路径、设置页规范、测试策略、成本与风险，避免把“已经能跑”误认为“已经达到生产级”。

核心原则：

1. **永久保存不等于每次全量发送给模型。**
2. **会话历史、知识记忆、执行状态是三种不同资产，不能混成一张聊天表。**
3. **模型可以替换，记忆归用户控制，历史必须可追溯。**
4. **完整版不是换数据库，而是增加事务、异步、恢复和权限语义。**

## 0.1 实施更新（2026-11-10）

本机 Docker 服务版已完成以下落地，和下文“当前实现基线”（最初本地 JSON MVP）并存说明：

- `docker-compose.yml`：PostgreSQL 16 + pgvector、Redis 7、MinIO（bitnamilegacy 镜像）；端口绑定 `127.0.0.1`，MinIO 因 Windows 端口保留改用 `59090/59091`。
- `electron/db/migrations/001_init.sql`、`electron/db/migrate.cjs`：单一迁移账本 `mova_migrations`；`electron/db/postgres-repository.cjs` 提供会话、记忆、检索和备份接口。
- `electron/services/embedding.cjs`、`indexer.cjs`、`hybrid-search.cjs`：本地 ONNX `Xenova/multilingual-e5-small`（384 维）、中文 ngram、pgvector cosine、RRF 混合检索；语义关闭或 Embedding 不可用时回退关键词。
- `electron/services/queue.cjs`、`backup.cjs`、`session-store.cjs`：BullMQ 队列、逻辑 `pg_dump` 备份/受控恢复、兼容 `SessionManager` 语义的事件日志。
- `electron/services/pitr.cjs`、`scripts/pitr.mjs`：WAL 归档、`pg_basebackup` 基础备份和到新集群的 PITR；不会覆盖 live 数据卷。
- `electron/object-storage.cjs`、`electron/services/quota.cjs`：MinIO 图片镜像/读取回退、数据库+附件配额检查。
- `electron/memory-runtime.cjs`、`memory-ipc.cjs`、`main.cjs`、`preload.cjs`：Electron 启动自动拉起服务，IPC 增加 health/stats/backup/backups/restore/reindex。
- `src/features/memory/memory-service-settings.jsx`：设置页新增服务健康、自动备份/恢复、Embedding/索引、语义检索、提取模式、存储配额六组，并支持配额输入。
- 测试：当前 `npm test` 共 358 项，356 项通过、2 项按需跳过（真实 Embedding smoke 与未设置 `MOVA_TEST_DB_URL` 的真实 PostgreSQL 集成测试）；PITR 测试 16/16，真实恢复已单独验证。

WAL/PITR 已实际验证：`base-20261110T131521Z` 基础备份 + 归档 WAL 已恢复到新卷/新容器（端口 55499），状态为 `pointInTimeRecovery: yes`，live 数据卷未被修改。MinIO 已实际 PutObject/GetObject/DeleteObject 验证；图片持久化会本地 + S3 镜像。

明确未完成：Dot 的任何前端/Worker/任务表；官方 Pi `SessionManager`（SDK 不提供，使用兼容层）；多用户/团队；设置页没有 PITR 时间点选择（使用 `scripts/pitr.mjs`）；附件备份/异地归档。WAL/PITR 与对象存储能力在设置页/CLI 中按实际状态显示，不虚构。

## 0.2 记忆整改落地（2026-11-10 第二轮）

按整改方案完成的实际代码：

- **提取**：`electron/services/memory-extractor.cjs` 为唯一提取路径，调用当前聊天模型返回 `text/kind/key/confidence`；失败返回 `llm-failed`/`llm-unavailable`，不再回退规则。`memory-policy.cjs` 统一 `shouldAutoExtract()`，本地 JSON 与 PostgreSQL 行为一致。
- **持久任务**：`002_memory_jobs.sql` 新增 `mova_memory_jobs`；`memory-jobs.cjs` 提供 enqueue/claim/complete/skip/fail/retry/list/purge。`ingest` 先写 job，成功/跳过/失败分别落状态；启动后和每 60 秒恢复 pending/failed 任务。`004_memory_job_project.sql` 为任务补充项目作用域。
- **检索**：`memory-retrieval.cjs` 合并 pinned/recent/semantic/keyword 候选，按语义、词法、时间衰减、重要性和置顶排序；`context()` 不再只取最近 500 条，候选上限跟随 `maxMemories`，返回 `usedIds`、`estimatedTokens`，并继续由 LLM 重排。`memory_search` 工具已接入真实模型。
- **质量字段**：`003_memory_quality.sql` 增加 `normalized_hash/importance/use_count/last_used_at/observed_at/valid_from/valid_to/expires_at/last_confirmed_at`，并建立冲突表；`addMemory` 用 normalized hash 做同作用域去重，`context()` 注入日期并跳过已过期记忆，读取时累加 `use_count`。
- **安全**：`memory-redaction.cjs` 在发送模型和写入 job 前分段遮盖密钥、密码、Bearer、PEM、身份证、银行卡；`memory-quality.escapeMemoryData` 思路已用于 `<memory-data>` 的 `<`/`>` 转义，防止提前闭合标签。
- **界面**：设置页显示最近提取任务（状态/尝试次数/失败原因）；聊天时间线显示“参考了 N 条长期记忆”和 `memory_search` 调用；服务模式不再把“本机 JSON 仓库”作为主存储描述。
- **隐私保险库**：`005_mova_vault.sql` + `secret-vault.cjs`，使用 scrypt（N=2^15）+ AES-256-GCM，把密码/API Key/Token/私密备注加密成单行密文存入 `mova_vault`；主密码不落库、不写备份，保险库随数据库备份时只有密文。设置页支持创建/解锁/锁定/增删改/复制/更换主密码。
- **维护压缩**：`memory-maintenance.cjs` 规划过期归档、低价值长期未用归档、同作用域完全重复合并；设置页“扫描并整理”可执行，运行时每 24 小时尝试一次。置顶和高重要性记忆受保护。
- **自然语言管理**：`memory-commands.cjs` 解析“忘记 X / 把 X 改成 Y / 以后不要再记关于 X”等中英文命令；唯一匹配直接执行，多个匹配返回候选并要求确认，不静默批量删除。

仍未完成（不冒充）：冲突审核 UI/自动 pending、待确认收件箱、完整指标面板、管理页批量筛选、多用户/跨设备同步、全库备份文件级加密（保险库密文随备份，但其他表仍是普通 `pg_dump` 内容）。

## 目录

- [0. 摘要](#0-摘要)
- [0.1 实施更新](#01-实施更新2026-11-10)
- [1. 背景、目标与范围](#1-背景目标与范围)
- [2. 当前实现基线](#2-当前实现基线)
- [3. 目标架构](#3-目标架构)
- [4. 数据模型](#4-数据模型)
- [5. 会话与 Pi SessionManager](#5-会话与-pi-sessionmanager)
- [6. 长期记忆](#6-长期记忆)
- [7. 检索与上下文](#7-检索与上下文)
- [8. 聊天体验](#8-聊天体验)
- [9. 设置页「记忆与存储」规范](#9-设置页记忆与存储规范)
- [10. 后台任务与 Dot](#10-后台任务与-dot)
- [11. 安全、隐私、备份与恢复](#11-安全隐私备份与恢复)
- [12. 当前版与完整版差异](#12-当前版与完整版差异)
- [13. 分阶段实施计划](#13-分阶段实施计划)
- [14. 测试计划](#14-测试计划)
- [15. 观测与运维](#15-观测与运维)
- [16. 成本](#16-成本)
- [17. 风险与待决策](#17-风险与待决策)
- [18. 附录](#18-附录)
- [19. 结论](#19-结论)
- [20. 变更记录](#20-变更记录)

> 目录中的锚点按 GitHub 风格生成；不同 Markdown 阅读器可能对中文标题锚点处理不同，以正文标题为准。

---

## 1. 背景、目标与范围

### 1.1 要解决的问题

| 需求 | 期望效果 | 当前状态 |
|---|---|---|
| 永久保存会话 | 几天、几个月后仍能打开原聊天 | 已实现（本地快照） |
| 长期记忆 | 新聊天能复用偏好、项目事实和决定 | 已实现（LLM 提取 + LLM 重排 + 手动管理） |
| 跨聊天搜索 | 能定位旧讨论的原始消息 | 已实现（关键词；可选全部项目） |
| 随时切换模型 | 切换提供商/模型后继续当前工作 | 已实现可见上下文重建；不迁移模型内部推理 |
| Dot 长期执行 | Worker 重启后知道做到哪一步 | 仅有本地任务/检查点接口，无 Worker |
| 语义检索 | 换个说法也能找到旧内容 | 未实现，当前只有关键词 |
| 自动备份 | 磁盘损坏或误删后可恢复 | 仅手动导出，无自动备份 |
| 多用户/团队 | 搜索前检查授权、项目隔离 | 未实现，当前是单机单用户 |

### 1.2 目标

- 保证原始聊天、工具记录、模型配置在重启后仍可恢复。
- 让长期记忆可提取、可审核/可关闭、可编辑、可停用、可删除、可追溯来源。
- 提供关键词 + 语义的混合检索，并严格按项目/权限过滤。
- 为模型切换提供可移植上下文，不把某一模型的私有推理块当成通用记忆。
- 为 Dot 长任务提供独立状态、检查点和可恢复 Worker。
- 提供自动备份、时间点恢复、删除传播和可验证的恢复演练。
- 保持桌面端体验，同时为未来服务端/多用户保留清晰边界。

### 1.3 非目标

第一阶段明确不做：

- Neo4j、Elasticsearch 或独立向量数据库；pgvector 足够。
- 自动执行支付、发布、删除等高风险外部操作而不需审批。
- 把网页、MCP 返回值或其他用户内容直接写入高可信用户记忆。
- 跨模型迁移模型内部的隐藏推理状态。
- 用向量检索替代精确关键词检索。
- 在没有备份恢复演练前宣称“不会丢数据”。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| Conversation History | 完整会话历史，用户和 Agent 实际说过、做过什么 |
| Knowledge Memory | 从会话中提炼出的偏好、事实、决定、经验等工作记忆 |
| Execution State | Dot/Code/子代理正在执行的任务、进度、检查点、审批 |
| Scope | 记忆作用域：`global` 或某个 `projectId` |
| Provenance | 记忆来源：会话 ID、消息 ID、原始片段 |
| Session Event | Pi 会话事件：消息、工具调用、模型切换、上下文压缩等 |
| Checkpoint | 可恢复的执行状态，不只是“继续开发”一句话 |
| RRF | Reciprocal Rank Fusion，把关键词和向量结果融合排序 |
| RLS | PostgreSQL Row Level Security，行级权限 |
| RPO/RTO | 恢复点目标/恢复时间目标 |

---

## 2. 当前实现基线

> 本节记录最初的本地 JSON 基线（仍可通过 `MOVA_MODE=local` 使用）；当前默认服务版的变化见 0.1。两者共享 UI、Markdown、重试、长对话和记忆管理语义。

### 2.1 已实现能力

#### 聊天展示

- Markdown：标题、加粗、斜体、删除线、列表、引用、表格、行内代码、围栏代码块。
- 代码块：语言标记、复制按钮；Electron 通过主进程剪贴板 IPC 写入，不依赖浏览器权限。
- 链接：只允许 `http:`、`https:`、`mailto:`；不执行原始 HTML；远程图片只显示 alt 文本，避免追踪。
- 流式 Markdown：未闭合代码围栏在流式过程中仍可渲染。
- 失败/停止/中断：显示原因和「重新生成」按钮；重试复用原用户消息，保留旧尝试。
- 长对话：前端按 60 轮分页，可加载更早消息；后端 60,000 字符预算，较早内容仅附有限摘录。
- 能力提示：聊天页不再放「模型能力与隐私」折叠面板；模型名称与思考档位见右上角「⋯」→「Token 用量」，文件权限、搜索源与数据发送范围见设置页。
- 临时聊天：只在新聊天可选（「⋯」右侧的隐私图标），开始聊天后图标消失、标题后保留灰色「临时聊天」；不写入会话、不写入图片、不提取记忆、不注入记忆。

#### 长期记忆

- 自动提取由当前聊天模型完成：判断用户消息中哪些事实、偏好和决定值得跨对话保留；不再使用本地正则规则。
- 发送给模型前遮盖疑似密码、密钥、令牌、私钥；写入前再过滤一次。LLM 不可用、超时、限流或返回非法 JSON 时明确失败，不回退规则。
- CodeMova 自动记忆限定来源项目；ChatMova 提取结果保存为全局记忆。项目记忆不会离开所属项目。
- 上下文检索先由本地混合检索召回候选，再由同一个 LLM 重排；模型还可以通过 `memory_search` 工具主动查找旧记忆。
- 记忆管理：查看、添加、编辑、置顶、停用/启用、删除、来源跳转。
- 显式键（如数据库类型）在同一作用域内自动替代旧版本，保留历史版本。
- 中文二元组关键词搜索；支持当前项目、全局、用户主动选择的全部项目。
- 搜索结果能打开原会话并定位到原消息。
- 临时聊天不参与检索、提取和上下文注入。

#### 设置页「记忆与存储」

- 长期记忆总开关、自动提取、包含全局记忆。
- 上下文记忆条数/字符上限、仓库总条数上限、永久保留说明。
- 记忆管理、历史搜索、本地仓库路径、数据量估算。
- 未加密手动备份导出（含常见密钥格式遮盖）。
- 分别清空记忆、清空历史；需要输入确认词，不可撤销。

### 2.2 代码模块

| 路径 | 作用 |
|---|---|
| `app.js` | 页面交互、工作区、发送流程、记忆初始化、设置页挂载 |
| `index.html` | 页面结构、聊天/设置容器、能力提示区 |
| `styles.css` | 主界面样式，含能力提示 |
| `src/features/chat/chat-transcript.tsx` | 聊天记录、分页、来源定位、重试按钮 |
| `src/features/chat/chat-reply.ts` | 流式回复状态合并与终止状态 |
| `src/features/chat/markdown-renderer.js` | react-markdown + remark-gfm 安全渲染、代码复制 |
| `src/features/chat/markdown.jsx` / `markdown.css` | Markdown 样式入口 |
| `src/features/chat/context-budget.mjs` | 长对话上下文预算和摘录 |
| `src/features/memory/memory-settings.jsx` / `.css` | 「记忆与存储」界面 |
| `electron/memory-store.cjs` | 纯本地记忆/会话仓库，原子写入、作用域、提取、搜索、任务/检查点 |
| `electron/memory-ipc.cjs` | 受授权的窄 IPC 接口 |
| `electron/chat-agent.mjs` | Pi Agent 调用、记忆注入、上下文预算、搜索工具 |
| `electron/chat-images.cjs` | 图片保存、临时图片、图片读取 |
| `electron/model-ipc.cjs` | 模型请求、取消、运行时记忆上下文检索 |
| `electron/preload.cjs` | 暴露有限桌面 API，不暴露原生 `ipcRenderer` |
| `electron/main.cjs` | 窗口、CSP、剪贴板、外链、IPC 授权、Memory 仓库安装 |
| `scripts/build.mjs` | 构建 JS/CSS 并写入 `dist/` |
| `tests/` | 聊天、Markdown、上下文、记忆、提供商测试 |
| `qa/` | 隔离用户目录的桌面验收脚本 |

### 2.3 本地数据

- 仓库路径：Electron `app.getPath('userData')/memory/repository.json`。
- 图片路径：同一用户数据目录下的 `chat-images/`。
- 设置页会显示实际仓库路径；开发启动时目录名可能取自 `package.json`。
- 仓库结构：

```json
{
  "version": 1,
  "sessions": {
    "version": 1,
    "projects": [],
    "conversations": []
  },
  "memories": [],
  "events": [],
  "ingestions": [],
  "tasks": [],
  "checkpoints": [],
  "settings": {
    "autoExtract": true,
    "memoryEnabled": true,
    "includeGlobal": true,
    "historyRetention": "forever",
    "maxMemories": 2000,
    "contextMaxMemories": 12,
    "contextMaxChars": 6000
  }
}
```

- 会话快照的 `conversations` 为 `[conversationId, turns]` 数组。
- 旧浏览器 `localStorage` 工作区会在首次初始化时迁移到仓库，然后移除本地副本。
- 临时会话在保存前被过滤；临时图片只存在内存。
- 写入策略：串行队列、克隆后修改、同目录临时文件、`fsync`、原子重命名；写入失败保留旧文件。
- 损坏 JSON 时拒绝覆盖，界面阻止发送并提示先备份/检查。
- 单次快照上限约 30,000,000 字符；这是当前实现的实际限制。

### 2.4 当前记忆数据模型

```json
{
  "id": "mem_...",
  "text": "项目数据库采用 PostgreSQL",
  "key": "database",
  "kind": "decision",
  "projectId": "project_a",
  "status": "active",
  "pinned": false,
  "source": "automatic",
  "conversationId": "[\"CodeMova\",\"project_a\",\"聊天标题\"]",
  "messageId": "msg-...",
  "createdAt": "2026-11-10T...",
  "updatedAt": "2026-11-10T...",
  "version": 2,
  "supersedes": ["mem_old"],
  "supersededBy": "mem_new"
}
```

字段约束：

- `status`：`active`、`disabled`、`superseded`。
- `kind`：`fact`、`preference`、`decision`、`note`。
- `source`：`user`、`automatic`。
- `projectId` 为 `null` 表示全局；项目作用域必须精确匹配，空字符串不是通配符。
- 手动添加可选择全局/当前项目和 `kind`；自动提取由 LLM 返回 `text / kind / key / confidence`。

### 2.5 当前 IPC 契约

所有接口由 `installMemoryIpc(senderWindow)` 注册，先校验发送者，再返回结构化结果：

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
```

| 通道 | 参数 | 返回/作用 |
|---|---|---|
| `memory:read` | 无 | 全量仓库快照，含 `storage: { filePath, bytes }` |
| `memory:save-sessions` | `snapshot` | 保存会话快照；过滤临时会话 |
| `memory:ingest` | `{ conversationId, projectId, messageId, text, role?, author? }` | LLM 提取长期记忆；返回 `extractor`、`skipped`、`usage`，幂等 |
| `memory:search` | `{ query, projectId?, includeGlobal?, allProjects?, includeSessions?, limit? }` | 关键词搜索记忆 + 会话 |
| `memory:context` | `{ projectId, includeGlobal?, query?, limit?, maxChars?, temporary? }` | 返回可注入记忆和文本 |
| `memory:save` | `{ text, kind?, projectId?, key?, source? }` | 手动保存记忆 |
| `memory:update` | `(id, { text?, status?, pinned? })` | 编辑/停用/置顶 |
| `memory:delete` | `id` | 删除记忆 |
| `memory:settings` | `patch` | 更新设置 |
| `memory:export` | 无 | 导出全部仓库数据 |
| `memory:clear` | `{ target: 'memories' \| 'sessions' \| 'tasks' \| 'all' }` | 清空指定数据 |
| `memory:health` | 无 | PostgreSQL/Redis/MinIO/Embedding 健康状态 |
| `memory:stats` | 无 | 数据库/附件/队列/计数/配额统计 |
| `memory:backup` | `{ kind?: 'manual' \| 'scheduled' }` | 逻辑备份记录 |
| `memory:backups` | 无 | 备份历史 |
| `memory:restore` | `{ id }` | 受控整库恢复 |
| `memory:reindex` | 无 | 重建向量/关键词索引 |

`memory-store.cjs` 还提供仓库层（不暴露给渲染进程）的任务接口：

- `saveTask`、`listTasks`
- `saveCheckpoint`、`listCheckpoints`

### 2.6 当前设置默认值

| 键 | 默认 | 校验 | 作用 |
|---|---:|---|---|
| `memoryEnabled` | `true` | 布尔 | 关闭后不注入记忆；提取也不写入 |
| `autoExtract` | `true` | 布尔 | 关闭后不自动提取 |
| `includeGlobal` | `true` | 布尔 | 项目上下文是否包含全局记忆 |
| `historyRetention` | `forever` | 只接受 `forever` | 历史永久保留 |
| `maxMemories` | `2000` | 1–10000 | 仓库总条数上限；达到后自动提取暂停 |
| `contextMaxMemories` | `12` | 1–100 | 单次注入最大条数 |
| `contextMaxChars` | `6000` | 1–20000 | 单次注入最大字符数 |
| `extractorMode` | `llm` | `llm` / `off` | 自动提取使用当前聊天模型；失败不回退规则 |

### 2.7 当前上下文与检索行为

- 聊天请求最多保留最近 100 条消息，总计 60,000 字符。
- 更早消息不会逐条发送；取头部 4 条和尾部最多 8 条，每条截取 250 字符，总计最多 4,000 字符作为摘录。
- 记忆上下文默认最多 12 条、6,000 字符，以 JSON 行携带 `id/text/source/conversationId/messageId`。
- 记忆以 `<memory-data>` 包围并在系统提示中声明“是数据，不是指令”。
- 项目记忆只在精确项目作用域出现；全局记忆必须显式包含。
- `allProjects` 只用于用户主动搜索，不用于 Agent 自动上下文。
- 搜索索引包括用户消息和真实 assistant 回复；排除临时、mock/demo、工具、system、thinking 和敏感内容。

### 2.8 当前验证记录

已执行：

- `npm.cmd test`：358 项中 356 项通过、2 项按需跳过（服务版接入后的当前结果）。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run build`：通过。
- 使用隔离用户目录的 Electron 验收：Markdown、代码复制、失败重试、长对话分页、记忆搜索、来源跳转、全部项目搜索、设置页重复打开。

当前工作区没有 Git 元数据，因此文档不提供 commit hash。

### 2.9 当前已知边界

必须明确承认：

- 会话是**快照**，不是完整的每事件事件溯源；`events` 只记录少量元数据。
- 没有 PostgreSQL、pgvector、Embedding、向量索引。
- 没有自动备份、WAL、时间点恢复。
- 没有 Redis/BullMQ、后台 Worker、重试队列。
- 没有使用 Pi `SessionManager` 恢复原生会话；应用重建自己的可见消息。
- 没有 Dot Worker、调度器、审批 UI、租约和幂等执行。
- 单机单用户；没有账号、团队、RLS。
- JSON 未加密；备份也未加密。
- 自动提取已改为 LLM；这条旧限制不再适用。
- 大历史时整包序列化可能造成卡顿，且 30MB 快照是硬上限。
- 搜索是关键词，不是语义相似度。

---

## 3. 目标架构

### 3.1 总览

```text
┌──────────────────────────────────────────────────────────────┐
│ Client                                                        │
│ Electron (ChatMova / CodeMova / Design / Dot / Mobile)        │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS / local IPC
┌───────────────▼──────────────────────────────────────────────┐
│ API / Application                                             │
│ auth · conversation · memory · search · task · model adapter  │
└───────┬───────────────┬───────────────┬──────────────────────┘
        │               │               │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────────┐
│ PostgreSQL   │ │ Redis/BullMQ │ │ Object Storage    │
│ + pgvector   │ │ jobs/queues  │ │ S3 compatible     │
│ transactions │ │ retries      │ │ images/artifacts  │
└──────────────┘ └──────┬───────┘ └───────────────────┘
                        │
        ┌───────────────▼──────────────────────────────────────┐
        │ Workers                                                │
        │ Session Sync · Memory Extract · Embedding · Summary   │
        │ Backup · Dot Scheduler · Dot Resume · Approval        │
        └───────────────┬──────────────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────────────┐
        │ Pi Agent Runtime / SessionManager / Model Adapters   │
        │ DeepSeek · Claude · GPT · Gemini                     │
        └──────────────────────────────────────────────────────┘
```

### 3.2 三种长期资产

| 资产 | 保存内容 | 主要用途 | 生命周期 |
|---|---|---|---|
| Conversation History | 用户/Agent 消息、模型切换、工具调用、压缩点 | 恢复、搜索、回放、审计 | 默认永久，可临时/清空 |
| Knowledge Memory | 偏好、项目事实、决定、经验、工作流程 | 跨会话/跨模型复用 | 可编辑、停用、替代、删除 |
| Execution State | 任务目标、阶段、检查点、审批、环境 | Dot/Code/子代理恢复 | 任务结束可归档/清理 |

不要把它们合并成一个“聊天记录表”，也不要只靠向量库保存记忆。

### 3.3 组件职责

| 组件 | 负责 | 不负责 |
|---|---|---|
| PostgreSQL | 事务、关系、权限、审计、事件 | 大文件、原始图片 |
| pgvector | 语义相似度 | 精确关键词、权限判断 |
| 中文关键词索引 | 精确名称、日期、错误码 | 同义改写 |
| Redis/BullMQ | 异步任务、重试、调度 | 权威业务数据 |
| 对象存储 | 图片、附件、截图、大工具输出 | 记忆正文 |
| Pi Runtime | Agent Loop、工具调用 | 长期记忆业务规则 |
| Context Builder | 组合可移植上下文 | 保存原始会话 |
| Memory Extractor | 候选记忆 | 最终权限和冲突决策 |
| Memory Validator | 来源、重复、冲突、隐私 | 业务展示 |
| Dot Worker | 执行长任务 | 用户界面 |

### 3.4 请求链路

```text
用户发送消息
  → 写入用户消息事件（Pi JSONL / 运行时）
  → 异步同步到 PostgreSQL（稳定 ID、幂等）
  → LLM 提取记忆（同步，失败可见，不回退规则）
  → 入队 Embedding/索引
  → 读取当前任务状态
  → Context Builder 读取：模型 profile + 项目/全局记忆
     + 任务状态 + 会话摘要 + 最近消息 + 可用工具
  → 发送模型请求
  → 流式回复、工具事件、模型切换事件写入
  → 完成后异步更新索引、记忆候选、任务进度
```

---

## 4. 数据模型

以下为**目标版建议结构**，不是当前已执行 SQL。

### 4.1 关系图

```text
users
 ├── projects
 │    ├── project_members
 │    ├── conversations
 │    │    └── session_events
 │    ├── memory_items
 │    │    └── memory_sources
 │    ├── search_chunks
 │    ├── agent_tasks
 │    │    ├── task_checkpoints
 │    │    ├── task_approvals
 │    │    └── task_leases
 │    └── artifacts
 ├── global memory_items (project_id is null)
 ├── audit_events
 └── idempotency_keys / job_outbox
```

### 4.2 核心表

```sql
-- 用户与项目
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  memory_mode text not null default 'scoped', -- scoped | global_opt_in
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','editor','viewer')),
  primary key (project_id, user_id)
);

-- 会话
create table conversations (
  id uuid primary key,
  project_id uuid references projects(id) on delete set null,
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  current_leaf_event_id uuid,
  temporary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table session_events (
  event_id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  parent_event_id uuid,
  sequence bigint not null,
  type text not null, -- message | tool_call | tool_result | model_change | compaction | branch...
  role text,          -- user | assistant | tool | system
  content jsonb not null,
  model_id text,
  provider_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence)
);
```

`session_events.content` 保存结构化消息/工具结果；大文件放对象存储，只在事件里保存引用。

### 4.3 长期记忆

```sql
create table memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade, -- null = global
  kind text not null check (kind in ('fact','preference','decision','note')),
  text text not null,
  key text,
  status text not null default 'active'
    check (status in ('active','disabled','superseded')),
  pinned boolean not null default false,
  source text not null default 'user'
    check (source in ('user','automatic')),
  version int not null default 1,
  supersedes uuid[] not null default '{}',
  superseded_by uuid,
  embedding_model text,
  embedding_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memory_sources (
  memory_id uuid not null references memory_items(id) on delete cascade,
  conversation_id uuid,
  event_id uuid,
  message_id text,
  source_span text,
  confidence numeric,
  primary key (memory_id, conversation_id, event_id)
);
```

### 4.4 搜索与向量

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

create table search_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  event_id uuid references session_events(event_id) on delete cascade,
  source_kind text not null check (source_kind in ('message','memory','artifact')),
  source_id uuid,
  content text not null,
  content_ngrams text[] not null default '{}',
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector(1024),
  embedding_model text,
  embedding_version int,
  created_at timestamptz not null default now()
);

create index search_chunks_fts_idx on search_chunks using gin (fts);
create index search_chunks_ngrams_idx on search_chunks using gin (content_ngrams);
create index search_chunks_embedding_idx on search_chunks
  using hnsw (embedding vector_cosine_ops);
```

说明：

- `vector(1024)` 只是示例，必须与实际 Embedding 模型维度一致；不同维度不能共用同一列。
- 中文检索建议用字符二元组/三元组 + `pg_trgm`，不要只依赖默认英文分词。
- HNSW 参数（`m`、`ef_construction`）需用真实数据评估召回和延迟。
- 重新选择 Embedding 模型时需要重建索引；旧版本保留 `embedding_model/version` 以支持灰度。

### 4.5 任务与检查点

```sql
create table agent_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  goal text not null,
  status text not null default 'queued'
    check (status in ('queued','running','waiting_approval','paused','resuming','completed','failed','cancelled')),
  current_stage text,
  completed_steps jsonb not null default '[]',
  next_action text,
  last_checkpoint_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table task_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  stage text not null,
  completed_operations jsonb not null default '[]',
  environment jsonb,
  file_versions jsonb,
  git_commit text,
  pending_approval_id uuid,
  next_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table task_leases (
  task_id uuid primary key references agent_tasks(id) on delete cascade,
  worker_id text not null,
  lease_until timestamptz not null,
  heartbeat_at timestamptz not null
);

create table task_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  action text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table idempotency_keys (
  key text primary key,
  task_id uuid,
  operation text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
```

### 4.6 权限与 RLS

至少需要：

- `users` 只能访问自己的数据。
- `projects` 通过 `owner_id` 或 `project_members` 授权。
- `memory_items` 的项目作用域必须同时满足项目成员/所有者。
- `search_chunks` 必须带 `user_id`，不能跨用户检索。
- 搜索和 Context Builder 在查询前检查授权，而不是查到后在 UI 隐藏。
- 管理后台/服务账号使用单独权限，不复用用户 token。

示例策略（示意）：

```sql
alter table memory_items enable row level security;

create policy memory_owner_or_project_member on memory_items
for select using (
  user_id = current_setting('app.user_id')::uuid
  and (
    project_id is null
    or exists (
      select 1 from project_members pm
      where pm.project_id = memory_items.project_id
        and pm.user_id = current_setting('app.user_id')::uuid
    )
  )
);
```

实际实现还要覆盖 `insert/update/delete`，并避免 `current_setting` 被注入。

### 4.7 迁移与版本

- 使用迁移工具（如 `node-pg-migrate`、Flyway 或 Prisma Migrate）管理 schema。
- 每次迁移必须有向前和回滚说明；生产迁移前先备份。
- 数据迁移使用稳定事件 ID 和幂等写入。
- 当前 JSON 仓库作为 V1 导入源：一次性导入后设为只读归档，不双写。
- 不允许 JSON 和 PostgreSQL 各自独立修改成为两个“真相来源”。

### 4.8 目标 HTTP API 草案

完整版建议把当前本地 IPC 的业务语义迁移为服务端 API；桌面端仍可保留一层本地 IPC 作为 UI 适配，但不再直接读写仓库文件。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/v1/auth/device` | 桌面设备换取短期访问令牌 |
| `GET` | `/v1/projects` | 项目列表/权限 |
| `POST` | `/v1/conversations` | 新建会话 |
| `GET` | `/v1/conversations/:id/events?cursor=` | 按游标读取事件 |
| `POST` | `/v1/conversations/:id/events` | 幂等追加事件 |
| `POST` | `/v1/chat/stream` | 发送消息并流式返回 |
| `POST` | `/v1/memory/query` | 关键词/混合检索 |
| `POST` | `/v1/memory/context` | 构建可注入记忆 |
| `POST` | `/v1/memory/items` | 手动保存记忆 |
| `PATCH` | `/v1/memory/items/:id` | 编辑/停用/置顶 |
| `DELETE` | `/v1/memory/items/:id` | 删除记忆并传播 |
| `GET` | `/v1/memory/settings` | 读取设置 |
| `PATCH` | `/v1/memory/settings` | 更新设置 |
| `GET` | `/v1/tasks` | Dot 任务列表 |
| `POST` | `/v1/tasks` | 创建任务 |
| `POST` | `/v1/tasks/:id/checkpoints` | 写入检查点 |
| `POST` | `/v1/tasks/:id/approve` | 审批操作 |
| `POST` | `/v1/admin/backups` | 触发备份/恢复演练 |
| `GET` | `/v1/health` | 健康检查（不含敏感信息） |

约定：

- 写接口支持 `Idempotency-Key`，重复提交返回同一结果。
- 列表使用游标分页，不用 offset 扫大表。
- 错误响应统一为 `{ code, message, requestId }`，不返回上游密钥/响应体。
- `requestId` 贯穿日志、任务和审计。
- 流式接口使用 SSE；工具事件/模型切换事件沿用当前事件类型。
- 所有查询先做用户/项目授权，再做检索。

---

## 5. 会话与 Pi SessionManager

### 5.1 事件模型

建议事件类型：

| 类型 | 内容 | 是否参与上下文 |
|---|---|---|
| `message` | 用户/assistant 正文、图片引用 | 是 |
| `tool_call` | 工具名、参数、调用 ID | 是（按预算裁剪） |
| `tool_result` | 结果或对象存储引用 | 是（可截断） |
| `model_change` | 提供商、模型、思考档位 | 用于恢复/审计 |
| `compaction` | 压缩前事件 ID、摘要、保留边界 | 用于恢复/审计 |
| `branch` | 父事件、分支名 | 用于恢复 |
| `task_event` | 任务阶段/检查点关联 | 按需 |

### 5.2 同步

原则：

1. Pi JSONL 是运行时权威记录；同步 Worker 将事件写入 PostgreSQL。
2. 事件 ID 必须稳定；建议使用 Pi 原生 ID，若没有则生成并写回。
3. 同步使用幂等 upsert：`event_id` 唯一，重复投递不重复插入。
4. 同步失败进入重试队列，不能阻塞聊天主流程。
5. 保存 `parent_event_id` 和 `sequence`，支持分支和重建。
6. 大工具输出进入对象存储，事件只保存引用、摘要、哈希。
7. 不在应用内直接覆盖 `session.agent.state.messages` 来“假装恢复”。

### 5.3 恢复

```text
选择会话
  → 从 PostgreSQL 读取事件（按分支/序列）
  → 由 SessionManager 装载事件
  → 校验模型配置、工具可用性、待处理审批
  → 重建 Context Builder 的最近消息/摘要
  → 标记未完成工具调用和中断状态
```

恢复时必须：

- 不把旧模型专有推理块直接传给新模型。
- 标记中断的流式回复。
- 对未完成的文件写入、发布、支付等操作做状态核对，避免重复执行。
- 保留用户可见消息、工具结果、模型切换点。

### 5.4 模型切换

| 模型 | 原生推理状态处理 |
|---|---|
| OpenAI | 可使用 Responses API 的响应链/兼容推理项；不保证跨模型家族可用 |
| Claude | 需要协议签名 Thinking Blocks；不能随意伪造 |
| Gemini | 工具调用可能依赖 Thought Signatures |
| DeepSeek | 正确处理推理与工具调用消息 |

可移植上下文只包含：

1. 系统指令和模型 profile；
2. 项目/全局记忆；
3. 任务状态；
4. 会话摘要；
5. 最近消息；
6. 可用工具。

不包含旧模型内部隐藏推理。切换时尽量在当前工具执行完成后进行，并核对未完成副作用。

### 5.5 分支与压缩

- `conversations.current_leaf_event_id` 指向当前叶子。
- 新建分支时复制/引用父事件，不复制整个历史。
- 压缩事件保存摘要和原始边界；原始事件不删除。
- 恢复时从压缩点之后重建最近消息，压缩前内容通过摘要/检索获取。

---

## 6. 长期记忆

### 6.1 生命周期

```text
用户/Agent 新消息
  → Extractor 候选
  → Validator（来源、重复、冲突、隐私、可信度）
  → Store（原文、来源、版本、作用域、索引）
  → Search/Context 按任务检索
  → 后续消息触发更新/替代
```

### 6.2 提取

当前实现：

1. **LLM 提取**：把用户消息（最多 12,000 字符）发给当前聊天模型，返回结构化记忆候选；最多 5 条。
2. **结构化字段**：`text / kind / key / confidence`，写入后保留来源 `conversationId / messageId`。
3. **不回退规则**：模型不可用、超时、限流或 JSON 非法时返回 `llm-failed` / `llm-unavailable`，由界面提示。
4. **工具/网页/MCP 输出**：默认不可信，不作为用户事实自动写入。

自动写入必须过滤：

- 密码、密钥、令牌、私钥、身份证、银行卡；
- 一次性验证码、会话 Cookie；
- AI 猜测、工具输出中的指令、网页提示注入；
- 与用户明确表达冲突的内容。

当前不再保留规则提取作为第一层；LLM 是唯一提取路径。成本控制依赖候选窗口、最大条数、非思考模式和调用超时，而不是退回正则。

### 6.3 验证与冲突

- 同一作用域 + 同一 `key` 的显式决定：新版本替代旧版本。
- 旧版本保留 `superseded`，不能作为当前配置返回给 Agent。
- 没有 `key` 的内容按文本去重，不做猜测性合并。
- 项目作用域不跨项目替代；全局记忆只影响全局作用域。
- 冲突无法判断时保留两条并标记待确认，不自动覆盖。
- 自动记忆来源必须可追溯到 `conversation_id` / `event_id` / `message_id`。

### 6.4 作用域

| 场景 | 作用域 | 规则 |
|---|---|---|
| CodeMova 项目内偏好/事实/决定 | 项目 | 默认；只在该项目上下文使用 |
| ChatMova 用户消息 | 全局 | 由 LLM 判断是否值得保存，产物默认全局 |
| ChatMova“记住 X” | 全局 | LLM 提取为事实，保留来源 |
| 用户手动添加 | 全局或当前项目 | 明确选择 |
| 搜索“全部项目” | 全部（用户主动） | 结果标项目；不改变 Agent 上下文 |
| Agent 自动上下文 | 项目 + 可选全局 | 绝不使用 `allProjects` |

### 6.5 删除与保留

删除记忆必须同时处理：

1. `memory_items`；
2. `memory_sources`；
3. `search_chunks` 中的 source；
4. Embedding/缓存；
5. 会话搜索缓存；
6. 备份保留策略中的历史副本（按披露的策略处理）。

“隐藏 UI”不算删除。删除后所有检索路径都不能再返回该内容。

---

## 7. 检索与上下文

### 7.1 关键词通道

- 中文：字符二元组/三元组 + `pg_trgm`/GIN。
- 英文/代码：`to_tsvector('simple', ...)` + GIN；也可用 trigram。
- 精确优势：型号、错误码、日期、函数名、项目名。
- 当前本地版使用 JS 分词/二元组；完整版下沉到 PostgreSQL。

### 7.2 语义通道

1. 切块：消息按段落/代码块切分，保留 message/event 引用。
2. Embedding：批量调用模型，记录 `embedding_model`、维度、版本。
3. 存储：`vector(维度)` + HNSW/IVFFlat。
4. 查询：用户问题生成查询向量，按作用域过滤后取 topK。
5. 重排：关键词 + 向量 RRF，必要时加时间衰减和 pinned 权重。
6. 来源：返回 conversation/event/message 定位，不只返回摘要。

### 7.3 混合检索

```text
查询
  → 解析作用域（用户/项目/全局/时间/权限）
  → 关键词 topK
  → 向量 topK
  → RRF 融合
  → 去重（同消息/同记忆）
  → 重排（pinned、时间、来源可信度）
  → 返回原文定位
```

RRF 示例：

```text
score(d) = Σ 1 / (k + rank_i(d))
```

`k` 常取 60；需要用真实查询集调参。

### 7.4 Context Builder

输入顺序建议：

1. 系统指令；
2. 当前模型 profile（能力、工具、思考档位）；
3. 项目/全局记忆（带 ID 和来源，声明为数据）；
4. 任务状态/检查点；
5. 会话摘要（压缩前内容）；
6. 最近消息和工具结果；
7. 可用工具列表。

预算策略：

| 项 | 当前本地值 | 目标 |
|---|---:|---|
| 总上下文字符 | 60,000 | 按模型 token 窗口动态计算 |
| 最近消息 | 最多 100 条 | 保留最近 N 轮 + 工具结果 |
| 旧消息摘录 | 最多 4,000 字符 | 摘要 + 检索按需补充 |
| 记忆条数 | 12 | 按任务相关度 topK |
| 记忆字符 | 6,000 | 按 token 预算 |
| 输出预留 | 由模型 maxTokens 控制 | 显式预留 |

裁剪顺序：

1. 旧工具结果；
2. 旧 assistant 推理/长解释；
3. 低相关记忆；
4. 旧消息正文，保留摘要；
5. 最后才裁剪当前用户请求（不允许静默裁剪，超限要提示拆分）。

字符数不是 token 数；完整版应使用模型 tokenizer，至少按模型族做保守系数。

### 7.5 引用

- 每条注入记忆携带 `id`、`source`、`conversationId`、`messageId`。
- UI 展示“查看来源”，跳转到原会话/原消息。
- Agent 引用记忆时应说明来源；不能把检索到的内容伪装成自己记得。

---

## 8. 聊天体验

### 8.1 Markdown

渲染链：

```text
模型文本
  → react-markdown + remark-gfm
  → skipHtml
  → 链接 allowlist（http/https/mailto）
  → 代码块语言/复制
  → 流式增量重渲染
```

规则：

- 不执行原始 HTML；
- 远程图片只显示 alt，避免泄露 IP/会话内容；
- 相对链接、`javascript:`、协议相对 URL 一律不激活；
- 代码块内容只作为文本，不执行；
- 复制走桌面剪贴板 IPC，失败要提示手动选择；
- 未闭合围栏在流式中可渲染。

### 8.2 失败重试

状态机：

```text
streaming
  ├── done
  ├── stopped
  ├── interrupted
  └── error
        └── retry → streaming（保留旧 attempt）
```

要求：

- 重试复用原用户消息和图片引用，不重复插入消息；
- 重试期间禁用重复点击；
- 旧 attempt 保留有限数量，避免快照无限膨胀；
- 图片-only 失败消息不能只靠文字重试，要提示重新上传；
- 权限/模型不存在等不可重试错误应引导设置，而不是盲目重试。

### 8.3 长对话

- 前端：60 轮分页；来源跳转可展开隐藏轮次。
- 后端：60,000 字符预算；保留最新用户请求原文。
- 更早内容：头部/尾部摘录，明确告知“不是完整摘要”。
- 完整历史永远保留，不因压缩删除。
- 单条超预算：报 `input_too_long`，要求拆分。
- 未来：模型 token 预算、摘要 Worker、检索补充。

### 8.4 能力与权限提示

聊天页不再提供「模型能力与隐私」折叠面板，同样的信息改为可查到的入口，不在输入框上方堆说明文字：

- 当前模型名称与思考档位：输入框右侧的模型菜单；「Token 用量」只显示数字，不重复模型信息；
- 文件/终端/电脑控制是否可用、项目已获得的权限：设置 → 记忆与存储、设置 → 电脑操作；
- 联网搜索是否开启、搜索词会发给谁：设置 → 模型 → 联网搜索；
- 消息、图片、记忆会发给当前提供商：设置 → 配置 → 数据与隐私；
- 临时聊天不保存、不提取、不注入：标题后的灰色「临时聊天」标记；
- 长对话预算与模型切换限制见 §8.3。

不能显示“完整访问权限已开启”这类与实际能力不符的状态。

### 8.6 目标与自动推进

目标 / 计划不是装饰：它们决定一轮回复结束后要不要自己再开一轮。

工具（每轮都提供，目标跨轮存在，请求里带回 `aim`）：
- `set_goal`：发布或替换唯一目标；新目标 `accepted=false`。
- `accept_goal`：模型接受目标，只有接受过的目标才会被自动推进。
- `update_goal`：`active / paused / done / blocked` + `summary`；`done` 与 `blocked` 同时停止推进。
- `set_plan`：写入完整步骤列表（最多 12 步，只有一个 `active`）。

每轮结束后的判定（渲染端，纯函数 `goalRoundDecision`）：
- 收尾状态不是 `done`（用户停止 / 失败 / 中断）→ 不继续；
- 目标缺失、未接受、`paused / done / blocked`、或「自动推进」被关掉 → 不继续；
- 连续两轮没有任何 goal / plan 更新 → 判定没有进展，停止并把目标标为暂停；
- 单次目标上限 6 轮（用户手动发消息会重置预算）；
- 否则自动发一轮内部消息：对话里只显示灰色「自动继续 · 第 n/6 轮」，正文说明目标、当前计划与结束方式。

自动推进只在目标所在会话处于前台、且没有其它生成在跑时触发；暂停、受阻、达到上限都会给出可见的说明，不会静默失败。

### 8.5 临时聊天

- 入口只在新聊天出现：标题栏「⋯」右侧的隐私图标；开始聊天后图标消失，标题后保留灰色「临时聊天」；
- 只有新聊天可开启，会话开始后不能中途切换；
- 不写入会话快照；
- 不上传图片到磁盘（内存临时区，重启即失效）；
- 不提取记忆；
- 不读取/注入已有记忆；
- 关闭后不可恢复。

---

## 9. 设置页「记忆与存储」规范

### 9.1 长期记忆

| 设置 | 类型 | 默认 | 行为 |
|---|---|---:|---|
| 启用长期记忆 | 开关 | 开 | 关闭后不注入；提取不写入 |
| 自动提取记忆 | 开关 | 开 | 默认无需逐条确认；可编辑/停用/删除 |
| 包含全局记忆 | 开关 | 开 | 项目上下文是否带全局记忆 |
| 上下文记忆条数上限 | 数字 1–100 | 12 | 单次注入最大条数 |
| 上下文记忆字符上限 | 数字 1–20000 | 6000 | 单次注入最大字符 |
| 记忆总条数上限 | 数字 1–10000 | 2000 | 超过后自动提取暂停 |
| 历史保留 | 只读/选择 | 永久 | 当前只支持永久；未来支持 30/90/365 天 |

### 9.2 记忆管理

- 查看范围：当前项目 / 全局。
- 手动添加：范围（当前项目/全局）、类型（事实/偏好/决定/备注）。
- 编辑、置顶、停用/启用、删除。
- 显示状态（生效/已停用/已被替代）、版本、替代关系。
- 显示来源按钮；无来源标注“手动记忆”。
- 删除需要确认；不可撤销。

### 9.3 历史搜索

- 搜索范围：当前项目 / 全局 / 全部项目。
- 当前项目可选“包含全局结果”。
- 中文关键词；说明不是语义搜索。
- 结果标明项目/全局、消息或记忆类型。
- 点击来源直接打开原会话并定位。
- “全部项目”是用户主动操作，不进入 Agent 自动上下文。

### 9.4 本地存储与备份

- 显示实际仓库路径。
- 显示记忆/会话/任务/检查点/事件数量和估算大小。
- 手动导出：未加密 JSON，常见凭据格式遮盖；提示历史正文仍可能含私人信息。
- 清空记忆：保留历史。
- 清空历史：保留记忆但来源可能失效。
- 危险操作需输入确认词。
- 未来：自动备份、备份加密、恢复向导、保留策略。

### 9.5 服务版新增设置（已实现六组）

| 设置 | 当前行为 |
|---|---|
| 服务连接与健康状态 | 显示 PostgreSQL/Redis/MinIO/Embedding、队列积压；自动启动本机服务；检测连接 |
| 自动备份与恢复 | 每日 03:00/12:00、每周一 03:00 或关闭；保留 1–365 天；立即逻辑备份、选择已完成备份恢复；WAL 归档/PITR 通过 `scripts/pitr.mjs` 恢复到新集群 |
| Embedding 与索引 | `Xenova/multilingual-e5-small`、384 维、加载状态、重建索引、失败原因 |
| 语义检索与混合权重 | 语义开关、向量/关键词权重（默认各 0.5）、通道状态和说明 |
| 记忆提取模式 | LLM / 关闭；使用当前聊天模型，失败时明确报错，不回退规则 |
| 存储配额与服务状态 | 数据库大小、附件/对象存储、队列等待/失败、记忆/会话/事件数、配额上限（当前只展示，未强制写入） |

未实现的设置：团队与成员、Dot 预算与审批、外部工具权限（文件/终端/电脑控制）；PITR 时间点选择只在 CLI，附件备份/异地归档未实现。

---

## 10. 后台任务与 Dot

### 10.1 队列

| 队列 | 任务 | 重试 | 幂等键 |
|---|---|---|---|
| `session.sync` | JSONL → PostgreSQL 事件同步 | 指数退避 | `event_id` |
| `memory.extract` | 从消息提取候选 | 2–3 次 | `conversation_id + event_id` |
| `memory.embed` | 生成/更新向量 | 3 次 | `chunk_id + model_version` |
| `memory.reindex` | 模型升级/全量重建 | 手动触发 | `index_version` |
| `summary.generate` | 长会话摘要 | 2 次 | `conversation_id + range` |
| `backup.daily` | 数据库/对象备份 | 3 次 | `backup_date` |
| `dot.schedule` | 定时任务入队 | 由调度器 | `task_id + occurrence` |
| `dot.resume` | Worker 恢复任务 | 有限次 | `task_id + checkpoint_id` |
| `artifact.cleanup` | 临时文件清理 | 2 次 | `artifact_id` |

### 10.2 任务状态机

```text
created → queued → running
                 ├── waiting_approval → approved → running
                 ├── paused → resuming → running
                 ├── completed
                 ├── failed
                 └── cancelled
```

### 10.3 Checkpoint

必须保存：

- 任务/子任务 ID；
- 已完成并验证的操作；
- 当前 Worker/执行环境；
- 文件版本、Git commit；
- 待审批操作；
- 下次运行时间和恢复条件；
- 外部操作幂等键。

### 10.4 Worker 恢复

```text
Worker 启动
  → 获取 lease（带过期时间）
  → 读取最新 checkpoint
  → 核对已完成操作
  → 核对未完成外部副作用
  → 重新入队当前阶段
  → 心跳续租
```

强制要求：

- 同一任务同一时刻最多一个有效 lease；
- 外部操作必须先写 idempotency key；
- 崩溃重试不能重复发布/支付/发送；
- 无法确认状态时进入 `waiting_approval`，不要猜测继续；
- 恢复过程写入审计事件。

### 10.5 定时与审批

- BullMQ Job Schedulers 创建定时任务，不使用已过时的 repeatable-job API。
- 审批操作进入 `task_approvals`，Worker 等待批准，不轮询用户界面。
- 用户拒绝后任务转为 cancelled 或等待新指令。
- 审批超时可配置，默认不自动批准。

---

## 11. 安全、隐私、备份与恢复

### 11.1 威胁模型

- 本机其他账户读取 JSON；
- 备份文件泄露；
- Embedding/提取模型收到敏感内容；
- 项目 A 记忆泄露到项目 B；
- 搜索绕过权限；
- 网页/MCP 提示注入写入记忆；
- Worker 重试导致外部副作用重复；
- 备份删除不彻底。

### 11.2 凭据与敏感内容

- API 密钥只存 Windows 凭据/系统加密存储，不写入仓库。
- 备份导出时遮盖常见密钥格式，并提示可能仍有未识别秘密。
- 记忆提取遇到密码/密钥/令牌整条跳过。
- 日志不得打印完整消息、密钥、Authorization 头。
- 服务版使用 TLS、密钥管理服务、最小权限数据库账号。

### 11.3 自动备份与恢复

目标：

- 每日全量 + WAL 归档，支持时间点恢复；
- 对象存储版本化；
- 备份加密；
- 保留策略：7 天日备、30 天周备、90 天月备（示例，可配置）；
- 每月至少一次恢复演练；
- 删除记忆后，按披露的备份保留策略处理历史副本；
- 恢复后重新验证搜索索引/向量与原文一致。

建议目标（可按实际调整）：

| 指标 | 目标 |
|---|---|
| RPO | ≤ 15 分钟（WAL 连续归档） |
| RTO | ≤ 1 小时（单机/小规模） |
| 备份成功率 | ≥ 99% |
| 恢复演练 | 每月一次，记录结果 |

### 11.4 删除传播

删除路径：

```text
API 删除
  → 标记/硬删 memory_items
  → 删除 memory_sources
  → 删除 search_chunks（含向量）
  → 清除缓存
  → 写入审计
  → 备份按保留策略过期
```

搜索、Context Builder、导出都不能再返回已删除内容。

### 11.5 审计

记录：

- 记忆创建/编辑/停用/删除/替代；
- 设置变更；
- 备份/恢复；
- 任务审批/恢复；
- 模型切换；
- 权限变更。

审计日志避免保存完整敏感正文，保留实体 ID 和操作者。

---

## 12. 当前版与完整版差异

| 维度 | 当前本地版 | 完整服务版 |
|---|---|---|
| 存储 | 单 JSON 快照 | PostgreSQL 事务/行级权限 |
| 历史模型 | 应用快照 | 事件日志 + SessionManager |
| 检索 | 关键词/二元组 | 关键词 + pgvector 混合 |
| 提取 | LLM、同步 | LLM 提取 + LLM 重排、可异步化 |
| 备份 | 手动 JSON | 自动备份 + WAL/PITR |
| 队列 | 无 | Redis/BullMQ |
| 任务恢复 | 仅接口 | Worker + lease + checkpoint |
| 多用户 | 无 | 用户/项目/团队/RLS |
| 规模 | 单机、30MB 快照上限 | 多年、多设备、可扩展 |
| 运维 | 几乎为零 | 数据库/Redis/Worker/备份/监控 |
| 成本 | 仅现有模型调用 | 服务器/Embedding/提取/运维 |
| 隐私 | 全部本机 | 需评估服务端/第三方 Embedding |

---

## 13. 分阶段实施计划

### V0：当前本地 MVP（已完成）

交付：

- Markdown、重试、长对话、能力提示。
- 本地 JSON 会话/记忆、关键词搜索、记忆设置。
- LLM 提取、来源、版本、临时聊天。

验收：

- 重启后会话/记忆存在。
- 搜索能定位原消息。
- 失败可重试。
- 358 项自动测试中 356 项通过、2 项按需跳过（服务版接入后的当前结果）。

### V1：PostgreSQL 会话与记忆

交付：

- 抽象 `MemoryRepository` 接口，增加 PostgreSQL adapter。
- `users/projects/conversations/session_events/memory_items/memory_sources`。
- JSON 一次性迁移工具，导入后归档只读。
- 本地/远程模式配置；连接失败回退只读，不静默写本地。

验收：

- 重新启动、并发写入、事务回滚正确。
- 迁移前后数量/哈希一致。
- 项目隔离与来源跳转不变。
- 不出现 JSON/PostgreSQL 双写冲突。

回滚：

- 保留导入前 JSON 快照；关闭远程适配器回退只读。

### V2：Embedding 与混合检索

交付：

- Embedding Worker、`search_chunks`、pgvector 索引。
- 关键词 + 向量 RRF；语义开关。
- 中文分词/ngram；重建索引命令。
- 检索评估集（至少 50 条真实问题）。

验收：

- 换说法查询能命中；精确错误码仍能命中。
- 跨项目零泄露。
- p95 检索延迟达标；索引失败可重试。
- 模型升级可灰度重建。

### V3：异步任务、自动备份、记忆提取升级

交付：

- Redis/BullMQ；提取/Embedding/摘要/备份队列。
- 自动备份、WAL/PITR、保留策略、恢复演练。
- LLM 提取已落地；每日预算、审核队列和隐私开关仍待补。

验收：

- Worker 崩溃重试不重复写入。
- 备份可恢复到指定时间点。
- 删除传播到索引/缓存/备份策略。
- 队列积压和失败可见。

### V4：Pi SessionManager 与 Dot Worker

交付：

- Pi JSONL 事件同步、SessionManager 恢复、分支/压缩。
- Dot 任务状态机、lease、checkpoint、审批、调度。
- 强制重启/断电恢复演练。
- 外部操作幂等与对账。

验收：

- 分支会话可恢复。
- 强制重启 Worker 后不重复外部操作。
- 等待审批的任务恢复后仍等待。
- 无法确认状态时进入人工审批，不猜测继续。

### 工作量级（粗略，不含长期运维）

| 阶段 | 规模 | 主要不确定性 |
|---|---|---|
| V1 | 中 | schema、迁移、双模式切换 |
| V2 | 中/大 | Embedding 供应商、中文召回、重排 |
| V3 | 大 | 队列幂等、备份恢复、删除传播 |
| V4 | 很大 | Pi 事件兼容、外部副作用、安全审批 |

不要把 V1–V4 合并成一次上线；每阶段都要有可回滚点和验收数据。

---

## 14. 测试计划

### 14.1 已有自动测试（当前）

- Markdown 语法、GFM 表格、代码围栏、链接 allowlist、HTML/图片安全。
- 流式每个前缀可渲染。
- 聊天分页、稳定 ID、重试门控。
- 长对话预算、超长输入拒绝。
- 记忆仓库：原子写、并发、损坏保护、快照、提取、作用域、替代、搜索、上下文、任务/检查点、IPC 授权。
- Pi 模型请求、Anthropic 流、思考档位、AnySearch 安全。

### 14.2 完整版新增测试

| 类别 | 用例 |
|---|---|
| 数据库 | 事务回滚、并发会话、迁移、RLS、索引 |
| 事件 | 幂等同步、乱序、重复、分支、压缩恢复 |
| 记忆 | 冲突替代、跨项目隔离、删除传播、敏感过滤 |
| 检索 | 关键词/向量/RRF、中文、精确代码、空结果 |
| 备份 | 全量/增量、PITR、恢复演练、加密、保留 |
| 队列 | 重试、退避、死信、重复投递、Worker 崩溃 |
| Dot | lease 过期、checkpoint、审批、重复外部操作 |
| 安全 | 提示注入、越权搜索、日志泄露、备份泄露 |
| 性能 | 检索 p95、上下文构建、队列延迟、数据库连接 |

### 14.3 性能目标（建议）

| 指标 | 本地 | 服务版 |
|---|---|---|
| 搜索 p95 | < 150ms | < 800ms |
| 上下文构建 p95 | < 100ms | < 300ms |
| 队列延迟 p95 | — | < 30s（非紧急） |
| 会话打开 | < 500ms | < 1s |
| 崩溃恢复 | 手工 | < 5 分钟（非 Dot） |
| Dot 恢复 | — | < 10 分钟 |

这些是工程目标，不是当前实测值。

### 14.4 验收数据

- 真实中文查询集（同义改写、精确错误码、项目名、日期）。
- 100 万级消息的导入/检索压测。
- 备份恢复演练记录。
- 强制 kill Worker 的恢复记录。
- 跨项目/跨用户越权测试报告。

---

## 15. 观测与运维

必须可观测：

- 数据库连接数、慢查询、锁等待、复制延迟；
- 队列长度、失败率、重试次数、死信；
- Embedding 调用量、失败、延迟、费用；
- 记忆提取数量、敏感跳过、冲突；
- 备份成功/失败/耗时；
- Worker 心跳、lease 过期；
- 搜索 p95、空结果率、点击来源率；
- 删除任务完成情况。

告警：

- 备份连续失败；
- 队列积压超过阈值；
- Worker 无心跳；
- 数据库磁盘/连接耗尽；
- Embedding 费用异常；
- 搜索跨项目异常（应为 0）。

---

## 16. 成本

### 16.1 软件

PostgreSQL、pgvector、BullMQ、Electron、React 通常无许可费；Redis 需注意当前许可证，可考虑 Valkey。Pi SDK 按其官方授权确认。托管服务另计费。

### 16.2 本地自托管

- 月费约 0；
- 成本是现有电脑的 CPU/内存/硬盘/电费；
- 需要电脑在线才有 24/7 Dot/备份；
- 可用本地盘/NAS 做备份。

### 16.3 云端

- VPS：几十元/月起；
- 托管 PostgreSQL/Redis：按配置计费；
- 对象存储：容量 + 流量；
- Embedding API：按 token，建索引/重建索引会重复产生；
- LLM 提取：按消息，长期运行累积；
- Dot：每步模型调用，长任务可能显著；
- 监控/备份/跨区：额外。

### 16.4 最大隐性成本

迁移、备份恢复演练、权限、Worker 幂等、监控和故障处理的人力，通常高于软件/服务器费用。

---

## 17. 风险与待决策

| 风险 | 影响 | 缓解 |
|---|---|---|
| JSON/PostgreSQL 双真相 | 数据冲突/丢失 | 单一权威源；导入后 JSON 只读 |
| Pi 事件兼容性 | 恢复不完整 | 以 Pi 原生事件为准；适配层测试 |
| Embedding 模型变更 | 召回下降 | 版本化、灰度重建、保留旧索引 |
| 队列重复执行 | 重复副作用 | 幂等键、lease、审批、对账 |
| 备份不可恢复 | 宣称的安全无效 | 定期恢复演练 |
| 跨项目泄露 | 隐私事故 | RLS、查询前授权、越权测试 |
| 提示注入写入记忆 | 污染 | 工具/网页默认不可信；候选审核 |
| 成本失控 | 账单/体验 | 配额、预算、缓存、批量 |
| 过度工程 | 延期 | 分阶段，先 V1 再向量/队列 |

待决策：

1. 部署在现有电脑还是云服务器？
2. Embedding 用本地模型还是第三方 API？
3. 记忆提取是否引入 LLM，还是保持规则？
4. 是否需要多用户/团队，何时需要？
5. 备份保留期限和是否加密？
6. Pi SDK 的授权/商业使用条款。
7. Dot 允许执行的外部操作范围与审批策略。

---

## 18. 附录

### A. 当前文件索引

```text
app.js
index.html
styles.css
README.md
Mova长期记忆与聊天体验开发文档.md
src/features/chat/
  chat-transcript.tsx
  chat-reply.ts
  context-budget.mjs
  markdown-renderer.js
  markdown.jsx
  markdown.css
src/features/memory/
  memory-settings.jsx
  memory-settings.css
electron/
  main.cjs
  preload.cjs
  memory-store.cjs
  memory-ipc.cjs
  chat-agent.mjs
  chat-images.cjs
  model-ipc.cjs
tests/
  markdown.test.mjs
  markdown-transcript.test.mjs
  context-budget.test.mjs
  memory-store.test.mjs
  chat-context.test.mjs
  pi-chat.test.mjs
  ...
qa/
  launch-memory-smoke.cjs
  seed-memory-preview.cjs
  memory-smoke-script.js
```

### B. 聊天错误码

`auth`、`not_configured`、`invalid_key`、`credential`、`not_found`、`rate_limit`、`upstream`、`timeout`、`network`、`empty`、`interrupted`、`protocol`、`request`、`history`、`input_too_long`、`busy`、`image_type`、`image_size`、`image_unsupported`、`tool_limit`、`model_access`、`model_region`、`invalid_url`、`duplicate`、`no_models`、`provider_limit`、`empty_catalog`。

### C. 未来环境变量（示例，不含真实密钥）

```dotenv
DATABASE_URL=postgres://mova:password@127.0.0.1:5432/mova
PGVECTOR_ENABLED=1
REDIS_URL=redis://127.0.0.1:6379
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=mova-artifacts
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024
MEMORY_EXTRACTOR=rules
BACKUP_DIR=/var/backups/mova
BACKUP_RETENTION_DAYS=30
```

### D. 术语表

- **Local MVP**：当前单机 JSON 版。
- **Service Edition**：PostgreSQL + pgvector + Redis 的完整版。
- **Scope**：全局或项目。
- **Provenance**：记忆来源。
- **RRF**：混合检索融合排序。
- **PITR**：时间点恢复。
- **Lease**：Worker 对任务的租约。
- **Idempotency**：重复执行不产生额外副作用。

---

## 19. 结论

当前版本已经解决了个人单机场景的“能聊天、能记住、能搜索、能修改、能导出”，但不是设计文档中的完整生产架构。

完整版的价值不在于“用了 PostgreSQL”，而在于：

- 事务和权限保证数据不串、不丢；
- 事件日志和 SessionManager 保证可恢复、可审计；
- 向量检索保证换说法也能找到；
- 队列和 Worker 保证长任务可继续；
- 自动备份和时间点恢复保证灾难后可回来。

建议按 V1 → V2 → V3 → V4 分阶段推进；每一阶段都保留回滚点和验收数据，不要一次替换全部基础设施。

---

## 20. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 1.0 | 2026-11-10 | 建立现状基线；记录本地 MVP、目标架构、schema 草案、设置规范、分阶段计划和验收标准 |
