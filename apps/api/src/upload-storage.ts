import type { Sql } from 'postgres';
import { NodeFiles, PostgresUploadRetention } from '@media-ingest/adapters';

export function createUploadStorage(sql: Sql, workRoot: string) {
  const retention = new PostgresUploadRetention(sql, {
    uploadMetadata: (owner, id) => files.uploadMetadata(owner, id),
    removeUpload: (owner, id) => files.removeUpload(owner, id),
  });
  const files: NodeFiles = new NodeFiles({ workRoot, uploadLifecycle: retention });
  return { files, retention };
}
