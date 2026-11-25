-- 002_memory_jobs.sql — durable queue for long-term memory extraction.
--
-- One row per (owner, conversation, message) that still needs an extraction
-- attempt. The row owns the message text only while the job is runnable: a
-- terminal state clears `text` (to '' because the column is not null) so this
-- table never becomes a second copy of the conversation history.
--
-- Applies on top of 001_init.sql; it adds one table and two indexes and does not
-- create or alter a migration ledger (the runner owns mova_migrations).
--
-- Idempotent: every statement is guarded with IF NOT EXISTS so re-running the
-- migration runner is a no-op.
--
-- Rollback (manual, destructive — run only after a verified backup):
--   drop table if exists mova_memory_jobs;
--
-- Access rules for electron/services/memory-jobs.cjs:
--   * every statement is parameterized and scoped by owner_id;
--   * claim() uses FOR UPDATE SKIP LOCKED so two workers never take one row;
--   * attempts is incremented on claim; failed rows stay claimable until
--     attempts reaches 3, after which only retry() can requeue them.

create table if not exists mova_memory_jobs (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  conversation_id text not null,
  message_id text not null,
  project_id text,
  text text not null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','skipped','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, conversation_id, message_id)
);

-- ---------------------------------------------------------------------------
-- Job indexes.
--   (owner_id, status, created_at) serves claim() (status filter, FIFO order)
--   and list()/purgeDone(); (owner_id, conversation_id) serves per-conversation
--   reads and the delete cascade lookups.
-- ---------------------------------------------------------------------------
create index if not exists mova_memory_jobs_queue_idx
  on mova_memory_jobs (owner_id, status, created_at);
create index if not exists mova_memory_jobs_conversation_idx
  on mova_memory_jobs (owner_id, conversation_id);
