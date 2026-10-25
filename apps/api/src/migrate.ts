import postgres from 'postgres';
import { applyMigrations } from '@media-ingest/adapters';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await applyMigrations(sql);
  console.log('Media schema is current');
} finally {
  await sql.end();
}
