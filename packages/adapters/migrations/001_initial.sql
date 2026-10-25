CREATE SCHEMA IF NOT EXISTS media_v1;

CREATE TABLE IF NOT EXISTS media_v1.jobs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  lease_token uuid,
  lease_expires_at bigint,
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  UNIQUE (owner_id, idempotency_key),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_dispatch_idx ON media_v1.jobs (status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS jobs_owner_idx ON media_v1.jobs (owner_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS media_v1.auth_entries (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_expiry_idx ON media_v1.auth_entries (expires_at);
