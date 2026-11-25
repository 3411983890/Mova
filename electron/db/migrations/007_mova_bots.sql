-- 负责：定义 Mova Bot 身份、会话、四层记忆、隐藏协作事件、任务调度、审批持久化、Outbox 投递与小程序表结构（PostgreSQL）。
-- 不负责：业务逻辑校验、LLM 调度执行或本地 JSON 回退存储（这些由 electron/bots/*.mjs 负责）。
-- 被谁调用：electron/db/migrate.cjs 与 electron/bots/store.mjs。

CREATE TABLE IF NOT EXISTS mova_bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  handle TEXT,
  tag TEXT NOT NULL DEFAULT '通用',
  avatar JSONB NOT NULL DEFAULT '{}'::jsonb,
  role_title TEXT,
  tagline TEXT,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  builtin BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  persona_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  proactive_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_bot_id TEXT,
  template_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mova_bots_user_status ON mova_bots (user_id, status);
CREATE INDEX IF NOT EXISTS idx_mova_bots_name ON mova_bots (name);

CREATE TABLE IF NOT EXISTS mova_bot_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  type TEXT NOT NULL,
  bot_id TEXT,
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  group_mode TEXT NOT NULL DEFAULT 'natural',
  color TEXT,
  place JSONB,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  unread INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  active_goal TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_conversations_user_updated ON mova_bot_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mova_bot_conversation_members (
  conversation_id TEXT NOT NULL,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, member_type, member_id)
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_members_member ON mova_bot_conversation_members (member_type, member_id, left_at);

CREATE TABLE IF NOT EXISTS mova_bot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name_snapshot TEXT,
  reply_to_message_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  structured_payload JSONB,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'done',
  run_id TEXT,
  conversation_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mova_bot_messages_conv_seq ON mova_bot_messages (conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_mova_bot_messages_conv_created ON mova_bot_messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mova_bot_message_mentions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  display_text TEXT NOT NULL,
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_mentions_message ON mova_bot_message_mentions (message_id);

CREATE TABLE IF NOT EXISTS mova_bot_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  sender_bot_id TEXT,
  receiver_bot_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_events_conv_vis ON mova_bot_events (conversation_id, visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS mova_bot_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  owner_bot_id TEXT NOT NULL,
  collaborator_bot_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 5,
  budget_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_config JSONB,
  revisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_summary TEXT,
  waiting_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_tasks_conv_status ON mova_bot_tasks (conversation_id, status);

CREATE TABLE IF NOT EXISTS mova_bot_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  conversation_id TEXT,
  bot_id TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL,
  bot_version INTEGER NOT NULL DEFAULT 1,
  conversation_version INTEGER NOT NULL DEFAULT 1,
  token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mova_bot_triggers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  trigger_type TEXT NOT NULL,
  cron_expr TEXT,
  run_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  miss_policy TEXT NOT NULL DEFAULT 'skip',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at TIMESTAMPTZ,
  next_fire_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_triggers_enabled_next ON mova_bot_triggers (enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS mova_bot_memories (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bot_id TEXT,
  group_id TEXT,
  category TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  summary TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  superseded_by TEXT,
  source_conversation_id TEXT,
  source_message_id TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_memories_scope ON mova_bot_memories (scope_type, scope_id, pinned);

CREATE TABLE IF NOT EXISTS mova_bot_approval_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  conversation_id TEXT,
  bot_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  bound_params JSONB NOT NULL,
  params_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'high',
  status TEXT NOT NULL DEFAULT 'pending',
  user_note TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mova_bot_approvals_status ON mova_bot_approval_requests (status, conversation_id);

CREATE TABLE IF NOT EXISTS mova_bot_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  target_id TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mova_mini_apps (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'cube',
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  created_by_bot_id TEXT NOT NULL,
  conversation_id TEXT,
  manifest JSONB NOT NULL,
  entry_html TEXT NOT NULL,
  source_files JSONB NOT NULL DEFAULT '{}'::jsonb,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_opened_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mova_mini_app_storage (
  app_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'kv',
  key TEXT NOT NULL,
  value JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, namespace, key)
);
