import type { Sql } from 'postgres';

/** Run before creating a SQL client: integration suites intentionally reset this schema. */
export function requireDisposableDatabase(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    Array.from(parsed.searchParams.keys()).some((key) => key !== 'sslmode') ||
    !/(?:^|[_-])test(?:$|[_-])/.test(name)
  )
    throw new Error(
      'TEST_DATABASE_URL must name a disposable database with a separate "test" component; tests reset media_v1 tables',
    );
  return url;
}

export async function verifyDisposableDatabase(sql: Sql, url: string): Promise<void> {
  const expected = decodeURIComponent(new URL(requireDisposableDatabase(url)).pathname.slice(1));
  const [row] = await sql`SELECT current_database() AS name`;
  if (row?.name !== expected)
    throw new Error('Connected database differs from the disposable test database');
}
