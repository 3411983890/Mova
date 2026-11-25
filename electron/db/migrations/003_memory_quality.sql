-- Memory quality and lifecycle metadata. Kept additive so 001/002 remain
-- replayable for existing installations.
alter table mova_memories add column if not exists normalized_hash text;
alter table mova_memories add column if not exists importance double precision not null default 0.5;
alter table mova_memories add column if not exists use_count integer not null default 0;
alter table mova_memories add column if not exists last_used_at timestamptz;
alter table mova_memories add column if not exists observed_at timestamptz not null default now();
alter table mova_memories add column if not exists valid_from timestamptz;
alter table mova_memories add column if not exists valid_to timestamptz;
alter table mova_memories add column if not exists expires_at timestamptz;
alter table mova_memories add column if not exists last_confirmed_at timestamptz;

alter table mova_memories drop constraint if exists mova_memories_importance_check;
alter table mova_memories add constraint mova_memories_importance_check
  check (importance >= 0 and importance <= 1);

create index if not exists mova_memories_hash_idx
  on mova_memories (owner_id, project_id, normalized_hash)
  where status = 'active';

create table if not exists mova_memory_conflicts (
  id uuid primary key,
  owner_id uuid not null references mova_users(id) on delete cascade,
  old_memory_id uuid not null references mova_memories(id) on delete cascade,
  new_memory_id uuid not null references mova_memories(id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open','resolved','ignored')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists mova_memory_conflicts_open_idx
  on mova_memory_conflicts (owner_id, status, created_at desc);
