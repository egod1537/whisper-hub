import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { normalizeFilename, parseFormats, parseLanguage } from '../../shared/queue/options.js';
import { removePath } from '../../shared/storage/files.js';
import { resolveInside } from '../../shared/storage/paths.js';
import { uploadPartRelativePath, uploadPartTemporaryRelativePath, uploadSessionRelativePath } from '../../shared/uploads/paths.js';
import type { UploadRepository } from '../../shared/uploads/repository.js';
import { hashFile, streamChunkToFile } from '../../shared/uploads/stream.js';
import {
  completeUploadResponseSchema, createUploadBodySchema, createUploadResponseSchema, errorResponseSchema,
  uploadParamsSchema, uploadPartParamsSchema, uploadStatusSchema,
} from '../schemas.js';
import { requestOrigin } from '../provenance.js';

function idempotencyKey(header: string | string[] | undefined): string | null {
  if (Array.isArray(header) || (header !== undefined && !/^[\x21-\x7e]{1,128}$/.test(header))) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 1-128 safe ASCII characters.', 422);
  }
  return header ?? null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function completeResponse(session: { id: string; status: string; jobId: string | null }) {
  const completed = session.status === 'completed' && session.jobId !== null;
  return { uploadId: session.id, status: completed ? 'completed' as const : 'finalizing' as const, jobId: completed ? session.jobId : null, jobUrl: completed ? `/api/v1/jobs/${session.jobId}` : null };
}

export async function uploadRoutes(app: FastifyInstance, options: { config: Config; repository: UploadRepository }): Promise<void> {
  const { config, repository } = options;
  const reconcileMissingFiles = async (uploadId: string) => {
    const session = repository.getRequired(uploadId);
    if (session.status !== 'uploading') return;
    for (const part of repository.parts(uploadId)) {
      const stat = await fs.promises.stat(resolveInside(config.dataDir, part.relativePath)).catch(() => null);
      if (!stat?.isFile() || stat.size !== part.bytes) repository.removeMissingPart(uploadId, part.index);
    }
  };
  const assertSafeSessionDirectories = async (uploadId: string) => {
    const sessionDirectory = resolveInside(config.dataDir, uploadSessionRelativePath(uploadId));
    const partsDirectory = resolveInside(config.dataDir, `${uploadSessionRelativePath(uploadId)}/parts`);
    await fs.promises.mkdir(partsDirectory, { recursive: true, mode: 0o700 });
    for (const target of [sessionDirectory, partsDirectory]) {
      const stat = await fs.promises.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('STORAGE_UNAVAILABLE', 'Upload staging directory is unsafe.', 503);
    }
    const disk = await fs.promises.statfs(partsDirectory).catch(() => null);
    if (disk) {
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (available < config.uploadChunkSizeBytes + 67_108_864) throw new AppError('INSUFFICIENT_STORAGE', 'Insufficient free disk headroom for uploads.', 507, true);
    }
  };

  app.post('/api/v1/uploads', {
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['uploads'], body: createUploadBodySchema, response: { 200: createUploadResponseSchema, 201: createUploadResponseSchema, 401: errorResponseSchema, 409: errorResponseSchema, 413: errorResponseSchema, 422: errorResponseSchema, 429: errorResponseSchema } },
  }, async (request, reply) => {
    const body = createUploadBodySchema.parse(request.body);
    const origin = requestOrigin(request, config);
    if (body.sizeBytes > config.maxResumableUploadBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'Upload exceeds the resumable upload limit.', 413);
    const language = parseLanguage(body.language);
    const formats = parseFormats(body.formats);
    const filename = normalizeFilename(body.filename);
    const key = idempotencyKey(request.headers['idempotency-key']);
    const requestHash = sha256({ filename, sizeBytes: body.sizeBytes, expectedSha256: body.sha256 ?? null, language, formats });
    const totalChunks = Math.ceil(body.sizeBytes / config.uploadChunkSizeBytes);
    const result = repository.create({
      id: randomUUID(), displayFilename: filename, totalSizeBytes: body.sizeBytes, expectedSha256: body.sha256 ?? null,
      language, formats, chunkSizeBytes: config.uploadChunkSizeBytes, totalChunks,
      expiresAt: new Date(Date.now() + config.uploadSessionTtlHours * 3_600_000).toISOString(), idempotencyKey: key, requestHash,
      origin,
    }, config.uploadMaxActiveSessions);
    const session = result.session;
    return reply.code(result.replay ? 200 : 201).send({ uploadId: session.id, chunkSizeBytes: session.chunkSizeBytes, totalChunks: session.totalChunks, expiresAt: session.expiresAt, status: session.status });
  });

  app.put('/api/v1/uploads/:uploadId/parts/:index', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: { tags: ['uploads'], params: uploadPartParamsSchema, response: { 200: z.object({ index: z.number().int(), status: z.literal('stored') }), 201: z.object({ index: z.number().int(), status: z.literal('stored') }), 400: errorResponseSchema, 401: errorResponseSchema, 409: errorResponseSchema, 410: errorResponseSchema, 411: errorResponseSchema, 422: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema, 507: errorResponseSchema } },
  }, async (request, reply) => {
    const { uploadId, index } = uploadPartParamsSchema.parse(request.params);
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new AppError('BAD_REQUEST', 'Content-Encoding is not supported.', 400);
    if (request.headers['transfer-encoding']) throw new AppError('BAD_REQUEST', 'Chunked transfer encoding is not supported.', 400);
    const lengthHeader = request.headers['content-length'];
    if (lengthHeader === undefined) throw new AppError('CONTENT_LENGTH_REQUIRED', 'Content-Length is required.', 411);
    const declaredBytes = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) throw new AppError('CHUNK_LENGTH_INVALID', 'Content-Length is invalid.', 422);
    const digestHeader = request.headers['x-chunk-sha256'];
    if (Array.isArray(digestHeader) || typeof digestHeader !== 'string' || !/^[a-f0-9]{64}$/.test(digestHeader)) throw new AppError('VALIDATION_FAILED', 'X-Chunk-SHA256 must be lowercase SHA-256 hex.', 422);
    let session = repository.markExpiredIfNeeded(uploadId);
    if (index >= session.totalChunks) throw new AppError('VALIDATION_FAILED', 'Chunk index is outside the upload range.', 422);
    const expectedBytes = index === session.totalChunks - 1
      ? session.totalSizeBytes - session.chunkSizeBytes * (session.totalChunks - 1)
      : session.chunkSizeBytes;
    if (declaredBytes !== expectedBytes || declaredBytes > config.uploadChunkSizeBytes) throw new AppError('CHUNK_LENGTH_INVALID', 'Chunk length does not match the expected size.', 422);
    const owner = randomUUID();
    await assertSafeSessionDirectories(uploadId);
    let claim = repository.claimPart({ uploadId, index, bytes: declaredBytes, sha256: digestHeader, owner, maxInflight: config.uploadMaxInflightChunks, maxStagedBytes: config.uploadMaxStagedBytes });
    const canonicalRelative = uploadPartRelativePath(uploadId, index);
    const canonical = resolveInside(config.dataDir, canonicalRelative);
    if (claim.replay) {
      const stat = await fs.promises.stat(canonical).catch(() => null);
      if (stat?.isFile() && stat.size === declaredBytes) {
        (request.body as Readable).resume();
        return reply.code(200).send({ index, status: 'stored' });
      }
      repository.removeMissingPart(uploadId, index);
      claim = repository.claimPart({ uploadId, index, bytes: declaredBytes, sha256: digestHeader, owner, maxInflight: config.uploadMaxInflightChunks, maxStagedBytes: config.uploadMaxStagedBytes });
    }
    session = claim.session;
    const temporary = resolveInside(config.dataDir, uploadPartTemporaryRelativePath(uploadId, index, owner));
    let published = false;
    try {
      const orphan = await fs.promises.stat(canonical).catch(() => null);
      if (orphan?.isFile()) {
        const verified = await hashFile(canonical);
        if (verified.bytes === declaredBytes && verified.sha256 === digestHeader) {
          repository.commitPart({ uploadId, index, bytes: declaredBytes, sha256: digestHeader, relativePath: canonicalRelative, owner });
          (request.body as Readable).resume();
          return reply.code(200).send({ index, status: 'stored' });
        }
        await fs.promises.rm(canonical, { force: true });
      }
      const streamed = await streamChunkToFile(request.body as Readable, temporary, expectedBytes, config.uploadChunkSizeBytes);
      if (streamed.sha256 !== digestHeader) throw new AppError('CHUNK_HASH_MISMATCH', 'Chunk SHA-256 does not match.', 422);
      await fs.promises.rename(temporary, canonical);
      published = true;
      await fs.promises.chmod(canonical, 0o600);
      repository.commitPart({ uploadId, index, bytes: streamed.bytes, sha256: streamed.sha256, relativePath: canonicalRelative, owner });
      request.log.info({ uploadId, index, bytes: streamed.bytes }, 'upload chunk stored');
      return reply.code(201).send({ index, status: 'stored' });
    } catch (error) {
      repository.releasePartClaim(uploadId, index, owner);
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      if (published && repository.get(uploadId)?.status === 'aborted') await fs.promises.rm(canonical, { force: true }).catch(() => undefined);
      throw error;
    }
  });

  app.get('/api/v1/uploads/:uploadId', {
    schema: { tags: ['uploads'], params: uploadParamsSchema, response: { 200: uploadStatusSchema, 401: errorResponseSchema, 404: errorResponseSchema } },
  }, async (request) => {
    const { uploadId } = uploadParamsSchema.parse(request.params);
    await reconcileMissingFiles(uploadId);
    return repository.statusView(uploadId);
  });

  app.post('/api/v1/uploads/:uploadId/complete', {
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: { tags: ['uploads'], params: uploadParamsSchema, response: { 200: completeUploadResponseSchema, 202: completeUploadResponseSchema, 401: errorResponseSchema, 409: errorResponseSchema, 410: errorResponseSchema } },
  }, async (request, reply) => {
    const { uploadId } = uploadParamsSchema.parse(request.params);
    if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) throw new AppError('BAD_REQUEST', 'Complete requests must not include a body.', 400);
    await reconcileMissingFiles(uploadId);
    const session = repository.requestFinalize(uploadId, ulid());
    const response = completeResponse(session);
    return reply.code(response.status === 'completed' ? 200 : 202).send(response);
  });

  app.delete('/api/v1/uploads/:uploadId', {
    schema: { tags: ['uploads'], params: uploadParamsSchema, response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema } },
  }, async (request, reply) => {
    const { uploadId } = uploadParamsSchema.parse(request.params);
    repository.abort(uploadId);
    void removePath(resolveInside(config.dataDir, uploadSessionRelativePath(uploadId)))
      .then(() => repository.clearTerminalParts(uploadId))
      .catch((error: unknown) => request.log.warn({ err: error, uploadId }, 'aborted upload cleanup will be retried'));
    return reply.code(204).send();
  });
}
