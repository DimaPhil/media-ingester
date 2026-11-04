-- New publications and future fenced completions enter this lifecycle. No historical backfill.
CREATE TABLE media_v1.upload_retention (
  owner_id text NOT NULL,
  upload_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting_submit', 'pending')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, upload_id)
);

CREATE INDEX upload_retention_pending_idx
  ON media_v1.upload_retention (next_attempt_at) WHERE state = 'pending';

CREATE INDEX jobs_unfinished_upload_idx
  ON media_v1.jobs (owner_id, lower(data #>> '{request,source,uri}'))
  WHERE status <> 'completed' AND data #>> '{request,source,kind}' = 'upload';
