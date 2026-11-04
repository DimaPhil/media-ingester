import type { Sql } from 'postgres';

/** Values contain only hashed bearer/code keys. `take` consumes codes atomically across instances. */
export class PostgresAuthStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async put(key: string, value: unknown, expiresAt: number): Promise<void> {
    await this.sql`INSERT INTO media_v1.auth_entries (key,value,expires_at)
      VALUES (${key},${this.sql.json(JSON.parse(JSON.stringify(value)))},${expiresAt})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql<
      { value: T }[]
    >`SELECT value FROM media_v1.auth_entries WHERE key=${key} AND expires_at > ${this.now()}`;
    return rows[0]?.value ?? null;
  }

  async take<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql<
      { value: T; expires_at: string }[]
    >`DELETE FROM media_v1.auth_entries WHERE key=${key} RETURNING value, expires_at`;
    const row = rows[0];
    return row && Number(row.expires_at) > this.now() ? row.value : null;
  }

  async delete(key: string): Promise<void> {
    await this.sql`DELETE FROM media_v1.auth_entries WHERE key=${key}`;
  }

  async prune(): Promise<number> {
    const rows = await this
      .sql`DELETE FROM media_v1.auth_entries WHERE expires_at <= ${this.now()}`;
    return rows.count;
  }
}
