import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadConfig, type Config } from '../src/shared/config.js';
import { openDatabase, type SqliteDatabase } from '../src/shared/db/connection.js';
import { migrate } from '../src/shared/db/migrate.js';
import type { Transcript } from '../src/shared/export/types.js';
import type { TranscribeInput, TranscriptionProvider } from '../src/shared/providers/interface.js';
import { JobRepository } from '../src/shared/queue/repository.js';

export class FakeProvider implements TranscriptionProvider {
  readonly name = 'fake';
  result: Transcript = {
    text: '안녕하세요 world',
    languageDetected: 'ko',
    segments: [
      { startMs: 0, endMs: 500, text: '안녕하세요' },
      { startMs: 500, endMs: 1_000, text: 'world' },
    ],
  };
  error: Error | null = null;

  async transcribe(_input: TranscribeInput): Promise<Transcript> {
    if (this.error) throw this.error;
    return this.result;
  }

  async health(): Promise<boolean> { return true; }
}

export interface TestContext {
  directory: string;
  config: Config;
  db: SqliteDatabase;
  repository: JobRepository;
  provider: FakeProvider;
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function createTestContext(overrides: NodeJS.ProcessEnv = {}): Promise<TestContext> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-hub-test-'));
  const config = loadConfig({
    NODE_ENV: 'test', TEST_MODE: 'true', API_KEY: 'test-api-key-123456', DATA_DIR: directory,
    DB_PATH: path.join(directory, 'db.sqlite'), LOG_LEVEL: 'silent', JOB_LEASE_SECONDS: '60',
    ...overrides,
  });
  const db = openDatabase(config.dbPath);
  migrate(db);
  const repository = new JobRepository(db);
  const provider = new FakeProvider();
  const app = await buildApp({ config, db, provider, logger: false });
  return {
    directory, config, db, repository, provider, app,
    async close() {
      await app.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function multipart(parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>): { body: Buffer; boundary: string } {
  const boundary = `test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`));
    if (part.filename) chunks.push(Buffer.from(`; filename="${part.filename}"`));
    chunks.push(Buffer.from('\r\n'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

export function makeWav(durationMs = 100): Buffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * durationMs / 1_000);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

export const authHeaders = { authorization: 'Bearer test-api-key-123456' };

