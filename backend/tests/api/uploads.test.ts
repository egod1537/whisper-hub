import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadFinalizerService } from '../../src/finalizer/service.js';
import { sourceRelativePath } from '../../src/shared/storage/paths.js';
import { resolveInside } from '../../src/shared/storage/paths.js';
import { uploadPartRelativePath } from '../../src/shared/uploads/paths.js';
import { UploadRepository } from '../../src/shared/uploads/repository.js';
import type { TestContext } from '../helpers.js';
import { authHeaders, createTestContext, webHeaders } from '../helpers.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext({ UPLOAD_CHUNK_SIZE_BYTES: '1048576' }); });
afterEach(async () => context.close());

async function createUpload(sizeBytes: number, key = 'resumable-key', expectedSha256?: string, headers: Record<string, string> = authHeaders) {
  return context.app.inject({
    method: 'POST', url: '/api/v1/uploads', headers: { ...headers, 'idempotency-key': key, 'content-type': 'application/json' },
    payload: { filename: '../lecture.wav', sizeBytes, ...(expectedSha256 ? { sha256: expectedSha256 } : {}), language: 'ko', formats: ['json', 'txt'] },
  });
}

async function putPart(uploadId: string, index: number, bytes: Buffer, digest = createHash('sha256').update(bytes).digest('hex')) {
  return context.app.inject({
    method: 'PUT', url: `/api/v1/uploads/${uploadId}/parts/${index}`,
    headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-chunk-sha256': digest }, payload: bytes,
  });
}

describe('resumable upload API', () => {
  it('requires auth and enforces the aggregate ceiling', async () => {
    expect((await context.app.inject({ method: 'POST', url: '/api/v1/uploads', payload: {} })).statusCode).toBe(401);
    const tooLarge = await createUpload(context.config.maxResumableUploadBytes + 1, 'too-large');
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('creates sessions idempotently and rejects conflicting metadata', async () => {
    const first = await createUpload(1_048_579);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ chunkSizeBytes: 1_048_576, totalChunks: 2, status: 'uploading' });
    const replay = await createUpload(1_048_579);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().uploadId).toBe(first.json().uploadId);
    expect((await createUpload(1_048_580)).statusCode).toBe(409);
    const spoofed = await context.app.inject({
      method: 'POST', url: '/api/v1/uploads', headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { filename: 'spoof.wav', sizeBytes: 3, language: 'ko', formats: ['txt'], origin: 'web' },
    });
    expect(spoofed.statusCode).toBe(422);
  });

  it('streams exact chunks, makes replay idempotent, and rejects conflicts', async () => {
    const created = await createUpload(3);
    const uploadId = created.json().uploadId as string;
    const bytes = Buffer.from('abc');
    expect((await putPart(uploadId, 0, bytes)).statusCode).toBe(201);
    expect((await putPart(uploadId, 0, bytes)).statusCode).toBe(200);
    const conflict = await putPart(uploadId, 0, bytes, '0'.repeat(64));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('CHUNK_CONFLICT');
    const status = await context.app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: authHeaders });
    expect(status.json()).toMatchObject({ receivedParts: [0], receivedBytes: 3, jobId: null });
  });

  it('reports missing chunks and rejects a wrong chunk digest', async () => {
    const created = await createUpload(1_048_579);
    const uploadId = created.json().uploadId as string;
    const incomplete = await context.app.inject({ method: 'POST', url: `/api/v1/uploads/${uploadId}/complete`, headers: authHeaders });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.details.missingParts).toEqual([0, 1]);
    const wrongHash = await putPart(uploadId, 0, Buffer.alloc(1_048_576), 'f'.repeat(64));
    expect(wrongHash.statusCode).toBe(422);
    expect(wrongHash.json().error.code).toBe('CHUNK_HASH_MISMATCH');
  });

  it('rejects wrong lengths and indices, and expires sessions consistently', async () => {
    const created = await createUpload(3, 'validation-key');
    const uploadId = created.json().uploadId as string;
    const wrongLength = await putPart(uploadId, 0, Buffer.from('ab'));
    expect(wrongLength.statusCode).toBe(422);
    expect(wrongLength.json().error.code).toBe('CHUNK_LENGTH_INVALID');
    expect((await putPart(uploadId, 1, Buffer.from('abc'))).statusCode).toBe(422);
    context.db.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), uploadId);
    const expired = await putPart(uploadId, 0, Buffer.from('abc'));
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('UPLOAD_EXPIRED');
    const status = await context.app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: authHeaders });
    expect(status.json().status).toBe('expired');
  });

  it('coordinates an active part claim across API processes and reconciles orphan files', async () => {
    const created = await createUpload(3, 'claim-key');
    const uploadId = created.json().uploadId as string;
    const bytes = Buffer.from('abc');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const repository = new UploadRepository(context.db);
    repository.claimPart({ uploadId, index: 0, bytes: 3, sha256: digest, owner: 'first', maxInflight: 6, maxStagedBytes: 100 });
    expect(() => repository.claimPart({ uploadId, index: 0, bytes: 3, sha256: digest, owner: 'second', maxInflight: 6, maxStagedBytes: 100 })).toThrowError(/already being uploaded/);
    repository.releasePartClaim(uploadId, 0, 'first');

    const relative = uploadPartRelativePath(uploadId, 0);
    const target = resolveInside(context.directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    expect((await putPart(uploadId, 0, bytes)).statusCode).toBe(200);
    expect(repository.parts(uploadId)).toHaveLength(1);
    fs.rmSync(target);
    const status = await context.app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: authHeaders });
    expect(status.json().receivedParts).toEqual([]);
  });

  it('aborts safely while a part claim is active', async () => {
    const created = await createUpload(3, 'abort-active-key');
    const uploadId = created.json().uploadId as string;
    const repository = new UploadRepository(context.db);
    repository.claimPart({ uploadId, index: 0, bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), owner: 'active-request', maxInflight: 6, maxStagedBytes: 100 });
    const aborted = await context.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${uploadId}`, headers: authHeaders });
    expect(aborted.statusCode).toBe(204);
    expect(repository.getRequired(uploadId).status).toBe('aborted');
    expect(context.db.prepare('SELECT COUNT(*) count FROM upload_part_claims WHERE upload_id=?').get(uploadId)).toEqual({ count: 0 });
  });

  it('finalizes asynchronously into exactly one queued job', async () => {
    const file = Buffer.from('assembled-audio');
    const fullHash = createHash('sha256').update(file).digest('hex');
    const created = await createUpload(file.length, 'finalize-key', fullHash, webHeaders);
    const uploadId = created.json().uploadId as string;
    expect((await putPart(uploadId, 0, file)).statusCode).toBe(201);
    const completing = await context.app.inject({ method: 'POST', url: `/api/v1/uploads/${uploadId}/complete`, headers: authHeaders });
    expect(completing.statusCode).toBe(202);
    expect(completing.json()).toMatchObject({ status: 'finalizing', jobId: null });
    const concurrent = await Promise.all([
      context.app.inject({ method: 'POST', url: `/api/v1/uploads/${uploadId}/complete`, headers: authHeaders }),
      context.app.inject({ method: 'POST', url: `/api/v1/uploads/${uploadId}/complete`, headers: authHeaders }),
    ]);
    expect(concurrent.every((response) => response.statusCode === 202)).toBe(true);
    expect(context.db.prepare('SELECT COUNT(*) count FROM jobs').get()).toEqual({ count: 0 });
    const repository = new UploadRepository(context.db);
    const claimed = repository.claimFinalization('test-finalizer', 60);
    expect(claimed?.id).toBe(uploadId);
    const service = new UploadFinalizerService({ config: context.config, repository, owner: 'test-finalizer', logger: pino({ level: 'silent' }) });
    await service.finalize(claimed!);
    const status = await context.app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: authHeaders });
    expect(status.json()).toMatchObject({ status: 'completed', receivedParts: [], jobId: expect.any(String) });
    const jobId = status.json().jobId as string;
    expect(context.repository.get(jobId)).toMatchObject({ status: 'queued', origin: 'web', sourcePath: sourceRelativePath(jobId), fileSizeBytes: file.length });
    expect(fs.readFileSync(path.join(context.directory, sourceRelativePath(jobId)))).toEqual(file);
    const repeated = await context.app.inject({ method: 'POST', url: `/api/v1/uploads/${uploadId}/complete`, headers: authHeaders });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().jobId).toBe(jobId);
    expect(context.db.prepare('SELECT COUNT(*) count FROM jobs WHERE id=?').get(jobId)).toEqual({ count: 1 });
  });
});
