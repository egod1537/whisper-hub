import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/shared/db/connection.js';
import { migrate } from '../../src/shared/db/migrate.js';
import { JobRepository } from '../../src/shared/queue/repository.js';

let directory: string;
let db: SqliteDatabase;
let repository: JobRepository;

function add(id: string, now: Date, maxAttempts = 3) {
  return repository.create({
    id, originalFilename: `${id}.wav`, mediaType: 'audio/wav', fileSizeBytes: 10,
    sourcePath: `uploads/${id}/source`, language: 'auto', requestedOutputFormats: ['txt'],
    maxAttempts, model: 'base',
  }, now);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-queue-'));
  db = openDatabase(path.join(directory, 'db.sqlite'));
  migrate(db);
  repository = new JobRepository(db);
});
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('durable queue', () => {
  it('claims FIFO and never returns the same job to two connections', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('01', now); add('02', now); add('03', new Date(now.getTime() + 1));
    const secondDb = openDatabase(path.join(directory, 'db.sqlite'));
    const second = new JobRepository(secondDb);
    try {
      expect(repository.claim('worker-a', 60, now)?.id).toBe('01');
      expect(second.claim('worker-b', 60, now)?.id).toBe('02');
      expect(repository.claim('worker-a', 60, now)?.id).toBe('03');
      expect(second.claim('worker-b', 60, now)).toBeNull();
    } finally { secondDb.close(); }
  });

  it('heartbeats, recovers expired leases, and exhausts attempts', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('one', now, 2);
    expect(repository.claim('worker', 60, now)?.attempts).toBe(1);
    expect(repository.heartbeat('one', 'worker', 60, new Date(now.getTime() + 30_000)).renewed).toBe(true);
    expect(repository.recoverExpired(new Date(now.getTime() + 91_000))[0]?.status).toBe('queued');
    expect(repository.claim('worker-2', 60, new Date(now.getTime() + 91_000))?.attempts).toBe(2);
    expect(repository.recoverExpired(new Date(now.getTime() + 152_000))[0]?.status).toBe('failed');
  });

  it('lets an eligible job bypass a delayed retry', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('one', now); add('two', new Date(now.getTime() + 1));
    repository.claim('worker', 60, now);
    repository.failOrRetry('one', 'worker', 'PROVIDER_UNAVAILABLE', 'retry', true, 30, now);
    expect(repository.claim('worker', 60, new Date(now.getTime() + 10_000))?.id).toBe('two');
  });

  it('enforces cancellation and manual retry transition rules', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('queued', now); add('failed', new Date(now.getTime() + 1), 1);
    expect(repository.requestCancellation('queued', now).status).toBe('canceled');
    expect(() => repository.retryFailed('queued', 3)).toThrow();
    repository.claim('worker', 60, now);
    repository.failOrRetry('failed', 'worker', 'MEDIA_INVALID', 'bad', false, 0, now);
    const retried = repository.retryFailed('failed', 3, 5, now);
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, manualRetryCount: 1 });
  });
});

