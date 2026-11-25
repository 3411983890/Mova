-- Add project scope to durable extraction jobs. 002 is already applied on some
-- installations, so this is a separate additive migration rather than editing
-- a checksummed migration in place.
alter table mova_memory_jobs add column if not exists project_id text;

create index if not exists mova_memory_jobs_project_idx
  on mova_memory_jobs (owner_id, project_id);
