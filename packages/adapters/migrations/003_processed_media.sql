CREATE TABLE media_v1.processed_media (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  media_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX processed_media_history_idx
  ON media_v1.processed_media (owner_id, completed_at DESC, id DESC);
CREATE INDEX processed_media_source_idx ON media_v1.processed_media (owner_id, media_id);

-- Preserve existing successful outputs before enabling expiry of execution records.
-- Old jobs never saved resolved metadata, so retain what is available without refetching inputs.
INSERT INTO media_v1.processed_media (id, owner_id, media_id, completed_at, data)
SELECT id, owner_id, COALESCE(data->>'sourceFingerprint', id::text),
  (data->>'updatedAt')::timestamptz,
  jsonb_build_object(
    'id', id,
    'mediaId', COALESCE(data->>'sourceFingerprint', id::text),
    'request', data->'request',
    'fingerprint', data->'sourceFingerprint',
    'media', NULL,
    'createdAt', data->'createdAt',
    'completedAt', data->'updatedAt',
    'result', data->'result'
  )
FROM media_v1.jobs WHERE status = 'completed' AND jsonb_typeof(data->'result') = 'object';

ALTER TABLE media_v1.jobs ADD COLUMN expires_at timestamptz;
UPDATE media_v1.jobs SET expires_at = (data->>'updatedAt')::timestamptz + interval '30 days'
  WHERE status IN ('completed', 'failed');
CREATE INDEX jobs_expiry_idx ON media_v1.jobs (expires_at) WHERE expires_at IS NOT NULL;
