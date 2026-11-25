# Mova 服务版接口约定（开发内部）

> 目标：让多个子代理并行开发时共享同一套数据、IPC 和设置契约。  
> 当前决定：本机 Docker 服务；单用户 + 设备令牌；本地 Node ONNX Embedding；不做 Dot。  
> 本文件优先于口头描述；子代理不得自行改变表名、IPC 名和返回结构。

## 1. 运行拓扑

```text
Electron 主进程
  ├── 启动/检查 Docker 服务（scripts/services.mjs）
  ├── PostgreSQL repository（electron/db/）
  ├── 启动 BullMQ Worker（当前单用户模式在主进程内；worker-entry.mjs 保留为可选子进程入口）
  └── IPC → renderer

Docker Compose
  ├── mova-db      postgres:16 + pgvector，端口 127.0.0.1:55432
  ├── mova-redis   redis:7，端口 127.0.0.1:56379
  └── mova-minio   minio（bitnamilegacy），端口 127.0.0.1:59090/59091

Worker
  ├── BullMQ：memory-extract / memory-index / backup / session-sync
  ├── 本地 Embedding（ONNX）
  └── 备份调度
```

- 不新增独立 HTTP API 服务；Electron 主进程是唯一客户端。原因是单用户本机模式，速度优先。
- 但所有后端代码必须与 Electron 解耦，便于以后搬出为 Node 服务。
- 不实现 Dot 任务、Dot Worker、Dot UI；`agent_tasks/task_checkpoints` 不进入本迭代验收。

## 2. 环境变量

```dotenv
MOVA_MODE=postgres
MOVA_DB_URL=postgres://mova:mova_local_password@127.0.0.1:55432/mova
MOVA_REDIS_URL=redis://127.0.0.1:56379
MOVA_S3_ENDPOINT=http://127.0.0.1:59090
MOVA_S3_REGION=us-east-1
MOVA_S3_BUCKET=mova-artifacts
MOVA_S3_ACCESS_KEY=mova
MOVA_S3_SECRET_KEY=mova_local_password
MOVA_AUTOSTART_SERVICES=true
MOVA_EMBEDDING_MODEL=Xenova/multilingual-e5-small
MOVA_EMBEDDING_DIM=384
MOVA_EMBEDDING_CACHE_DIR=
MOVA_HF_ENDPOINT=
MOVA_BACKUP_DIR=
MOVA_BACKUP_RETENTION_DAYS=30
MOVA_BACKUPS_DIR=
MOVA_PITR_IMAGE=pgvector/pgvector:pg16
MOVA_DOCKER_CLI=
MOVA_DOCKER_BIN=
```

- 密钥只能来自系统凭据/环境变量，不写入数据库或备份。
- 本地开发默认值可写入 `.env.example`，不得提交真实密钥。

## 3. PostgreSQL schema 契约

Migration 目录：`electron/db/migrations/`，按序号执行；必须幂等/可回滚说明。

已落地增量：

- `002_memory_jobs.sql`：`mova_memory_jobs` 持久提取任务（状态 pending/processing/done/skipped/failed、attempts、last_error、唯一 conversation+message）。
- `003_memory_quality.sql`：记忆增加 `normalized_hash/importance/use_count/last_used_at/observed_at/valid_from/valid_to/expires_at/last_confirmed_at`，新增 `mova_memory_conflicts`。
- `004_memory_job_project.sql`：任务补充 `project_id`，重启恢复时保持项目作用域。
- `005_mova_vault.sql`：`mova_vault` 单行加密信封（salt/nonce/tag/ciphertext），主密码不落库；密文随 `pg_dump` 备份。

### 3.1 表

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

create table mova_users (
  id uuid primary key,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table mova_projects (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  name text not null,
  memory_mode text not null default 'scoped',
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table mova_conversations (
  id text primary key,
  project_id uuid references mova_projects(id) on delete set null,
  owner_id uuid not null references mova_users(id) on delete cascade,
  title text not null,
  temporary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table mova_session_events (
  event_id text primary key,
  conversation_id text not null references mova_conversations(id) on delete cascade,
  parent_event_id text,
  sequence bigint not null,
  type text not null,
  role text,
  content jsonb not null,
  model_id text,
  provider_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, sequence)
);

create table mova_memories (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  project_id uuid references mova_projects(id) on delete cascade,
  kind text not null check (kind in ('fact','preference','decision','note')),
  text text not null,
  key text,
  status text not null default 'active' check (status in ('active','disabled','superseded')),
  pinned boolean not null default false,
  source text not null default 'user' check (source in ('user','automatic')),
  version int not null default 1,
  supersedes uuid[] not null default '{}',
  superseded_by uuid,
  embedding_model text,
  embedding_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table mova_memory_sources (
  memory_id uuid not null references mova_memories(id) on delete cascade,
  conversation_id text,
  message_id text,
  source_span text,
  confidence numeric,
  primary key (memory_id, conversation_id, message_id)
);

create table mova_search_chunks (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  project_id uuid references mova_projects(id) on delete cascade,
  conversation_id text,
  message_id text,
  source_kind text not null check (source_kind in ('message','memory')),
  source_id text,
  content text not null,
  content_ngrams text[] not null default '{}',
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector(384),
  embedding_model text,
  embedding_version int,
  created_at timestamptz not null default now()
);

create table mova_settings (
  owner_id uuid primary key references mova_users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table mova_backups (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  kind text not null check (kind in ('manual','scheduled')),
  path text not null,
  bytes bigint,
  status text not null check (status in ('running','completed','failed')),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

索引：

```sql
create index mova_search_chunks_fts_idx on mova_search_chunks using gin (fts);
create index mova_search_chunks_ngrams_idx on mova_search_chunks using gin (content_ngrams);
create index mova_search_chunks_embedding_idx on mova_search_chunks
  using hnsw (embedding vector_cosine_ops);
create index mova_search_chunks_scope_idx on mova_search_chunks (owner_id, project_id);
create index mova_memories_scope_idx on mova_memories (owner_id, project_id, status);
```

单用户：固定 `owner_id = '00000000-0000-4000-8000-000000000001'`；`mova_users` 启动时 seed 一次。

### 3.2 会话快照映射

当前 renderer 使用 `conversationId` 字符串数组，例如：

```json
["ChatMova", "QA预览", "Markdown 与重试体验"]
```

PostgreSQL 保存：

- `mova_conversations.id` = 原字符串；
- `project_id`：ChatMova 为 null；CodeMova 按项目名找/建 `mova_projects`；
- 每个 turn 生成稳定 `event_id`（优先原 `turn.id`；没有则 uuid），事件类型 `message`；
- `content` 保存 `{ user, reply, attempts }` 原始结构，兼容当前 UI；
- 临时会话不写入。

`read()` 必须返回当前 renderer 兼容结构：

```json
{
  "version": 1,
  "sessions": { "version": 1, "projects": [], "conversations": [] },
  "memories": [],
  "settings": {},
  "events": [],
  "tasks": [],
  "checkpoints": [],
  "storage": { "filePath": "postgres://... (redacted)", "bytes": 0 }
}
```

## 4. Repository 接口契约

文件位置：`electron/db/postgres-repository.cjs`，导出：

```js
createPostgresRepository({ connectionString, ownerId?, embedding, indexer, queue, backup })
```

返回对象必须实现：

```ts
interface MemoryRepository {
  read(): Promise<ReadResult>;
  saveSessions(snapshot): Promise<SessionSnapshot>;
  ingest(input): Promise<{ extracted: Memory[]; skipped?: string; extractor: 'llm'; providerId?: string; modelId?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }>;
  query(input): Promise<SearchHit[]>;
  context(input): Promise<{ memories: Memory[]; text: string; enabled: boolean; usedIds: string[]; estimatedTokens: number; reranked: boolean }>;
  saveMemory(input): Promise<Memory>;
  updateMemory(id, patch): Promise<Memory>;
  deleteMemory(id): Promise<boolean>;
  settings(patch?): Promise<Settings>;
  exportData(): Promise<unknown>;
  clear(input): Promise<unknown>;
  health(): Promise<HealthStatus>;
  stats(): Promise<StorageStats>;
  backup(input?): Promise<BackupRecord>;
  listBackups(): Promise<BackupRecord[]>;
  restore(id): Promise<unknown>;
  reindex(): Promise<{ queued: number }>;
  close(): Promise<void>;
}
```

行为必须兼容当前 `electron/memory-store.cjs` 的语义：

- `projectId` 精确匹配；`null` 是全局；空字符串非法；`allProjects` 只用于用户搜索，不进入 `context`。
- `context.enabled` 表示本次请求是否允许使用长期记忆（总开关关闭或临时聊天为 `false`）。为 `true` 但 `memories` 为空时，只表示“没有匹配的已保存记忆”，不表示跨会话记忆不可用。
- 记忆状态、`key` 替代、来源和敏感内容过滤保持不变；自动提取只使用 LLM，不提供规则回退。
- `query` 返回 `kind: 'memory' | 'session'`；会话命中带 `conversationId/messageId`。
- `context` 文本每行 JSON：`{ id, text, source, conversationId, messageId }`。
- 临时会话/临时记忆不保存、不检索、不注入。
- `saveSessions` 必须过滤临时会话，不产生重复事件。
- `read` 的 `storage.filePath` 不可暴露数据库密码。

## 5. 健康与统计

```ts
type HealthStatus = {
  mode: 'postgres';
  database: 'ok' | 'down' | 'migrating';
  redis: 'ok' | 'down' | 'disabled';
  objectStorage: 'ok' | 'down' | 'disabled';
  embedding: 'ok' | 'loading' | 'down';
  embeddingModel: string;
  embeddingDim: number;
  queueLag: number;
  message?: string;
};

type StorageStats = {
  databaseBytes: number;
  attachmentBytes: number;
  queueWaiting: number;
  queueFailed: number;
  memories: number;
  conversations: number;
  events: number;
  quotaBytes: number | null;
  indexPath: string | null;
};
```

`health()` 不允许抛异常导致设置页崩溃；单项失败返回对应状态。

## 6. Embedding 与索引

- 模型：`Xenova/multilingual-e5-small`，384 维。
- 运行时：`@huggingface/transformers` Node ONNX（不依赖 Python/Ollama）。
- e5 约定：文档/passage 前加 `passage: `，查询前加 `query: `。
- 模型缓存：`MOVA_EMBEDDING_CACHE_DIR` 或 userData/models；首次下载失败时状态为 `down`，检索降级为关键词，不允许伪造向量。
- 批量大小可配置；失败重试；索引写入 `mova_search_chunks`。
- `reindex()` 清空/重建所有 `mova_search_chunks`，后台执行，状态可查。
- 分块：记忆整条；消息按约 800–1200 字符切块，保留 message/conversation 引用；不索引 thinking/tool/mock/临时/敏感内容。

## 7. 混合检索

- 关键词：`tsvector` + 中文 ngram/`pg_trgm`。
- 向量：`embedding <=> queryVector` cosine。
- RRF 融合：`score = Σ 1/(60 + rank)`；权重可配，默认关键词 0.5、向量 0.5。
- 过滤必须在 SQL 层按 `owner_id/project_id` 完成。
- 返回来源；`allProjects` 仅显式搜索。
- 语义关闭或 Embedding down 时自动回退关键词，并在健康状态中显示。

## 8. 队列

- 依赖：`bullmq` + `ioredis`。
- 队列名：`mova-memory-extract`、`mova-memory-index`、`mova-backup`、`mova-session-sync`。
- 任务 ID 必须幂等：
  - extract：`conversationId + messageId`
  - index：`chunkId + embeddingVersion`
  - backup：`date + kind`
  - sync：`eventId`
- 失败重试 3 次，指数退避；死信可查。
- 当前单用户实现由 Electron 主进程启动 BullMQ Worker（使用同一 Redis/数据库）；`worker-entry.mjs` 已实现子进程入口和 IPC ready/error/stopped 协议，后续可切换为独立进程。退出时主进程关闭 Worker。
- 不实现 Dot 队列。

## 9. 备份与恢复

- 使用 `pg_dump`（Docker 容器内或本机客户端）生成 custom/plain SQL；附件目录/对象存储单独归档。
- 默认每日 03:00，保留 30 天；手动备份随时可触发。
- `mova_backups` 记录状态；失败不删除旧备份。
- 恢复：
  1. 仅允许选择已完成备份；
  2. 恢复期间进程内阻止新操作并等待已有仓库操作、Worker、定时任务和索引任务结束；
  3. 覆盖现库还必须有外部独占协调，排除其他进程、外部客户端及绕过仓库的直接数据库访问；当前应用未配置此协调器，故默认拒绝覆盖恢复，不会运行恢复工具；
  4. 恢复服务支持新数据库或经外部协调后明确覆盖现有库，完整性检查由调用方提供，未提供时标记未验证；
  5. 恢复命令使用单事务；若命令执行成功提交后完整性验证失败，不能声称数据库未改变。
- 设置页提供“备份现在/恢复最近备份”，恢复需二次确认。
- WAL/PITR 由 `electron/services/pitr.cjs` + `scripts/pitr.mjs` 提供：`wal_level=replica`、`archive_mode=on`、WAL 绑定到 `MOVA_BACKUPS_DIR/wal`、`pg_basebackup` 到 `base/`；`restore` 只恢复到新卷/新容器，绝不覆盖 live 数据卷。`status --strict` 只有在 WAL 归档、基础备份和一次验证过的恢复都成立时才通过。
- 逻辑备份（`pg_dump`，设置页）与物理 PITR（CLI）是两条独立路径；不要把它们混为一谈。

## 10. 会话事件与 Pi 兼容

- 由于已安装 Pi SDK 没有 `SessionManager`，实现 `electron/services/session-store.cjs`：
  - `appendEvent`, `listEvents`, `loadConversation`, `rebuildMessages`;
  - 稳定 `event_id`、`parent_event_id`、`sequence`；
  - 支持 `message/tool_call/tool_result/model_change/compaction/branch` 类型；
  - 保存模型切换和压缩点；
  - `rebuildMessages` 只重建用户可见消息与工具结果，不复制隐藏推理。
- 命名和接口标注为“兼容 SessionManager 语义”，不得声称是 Pi 官方实现。
- 同步失败可重试；不得让 JSON 快照和 PostgreSQL 双写成为两个权威。

## 11. IPC 扩展

保留现有 11 个 `memory:*` 通道；新增：

| 通道 | 参数 | 返回 |
|---|---|---|
| `memory:health` | 无 | `HealthStatus` |
| `memory:stats` | 无 | `StorageStats` |
| `memory:backup` | `{ kind?: 'manual' }` | `BackupRecord` |
| `memory:backups` | 无 | `BackupRecord[]` |
| `memory:restore` | `{ id }` | `{ restored: true }` |
| `memory:reindex` | 无 | `{ queued: number }` |
| `memory:jobs` | 无 | 最近提取任务元数据（不含原文） |
| `memory:maintenance` | `{ apply?: boolean }` | 维护计划/已应用的归档与合并统计 |
| `vault:status` | 无 | `{ configured, unlocked, count }` |
| `vault:setup` / `vault:unlock` / `vault:lock` | 主密码（lock 无参数） | 保险库状态 |
| `vault:put` / `vault:list` / `vault:get` / `vault:remove` | 记录/名称 | 密文记录元数据或明文（get 仅供复制） |
| `vault:change-passphrase` | `{ oldPassphrase, nextPassphrase }` | 重新加盐加密 |

所有返回仍为 `{ ok: true, value } | { ok: false, error }`；先授权再访问。

## 12. 设置页新增项（已确认）

1. **服务连接与健康状态**：模式、数据库/Redis/MinIO/Embedding 状态、队列积压、自动启动开关、测试连接。
2. **自动备份与恢复**：每日 03:00、保留 30 天、上次备份、备份现在、恢复、状态/错误；WAL/PITR 通过 `scripts/pitr.mjs` 提供，设置页只显示说明。
3. **Embedding 与索引**：模型、维度、加载状态、索引状态、重建索引、失败原因。
4. **语义检索与混合权重**：开关、关键词/向量权重默认各 0.5、测试查询。
5. **记忆提取模式**：LLM / 关闭，默认 LLM；使用当前聊天模型，失败时明确显示错误，不回退规则。
6. **存储配额与服务状态**：数据库大小、附件大小、队列等待/失败、配额上限（`quotaBytes`，0=不限制，1 TiB 上限；写入前检查）。

不做：团队与成员、Dot 预算与审批。

## 13. 禁止事项

- 不提交真实 API 密钥、数据库密码。
- 不把服务状态显示成“已连接”而没有实际探测。
- 不在 Embedding 失败时伪造向量。
- 不在备份恢复失败时删除现有数据。
- 不把 JSON 和 PostgreSQL 同时作为可写权威。
- 不实现 Dot 相关内容。
- 不省略错误处理/测试来换速度。
