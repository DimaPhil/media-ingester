CREATE TABLE IF NOT EXISTS operations (
  id text PRIMARY KEY,
  dedupe_key text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  provider text NOT NULL,
  model text,
  source_type text NOT NULL,
  source_locator jsonb NOT NULL,
  input jsonb NOT NULL,
  result jsonb,
  error jsonb,
  cache_enabled boolean NOT NULL DEFAULT true,
  cache_hit boolean NOT NULL DEFAULT false,
  retryable boolean NOT NULL DEFAULT true,
  current_step text,
  working_directory text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  last_heartbeat_at timestamptz
);

CREATE INDEX IF NOT EXISTS operations_dedupe_key_idx ON operations (dedupe_key);

CREATE TABLE IF NOT EXISTS operation_steps (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  name text NOT NULL,
  step_order integer NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  output jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_steps_operation_name_uidx
  ON operation_steps (operation_id, name);
