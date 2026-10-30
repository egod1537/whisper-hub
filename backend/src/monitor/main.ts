import pino from 'pino';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { WhisperHttpProvider } from '../shared/providers/whisperHttp.js';
import { JobRepository } from '../shared/queue/repository.js';
import { ProductionMonitor } from './service.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: 'monitor' } });
const db = openDatabase(config.dbPath);
const repository = new JobRepository(db);
const provider = new WhisperHttpProvider(config.whisperBaseUrl, config.whisperTimeoutMs);
const monitor = new ProductionMonitor({
  config,
  repository,
  provider,
  logger,
  heartbeatPath: '/tmp/whisper-hub-monitor-heartbeat',
});
const controller = new AbortController();

process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

try {
  await monitor.start(controller.signal);
} catch (error) {
  logger.fatal({ err: error }, 'production monitor stopped unexpectedly');
  process.exitCode = 1;
} finally {
  db.close();
}
