import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCleanup } from '../../src/cleanup/service.js';
import { resolveInside, resultRelativePath, sourceRelativePath } from '../../src/shared/storage/paths.js';
import { uploadSessionRelativePath } from '../../src/shared/uploads/paths.js';
import type { TestContext } from '../helpers.js';
import { createTestContext, makeWav } from '../helpers.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => context.close());

function createJob(id: string, createdAt: Date): void {
  const sourcePath = sourceRelativePath(id);
  const source = resolveInside(context.directory, sourcePath);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, makeWav());
  context.repository.create({
    id, originalFilename: `${id}.wav`, mediaType: 'audio/wav', fileSizeBytes: fs.statSync(source).size,
    sourcePath, language: 'auto', requestedOutputFormats: ['txt'], maxAttempts: 1, model: 'base', origin: 'api',
  }, createdAt);
}

function completeJob(id: string, completedAt: Date): void {
  const claimed = context.repository.claim(`worker-${id}`, 60, completedAt)!;
  expect(claimed.id).toBe(id);
  const resultPath = resultRelativePath(id, claimed.leaseOwner!);
  const result = resolveInside(context.directory, resultPath);
  fs.mkdirSync(result, { recursive: true });
  fs.writeFileSync(path.join(result, 'transcript.txt'), id);
  expect(context.repository.complete(id, claimed.leaseOwner!, resultPath, { formats: ['txt'] }, completedAt)).toBe(true);
}

function failJob(id: string, completedAt: Date): void {
  const claimed = context.repository.claim(`worker-${id}`, 60, completedAt)!;
  expect(claimed.id).toBe(id);
  context.repository.failOrRetry(id, claimed.leaseOwner!, 'MEDIA_INVALID', 'invalid', false, 0, completedAt);
  const result = resolveInside(context.directory, resultRelativePath(id, 'partial'));
  fs.mkdirSync(result, { recursive: true });
  fs.writeFileSync(path.join(result, 'partial.txt'), id);
}

function insertCompletedUpload(id: string, updatedAt: Date): void {
  const timestamp = updatedAt.toISOString();
  context.db.prepare(`INSERT INTO upload_sessions (
    id,status,origin,display_filename,total_size_bytes,language,formats_json,chunk_size_bytes,total_chunks,
    created_at,updated_at,expires_at,create_request_hash,assembled_bytes
  ) VALUES (?, 'completed', 'web', ?, 1, 'auto', '["txt"]', 1, 1, ?, ?, ?, ?, 1)`)
    .run(id, `${id}.wav`, timestamp, timestamp, timestamp, `hash-${id}`);
  const staging = resolveInside(context.directory, uploadSessionRelativePath(id));
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'stale-part'), id);
}

describe('retention cleanup', () => {
  it('previews safely, deletes only expired terminal data, and purges old completed upload sessions', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

    createJob('expired-completed', daysAgo(9));
    completeJob('expired-completed', daysAgo(8));
    createJob('source-only', daysAgo(3));
    completeJob('source-only', daysAgo(2));
    createJob('expired-failed', daysAgo(5));
    failJob('expired-failed', daysAgo(4));
    createJob('active-queued', daysAgo(10));
    insertCompletedUpload('old-upload', daysAgo(8));
    insertCompletedUpload('recent-upload', daysAgo(2));

    const preview = await runCleanup({ config: context.config, db: context.db, apply: false, now });
    expect(preview).toEqual({ expiredJobs: 2, sourceFiles: 2, expiringUploads: 0, terminalUploadStaging: 2, purgingUploadSessions: 1 });
    expect(context.repository.get('expired-completed')).not.toBeNull();
    expect(fs.existsSync(resolveInside(context.directory, sourceRelativePath('source-only')))).toBe(true);
    expect(fs.existsSync(resolveInside(context.directory, uploadSessionRelativePath('old-upload')))).toBe(true);

    await runCleanup({ config: context.config, db: context.db, apply: true, now });

    expect(context.repository.get('expired-completed')).toBeNull();
    expect(context.repository.get('expired-failed')).toBeNull();
    expect(fs.existsSync(resolveInside(context.directory, path.posix.join('results', 'expired-completed')))).toBe(false);
    expect(fs.existsSync(resolveInside(context.directory, path.posix.join('results', 'expired-failed')))).toBe(false);
    expect(context.repository.getRequired('source-only').status).toBe('completed');
    expect(fs.existsSync(resolveInside(context.directory, path.dirname(sourceRelativePath('source-only'))))).toBe(false);
    expect(fs.existsSync(resolveInside(context.directory, path.posix.join('results', 'source-only')))).toBe(true);
    expect(context.repository.getRequired('active-queued').status).toBe('queued');
    expect(fs.existsSync(resolveInside(context.directory, sourceRelativePath('active-queued')))).toBe(true);
    expect(context.db.prepare('SELECT id FROM upload_sessions WHERE id=?').get('old-upload')).toBeUndefined();
    expect(context.db.prepare('SELECT id FROM upload_sessions WHERE id=?').get('recent-upload')).toEqual({ id: 'recent-upload' });
    expect(fs.existsSync(resolveInside(context.directory, uploadSessionRelativePath('recent-upload')))).toBe(false);
    expect(context.db.pragma('foreign_key_check')).toEqual([]);
  });
});
