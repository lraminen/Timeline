/**
 * @chronicle/server — programmatic entry point (for embedding or tests).
 * Run `chronicle-server` (dist/main.js) to start a standalone server.
 */
export { buildApp, type AppOptions, type AppContext, type AuthContext } from './app.js';
export { loadConfig, type Config } from './config.js';
export { openDatabase, type Database, type Db } from './db/client.js';
export {
  FsStorage,
  S3Storage,
  createStorage,
  type Storage,
  type CdnInvalidator,
} from './media/storage.js';
export { ClamdScanner, noopScanner, type Scanner, type ScanResult } from './media/scanner.js';
