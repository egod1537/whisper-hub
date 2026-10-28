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
    maxAttempts, model: 'base', origin: 'api',
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
    const first = repository.claim('worker', 60, now)!;
    expect(first.attempts).toBe(1);
    expect(repository.heartbeat('one', first.leaseOwner!, 60, new Date(now.getTime() + 30_000)).renewed).toBe(true);
    expect(repository.recoverExpired(new Date(now.getTime() + 91_000))[0]?.job.status).toBe('queued');
    expect(repository.claim('worker-2', 60, new Date(now.getTime() + 91_000))?.attempts).toBe(2);
    expect(repository.recoverExpired(new Date(now.getTime() + 152_000))[0]?.job.status).toBe('failed');
  });

  it('lets an eligible job bypass a delayed retry', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('one', now); add('two', new Date(now.getTime() + 1));
    const claimed = repository.claim('worker', 60, now)!;
    repository.failOrRetry('one', claimed.leaseOwner!, 'PROVIDER_UNAVAILABLE', 'retry', true, 30, now);
    expect(repository.claim('worker', 60, new Date(now.getTime() + 10_000))?.id).toBe('two');
  });

  it('stores only fenced progress for the active phase and clears it on phase changes', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('progress', now);
    const claimed = repository.claim('worker', 60, now)!;

    expect(repository.updateProgress(claimed.id, 'stale-owner', 'validating', 5, 10, 'seconds', now)).toBe(false);
    expect(repository.updateProgress(claimed.id, claimed.leaseOwner!, 'validating', -1, 10, 'seconds', now)).toBe(false);
    expect(repository.updateProgress(claimed.id, claimed.leaseOwner!, 'validating', 12, 10, 'seconds', now)).toBe(true);
    expect(repository.getRequired(claimed.id)).toMatchObject({ progressCurrent: 10, progressTotal: 10, progressUnit: 'seconds' });

    expect(repository.updatePhase(claimed.id, claimed.leaseOwner!, 'converting', now)).toBe(true);
    expect(repository.getRequired(claimed.id)).toMatchObject({ progressCurrent: null, progressTotal: null, progressUnit: null });
    expect(repository.updateProgress(claimed.id, claimed.leaseOwner!, 'validating', 1, 10, 'seconds', now)).toBe(false);
    expect(repository.updateProgress(claimed.id, claimed.leaseOwner!, 'converting', 2.5, 10, 'seconds', now)).toBe(true);
  });

  it('enforces cancellation and manual retry transition rules', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('queued', now); add('failed', new Date(now.getTime() + 1), 1);
    expect(repository.requestCancellation('queued', now).status).toBe('canceled');
    expect(() => repository.retryFailed('queued', 3)).toThrow();
    const claimed = repository.claim('worker', 60, now)!;
    repository.failOrRetry('failed', claimed.leaseOwner!, 'MEDIA_INVALID', 'bad', false, 0, now);
    const retried = repository.retryFailed('failed', 3, 5, now);
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, manualRetryCount: 1 });
  });

  it('holds queued jobs, resumes at the back of the eligible FIFO, and cancels idempotently', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('first', now); add('second', new Date(now.getTime() + 1));
    expect(repository.requestPause('first', new Date(now.getTime() + 2))).toMatchObject({ status: 'paused', attempts: 0 });
    expect(repository.queuePosition('first')).toBeNull();
    expect(repository.claim('worker', 60, new Date(now.getTime() + 3))?.id).toBe('second');
    add('third', new Date(now.getTime() + 4));
    const resumed = repository.resumePaused('first', new Date(now.getTime() + 5));
    expect(resumed.status).toBe('queued');
    expect(repository.claim('worker-2', 60, new Date(now.getTime() + 6))?.id).toBe('third');
    expect(repository.requestCancellation('first').status).toBe('canceled');
    expect(repository.requestCancellation('first').status).toBe('canceled');
  });

  it('pauses active work without consuming an attempt and fences stale owners', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('paused-work', now);
    const claimed = repository.claim('worker-a', 60, now)!;
    expect(repository.requestPause(claimed.id, new Date(now.getTime() + 1)).status).toBe('pausing');
    expect(repository.failOrRetry(claimed.id, claimed.leaseOwner!, 'PAUSE_REQUESTED', 'paused', false, 0, new Date(now.getTime() + 2))).toMatchObject({ status: 'paused', attempts: 0 });
    expect(repository.resumePaused(claimed.id, new Date(now.getTime() + 3)).status).toBe('queued');
    const reclaimed = repository.claim('worker-b', 60, new Date(now.getTime() + 4))!;
    expect(reclaimed.leaseOwner).not.toBe(claimed.leaseOwner);
    expect(repository.complete(claimed.id, claimed.leaseOwner!, 'results/stale', {})).toBe(false);
    expect(repository.complete(claimed.id, reclaimed.leaseOwner!, 'results/current', {})).toBe(true);
  });

  it('recovers a crashed pausing worker into paused without publishing late success', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    add('crashed-pause', now);
    const claimed = repository.claim('worker-a', 1, now)!;
    repository.requestPause(claimed.id, new Date(now.getTime() + 100));
    expect(repository.recoverExpired(new Date(now.getTime() + 1_001))[0]?.job).toMatchObject({ status: 'paused', attempts: 0 });
    expect(repository.complete(claimed.id, claimed.leaseOwner!, 'results/stale', {})).toBe(false);
  });
});

