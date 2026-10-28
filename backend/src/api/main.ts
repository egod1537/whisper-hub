import { buildApp } from './app.js';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';
import { WhisperHttpProvider } from '../shared/providers/whisperHttp.js';
import { ensureStorage } from '../shared/storage/files.js';

const config = loadConfig();
ensureStorage(config.dataDir);
const db = openDatabase(config.dbPath);
migrate(db);
const provider = new WhisperHttpProvider(config.whisperBaseUrl, config.whisperTimeoutMs);
const app = await buildApp({ config, db, provider });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down API');
  await app.close();
  db.close();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
} catch (error) {
  app.log.fatal({ err: error }, 'API startup failed');
  db.close();
  process.exitCode = 1;
}

