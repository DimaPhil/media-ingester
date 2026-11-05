import type { Sql } from 'postgres';
import type { JobRecord } from '@media-ingest/sdk';
import type { PostgresUploadRetention } from './upload-retention.js';

/** Bounded expiry of terminal execution records. Durable results have no job foreign key. */
export class PostgresJobRetention {
  constructor(
    private readonly sql: Sql,
    private readonly uploads: Pick<PostgresUploadRetention, 'preserveExpiredInput'>,
  ) {}

  async drain(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ data: JobRecord }[]>`
        SELECT j.data FROM media_v1.jobs j
        WHERE j.expires_at <= clock_timestamp() AND j.status IN ('completed','failed')
          AND (j.status='failed' OR EXISTS (
            SELECT 1 FROM media_v1.processed_media p WHERE p.id=j.id AND p.owner_id=j.owner_id
          ))
        ORDER BY j.expires_at,j.id LIMIT 100 FOR UPDATE OF j SKIP LOCKED`;
      for (const { data: job } of rows) {
        if (job.status === 'failed') await this.uploads.preserveExpiredInput(tx, job);
        await tx`DELETE FROM media_v1.jobs WHERE id=${job.id} AND owner_id=${job.ownerId}`;
      }
      return rows.length;
    });
  }
}
