import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';

/** Migrations are explicit: API startup must not silently change a production schema. */
export async function applyMigrations(sql: Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(716385901)`;
    await transaction`CREATE SCHEMA IF NOT EXISTS media_v1`;
    await transaction`CREATE TABLE IF NOT EXISTS media_v1.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const rows = await transaction<{ version: number }[]>`SELECT version FROM media_v1.migrations`;
    const applied = new Set(rows.map((row) => row.version));
    for (const [version, file] of [
      [1, '001_initial.sql'],
      [2, '002_upload_retention.sql'],
      [3, '003_processed_media.sql'],
    ] as const) {
      if (applied.has(version)) continue;
      const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      await transaction.unsafe(migration);
      await transaction`INSERT INTO media_v1.migrations (version) VALUES (${version})`;
    }
  });
}
