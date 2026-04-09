import {
  createDatabase,
  loadAppConfig,
  runDatabaseMigrations,
} from '../packages/media-ingest-core/src/index';

async function main(): Promise<void> {
  const config = loadAppConfig();
  const database = createDatabase(config.database.url);
  try {
    await runDatabaseMigrations(database);
    console.log('Applied pending migrations');
  } finally {
    await database.client.end();
  }
}

void main();
