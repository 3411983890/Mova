-- 001_init.sql — Mova PostgreSQL schema (single user, local Docker service).
--
-- Source of truth: Mova服务版接口约定.md §3.1. Table names, column names and
-- index names must not drift from the contract; additive indexes are marked
-- separately at the end of this file.
--
-- Idempotent: every statement is guarded with IF NOT EXISTS so re-running the
-- migration runner is a no-op. The runner records this file (with a checksum)
-- in mova_schema_migrations inside the same transaction as the DDL.
--
-- Rollback (manual, destructive — run only after a verified backup):
--   drop table if exists mova_backups;
--   drop table if exists mova_settings;
--   drop table if exists mova_search_chunks;
--   drop table if exists mova_memory_sources;
--   drop table if exists mova_memories;
--   drop table if exists mova_session_events;
--   drop table if exists mova_conversations;
--   drop table if exists mova_projects;
--   drop table if exists mova_users;
--   drop table if exists mova_schema_migrations;
--   -- extensions are shared with other databases/schemas; drop only when unused:
--   -- drop extension if exists vector;
--   -- drop extension if exists pg_trgm;
--
-- Dimensions: vector(384) matches MOVA_EMBEDDING_DIM and
-- Xenova/multilingual-e5-small. Changing the model requires a new migration
-- (different dimension cannot share this column) plus a full reindex.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Single-user accounts. Seeded once below with a fixed UUID so every foreign
-- key can be a constant in the application layer.
-- ---------------------------------------------------------------------------
create table if not exists mova_users (
  id uuid primary key,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists mova_projects (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  name text not null,
  memory_mode text not null default 'scoped',
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- mova_conversations.id keeps the renderer conversation key verbatim (a JSON
-- array string such as ["CodeMova","Alpha","Chat"]). project_id follows the
-- *memory* scope of contract §3.2: null for ChatMova, the project row for
-- CodeMova.
create table if not exists mova_conversations (
  id text primary key,
  project_id uuid references mova_projects(id) on delete set null,
  owner_id uuid not null references mova_users(id) on delete cascade,
  title text not null,
  temporary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mova_session_events (
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

create table if not exists mova_memories (
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

-- Provenance for automatic memories. The contract primary key requires both
-- conversation_id and message_id, so a source row is only written when both
-- identifiers are known.
create table if not exists mova_memory_sources (
  memory_id uuid not null references mova_memories(id) on delete cascade,
  conversation_id text,
  message_id text,
  source_span text,
  confidence numeric,
  primary key (memory_id, conversation_id, message_id)
);

create table if not exists mova_search_chunks (
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

create table if not exists mova_settings (
  owner_id uuid primary key references mova_users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists mova_backups (
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

-- ---------------------------------------------------------------------------
-- Contract indexes (§3.1).
-- ---------------------------------------------------------------------------
create index if not exists mova_search_chunks_fts_idx on mova_search_chunks using gin (fts);
create index if not exists mova_search_chunks_ngrams_idx on mova_search_chunks using gin (content_ngrams);
-- HNSW requires pgvector >= 0.5.0 (the docker image pins a current version).
create index if not exists mova_search_chunks_embedding_idx on mova_search_chunks
  using hnsw (embedding vector_cosine_ops);
create index if not exists mova_search_chunks_scope_idx on mova_search_chunks (owner_id, project_id);
create index if not exists mova_memories_scope_idx on mova_memories (owner_id, project_id, status);

-- ---------------------------------------------------------------------------
-- Additive indexes (safe extras; do not change the contract's structures).
-- Trigram indexes back the Chinese/English keyword channel described in §7.1.
-- ---------------------------------------------------------------------------
create index if not exists mova_memories_text_trgm_idx
  on mova_memories using gin ("text" gin_trgm_ops);
create index if not exists mova_search_chunks_content_trgm_idx
  on mova_search_chunks using gin (content gin_trgm_ops);
create index if not exists mova_session_events_conversation_idx
  on mova_session_events (conversation_id, sequence);
create index if not exists mova_conversations_owner_idx
  on mova_conversations (owner_id, updated_at desc);
create index if not exists mova_backups_owner_idx
  on mova_backups (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Single-owner seed. Fixed UUID per contract §3.1: every repository instance
-- uses owner_id = '00000000-0000-4000-8000-000000000001'.
-- ---------------------------------------------------------------------------
insert into mova_users (id, display_name)
values ('00000000-0000-4000-8000-000000000001', 'Mova')
on conflict (id) do nothing;

insert into mova_settings (owner_id, data)
values ('00000000-0000-4000-8000-000000000001', '{}'::jsonb)
on conflict (owner_id) do nothing;
