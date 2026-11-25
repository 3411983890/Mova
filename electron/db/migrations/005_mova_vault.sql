-- 005_mova_vault.sql — local encrypted privacy vault (one envelope per owner).
--
-- The passphrase never reaches PostgreSQL. This table stores only the scrypt
-- salt and the AES-256-GCM envelope (nonce, auth tag, ciphertext), all base64
-- text. Entries live inside the encrypted JSON blob, so there is no per-secret
-- table and no plaintext column to index or leak. Additive and idempotent:
-- re-running the migration runner is a no-op, and it is recorded in the same
-- mova_migrations ledger as 001..004 (no second ledger).
--
-- Rollback (manual, destructive — the vault cannot be recovered without it):
--   drop table if exists mova_vault;

create table if not exists mova_vault (
  owner_id uuid primary key references mova_users(id) on delete cascade,
  salt text not null,
  nonce text not null,
  tag text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);
