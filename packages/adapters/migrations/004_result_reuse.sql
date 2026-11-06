-- Workers reuse retained results for identical content; site media IDs use processed_media_source_idx.
CREATE INDEX processed_media_fingerprint_idx
  ON media_v1.processed_media (owner_id, (data->>'fingerprint'), completed_at DESC, id DESC);
