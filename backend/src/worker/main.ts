import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { loadConfig } from '../shared/config.js';
import { openDatabase } from '../shared/db/connection.js';
import { migrate } from '../shared/db/migrate.js';
import { WhisperHttpProvider } from '../shared/providers/whisperHttp.js';
import { JobRepository } from '../shared/queue/repository.js';
import { YtDlpYoutubeDownloader } from '../shared/youtube/downloader.js';
import { WorkerService } from './service.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: 'worker' } });
const db = openDatabase(config.dbPath);
migrate(db);
const repository = new JobRepository(db);
const provider = new WhisperHttpProvider(config.whisperBaseUrl, config.whisperTimeoutMs);
const youtubeDownloader = new YtDlpYoutubeDownloader(config);
const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const service = new WorkerService({ config, repository, provider, youtubeDownloader, workerId, logger });
const controller = new AbortController();

process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

try {
  await service.start(controller.signal);
} catch (error) {
  logger.fatal({ err: error }, 'worker stopped unexpectedly');
  process.exitCode = 1;
} finally {
  db.close();
}
