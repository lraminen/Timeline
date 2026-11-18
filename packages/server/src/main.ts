#!/usr/bin/env node
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { buildApp } from './app.js';

/** Starts the server: load config, open + migrate the database, listen. */
async function main(): Promise<void> {
  const config = loadConfig();
  const database = await openDatabase(config);
  await database.migrate();
  const app = await buildApp({ config, database });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    { database: database.driver, storage: config.STORAGE_DRIVER, publicUrl: config.publicUrl },
    'Chronicle server ready',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
