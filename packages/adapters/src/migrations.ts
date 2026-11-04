import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';

/** Migrations are explicit: API startup must not silently change a production schema. */
export async function applyMigrations(sql: Sql): Promise<void> {
  const migration = await readFile(
    new URL('../migrations/001_initial.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(716385901)`;
    await transaction`CREATE SCHEMA IF NOT EXISTS media_v1`;
    await transaction`CREATE TABLE IF NOT EXISTS media_v1.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const existing = await transaction`SELECT version FROM media_v1.migrations WHERE version = 1`;
    if (existing.length === 0) {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO media_v1.migrations (version) VALUES (1)`;
    }
  });
}
