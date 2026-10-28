import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';
import { ensureStorage } from '../shared/storage/files.js';
import { UploadRepository } from '../shared/uploads/repository.js';
import { UploadFinalizerService } from './service.js';

const config = loadConfig();
ensureStorage(config.dataDir);
const logger = pino({ level: config.logLevel, base: { service: 'upload-finalizer' } });
const db = openDatabase(config.dbPath);
migrate(db);
const owner = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const service = new UploadFinalizerService({ config, repository: new UploadRepository(db), owner, logger });
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

try {
  await service.start(controller.signal);
} catch (error) {
  logger.fatal({ err: error }, 'upload finalizer stopped unexpectedly');
  process.exitCode = 1;
} finally {
  db.close();
}
