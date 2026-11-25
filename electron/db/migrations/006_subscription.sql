-- 006_subscription.sql — service-edition subscription credentials, OAuth flows
-- and the audit trail (multi-tenant).
--
-- Source of truth: Mova-CLI模型-开发文档.md §4.3 (service form factor), §5.5
-- (table shape), §6 (storage & security) and §17.2 (token custody risk). The
-- desktop edition keeps its records in an encrypted file (subscriptions.enc,
-- see electron/subscription/store.mjs); these tables are the server-side
-- equivalent and deliberately do NOT reuse mova_users: service edition
-- identifiers are opaque tenant/user strings supplied by the auth layer, not
-- the single-user uuid seeded by 001_init.sql.
--
-- Access rules for electron/services/subscription-service.mjs:
--   * every statement is parameterized and scoped by (tenant_id, user_id);
--     there is no "look up by account_id alone" path anywhere;
--   * ciphertext is AES-256-GCM of the credential record JSON, with
--     additional authenticated data AAD = tenant_id|user_id|provider|account_id,
--     so moving one row's ciphertext into another row makes decryption fail;
--   * the key comes from MOVA_SUBSCRIPTION_KEY (or an OS keyring); it is never
--     stored here, never in the image, never in a log;
--   * tokens (access/refresh/idToken) live only inside ciphertext — no column
--     holds a token and no audit detail may contain one.
--
-- Audit retention: subscription_events is pruned after 30 days
-- （审计保留 30 天）by subscription-service.pruneEvents({ olderThanDays: 30 }).
-- subscription_flows rows are one-shot and die after 5 minutes; their expiry is
-- enforced by the login handler, the table only records the deadline.
--
-- Idempotent: every statement is guarded with IF NOT EXISTS / CREATE OR REPLACE
-- semantics (comment on ... replaces), so re-running the migration runner is a
-- no-op. Records itself in the same mova_migrations ledger as 001..005.
--
-- Rollback (manual, destructive — dropping the tables logs every user out):
--   drop table if exists subscription_events;
--   drop table if exists subscription_flows;
--   drop table if exists subscription_credentials;

-- ---------------------------------------------------------------------------
-- One encrypted record per (tenant, user, provider, account).
-- ---------------------------------------------------------------------------
create table if not exists subscription_credentials (
  tenant_id text not null,
  user_id text not null,
  provider text not null,
  account_id text not null,
  -- AES-256-GCM envelope of the credential record (includes access/refresh);
  -- additional authenticated data binds tenant, user, provider and account.
  ciphertext bytea not null,
  -- Display-only metadata: duplicated out of the ciphertext so the settings
  -- page can list accounts without decrypting (and the server can answer
  -- "which account is this" without touching a token).
  email text,
  plan text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (tenant_id, user_id, provider, account_id)
);

-- Listing one user's accounts is the hot read (settings page, scheduler).
-- The primary key covers the same prefix, but this narrower index also serves
-- the ORDER BY and keeps the scan off the wide ciphertext rows.
create index if not exists subscription_credentials_scope_idx
  on subscription_credentials (tenant_id, user_id, created_at desc);

comment on column subscription_credentials.ciphertext is
  'AES-256-GCM(credential record JSON); AAD = tenant_id|user_id|provider|account_id. Never log or transport this column.';

-- ---------------------------------------------------------------------------
-- One row per in-flight OAuth login. Binding flow_id to (tenant, user, state)
-- is what makes the server callback /oauth/callback/<flowId> safe: a flow id
-- leaked to another user must not complete that user's login.
-- ---------------------------------------------------------------------------
create table if not exists subscription_flows (
  flow_id text primary key,
  tenant_id text not null,
  user_id text not null,
  provider text not null,
  state text not null,
  -- PKCE code_verifier (S256). Short-lived and sensitive: read only by the
  -- callback handler, never logged, deleted with the row.
  verifier text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Cleanup sweep: expired flows are deleted by expiry, not by tenant.
create index if not exists subscription_flows_expires_at_idx
  on subscription_flows (expires_at);

-- ---------------------------------------------------------------------------
-- Append-only audit trail (tool calls, logins, switches, logouts). Written by
-- subscription-service.recordEvent, read back scoped to one user.
-- ---------------------------------------------------------------------------
create table if not exists subscription_events (
  id bigserial primary key,
  tenant_id text not null,
  user_id text not null,
  at timestamptz not null default now(),
  kind text not null,
  provider text,
  account_id text,
  -- Already-redacted payload (no tokens, no path arguments, no prompt text).
  detail jsonb not null default '{}'::jsonb
);

create index if not exists subscription_events_scope_idx
  on subscription_events (tenant_id, user_id, at desc, id desc);

-- Retention sweep (30 days) scans by time only, across every tenant.
create index if not exists subscription_events_at_idx
  on subscription_events (at);

comment on table subscription_events is
  'Append-only subscription audit log; retention 30 days (审计保留 30 天), pruned by subscription-service.pruneEvents.';
comment on column subscription_events.detail is
  'Redacted JSON detail. Must never contain access/refresh/idToken or other secrets.';
