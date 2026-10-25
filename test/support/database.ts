/** Run before creating a SQL client: integration suites intentionally reset this schema. */
export function requireDisposableDatabase(url: string): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !/(?:^|[_-])test(?:$|[_-])/.test(name)
  )
    throw new Error(
      'TEST_DATABASE_URL must name a disposable database with a separate "test" component; tests reset media_v1 tables',
    );
  return url;
}
