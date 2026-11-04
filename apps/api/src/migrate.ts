import postgres from 'postgres';
import { applyMigrations } from '@media-ingest/adapters';
const connection = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
const sql = postgres(connection, { max: 1 });
try {
  await applyMigrations(sql);
  console.log('Media schema is current');
} finally {
  await sql.end();
}
