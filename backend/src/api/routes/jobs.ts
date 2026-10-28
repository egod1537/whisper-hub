import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import type { TranscriptionProvider } from '../../shared/providers/interface.js';
import type { JobRepository } from '../../shared/queue/repository.js';
import { normalizeFilename, parseFormats, parseLanguage } from '../../shared/queue/options.js';
import type { Job, OutputFormat } from '../../shared/queue/types.js';
import type { UploadRepository } from '../../shared/uploads/repository.js';
import { moveUploadIntoPlace, removePath, streamUploadToTemp } from '../../shared/storage/files.js';
import { contentDisposition, resolveInside, safeDownloadBaseName, sourceRelativePath } from '../../shared/storage/paths.js';
import {
  createJobResponseSchema,
  errorResponseSchema,
  idParamsSchema,
  jobDetailSchema,
  jobSummarySchema,
  listQuerySchema,
  resultParamsSchema,
  resultsSchema,
  systemStatusSchema,
} from '../schemas.js';
import { jobDetail, jobSummary } from '../presentation.js';

function requestHash(fileHash: string, language: string, formats: OutputFormat[]): string {
  return createHash('sha256').update(JSON.stringify({ fileHash, language, formats })).digest('hex');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = z.object({ createdAt: z.iso.datetime(), id: z.string() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Cursor is invalid.', 422);
  }
}

function encodeCursor(job: Job): string {
  return Buffer.from(JSON.stringify({ createdAt: job.createdAt, id: job.id })).toString('base64url');
}

const contentTypes: Record<OutputFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

export async function jobRoutes(app: FastifyInstance, options: {
  config: Config;
  repository: JobRepository;
  provider: TranscriptionProvider;
  uploadRepository: UploadRepository;
}): Promise<void> {
  const { config, repository, provider, uploadRepository } = options;

  app.post('/api/v1/jobs', {
    schema: {
      tags: ['jobs'],
      consumes: ['multipart/form-data'],
      response: { 200: createJobResponseSchema, 202: createJobResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 409: errorResponseSchema, 413: errorResponseSchema, 415: errorResponseSchema, 422: errorResponseSchema },
    },
  }, async (request, reply) => {
    const idempotencyKeyHeader = request.headers['idempotency-key'];
    if (Array.isArray(idempotencyKeyHeader) || (idempotencyKeyHeader !== undefined && !/^[\x21-\x7e]{1,128}$/.test(idempotencyKeyHeader))) {
      throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 1-128 safe ASCII characters.', 422);
    }
    const fields: Record<string, string> = {};
    let stored: Awaited<ReturnType<typeof streamUploadToTemp>> | null = null;
    let filename = '';
    let mediaType = '';
    let fileCount = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileCount += 1;
          if (part.fieldname !== 'file' || fileCount > 1) {
            part.file.resume();
            throw new AppError('BAD_REQUEST', 'Exactly one file field is required.', 400);
          }
          if (!part.mimetype.startsWith('audio/') && !part.mimetype.startsWith('video/')) {
            part.file.resume();
            throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only audio or video uploads are accepted.', 415);
          }
          filename = normalizeFilename(part.filename);
          mediaType = part.mimetype;
          stored = await streamUploadToTemp(config.dataDir, part.file, config.maxUploadBytes);
          if (part.file.truncated) throw new AppError('PAYLOAD_TOO_LARGE', 'Uploaded file is too large.', 413);
        } else {
          if (!['language', 'formats', 'prompt'].includes(part.fieldname) || typeof part.value !== 'string') {
            throw new AppError('BAD_REQUEST', 'Unexpected multipart field.', 400);
          }
          if (fields[part.fieldname] !== undefined) throw new AppError('BAD_REQUEST', 'Duplicate multipart field.', 400);
          fields[part.fieldname] = part.value;
        }
      }
      if (!stored || fileCount !== 1) throw new AppError('BAD_REQUEST', 'Exactly one file field is required.', 400);
      if (fields.prompt !== undefined) throw new AppError('VALIDATION_FAILED', 'Prompt is not supported in this version.', 422);
      const language = parseLanguage(fields.language);
      const formats = parseFormats(fields.formats);
      const hash = requestHash(stored.sha256, language, formats);
      if (idempotencyKeyHeader) {
        const existing = repository.findByIdempotencyKey(idempotencyKeyHeader);
        if (existing) {
          if (existing.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request.', 409);
          await removePath(stored.tempPath);
          stored = null;
          return reply.code(200).send({
            id: existing.id,
            status: existing.status,
            phase: existing.phase,
            createdAt: existing.createdAt,
            queuePosition: repository.queuePosition(existing.id),
            links: { self: `/api/v1/jobs/${existing.id}`, results: `/api/v1/jobs/${existing.id}/results` },
          });
        }
      }
      const id = ulid();
      const sourcePath = sourceRelativePath(id);
      await moveUploadIntoPlace(config.dataDir, stored.tempPath, sourcePath);
      stored = null;
      let job: Job;
      try {
        job = repository.create({
          id,
          originalFilename: filename,
          mediaType,
          fileSizeBytes: (await fs.promises.stat(resolveInside(config.dataDir, sourcePath))).size,
          sourcePath,
          language,
          requestedOutputFormats: formats,
          maxAttempts: config.jobMaxAttempts,
          model: config.defaultModel,
          ...(idempotencyKeyHeader ? { idempotencyKey: idempotencyKeyHeader, requestHash: hash } : {}),
        });
      } catch (error) {
        await removePath(path.dirname(resolveInside(config.dataDir, sourcePath)));
        if (idempotencyKeyHeader) {
          const existing = repository.findByIdempotencyKey(idempotencyKeyHeader);
          if (existing?.requestHash === hash) {
            return reply.code(200).send({
              id: existing.id, status: existing.status, phase: existing.phase, createdAt: existing.createdAt,
              queuePosition: repository.queuePosition(existing.id),
              links: { self: `/api/v1/jobs/${existing.id}`, results: `/api/v1/jobs/${existing.id}/results` },
            });
          }
        }
        throw error;
      }
      request.log.info({ jobId: job.id, status: job.status }, 'job queued');
      return reply.code(202).send({
        id: job.id,
        status: 'queued',
        phase: null,
        createdAt: job.createdAt,
        queuePosition: repository.queuePosition(job.id),
        links: { self: `/api/v1/jobs/${job.id}`, results: `/api/v1/jobs/${job.id}/results` },
      });
    } finally {
      if (stored) await removePath(stored.tempPath);
    }
  });

  app.get('/api/v1/jobs', {
    schema: {
      tags: ['jobs'], querystring: listQuerySchema,
      response: { 200: z.object({ items: z.array(jobSummarySchema), nextCursor: z.string().nullable() }) },
    },
  }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const items = repository.list({
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit + 1,
      ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
    });
    const hasNext = items.length > query.limit;
    const page = items.slice(0, query.limit);
    return { items: page.map((job) => jobSummary(job, repository)), nextCursor: hasNext && page.length ? encodeCursor(page[page.length - 1]!) : null };
  });

  app.get('/api/v1/jobs/:id', {
    schema: { tags: ['jobs'], params: idParamsSchema, response: { 200: jobDetailSchema, 404: errorResponseSchema } },
  }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return jobDetail(repository.getRequired(id), repository);
  });

  app.delete('/api/v1/jobs/:id', {
    schema: { tags: ['jobs'], params: idParamsSchema, response: { 202: jobSummarySchema, 404: errorResponseSchema, 409: errorResponseSchema } },
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const job = repository.requestCancellation(id);
    request.log.info({ jobId: job.id, status: job.status }, 'job cancellation requested');
    return reply.code(202).send(jobSummary(job, repository));
  });

  app.post('/api/v1/jobs/:id/retry', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags: ['jobs'], params: idParamsSchema, response: { 202: jobSummarySchema, 404: errorResponseSchema, 409: errorResponseSchema } },
  }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const job = repository.retryFailed(id, config.jobMaxAttempts);
    request.log.info({ jobId: job.id, status: job.status, manualRetryCount: job.manualRetryCount }, 'job manually retried');
    return reply.code(202).send(jobSummary(job, repository));
  });

  app.get('/api/v1/jobs/:id/results', {
    schema: { tags: ['results'], params: idParamsSchema, response: { 200: resultsSchema, 404: errorResponseSchema, 409: errorResponseSchema } },
  }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const job = repository.getRequired(id);
    if (job.status !== 'completed') throw new AppError('JOB_NOT_COMPLETE', 'Job is not complete.', 409);
    const availableFormats = job.requestedOutputFormats.filter((format) => {
      if (!job.resultBasePath) return false;
      return fs.existsSync(resolveInside(config.dataDir, path.posix.join(job.resultBasePath, `transcript.${format}`)));
    });
    return {
      jobId: id,
      availableFormats,
      files: availableFormats.map((format) => ({ format, url: `/api/v1/jobs/${id}/results/${format}` })),
    };
  });

  app.get('/api/v1/jobs/:id/results/:format', {
    schema: { tags: ['results'], params: resultParamsSchema },
  }, async (request, reply) => {
    const { id, format } = resultParamsSchema.parse(request.params);
    const job = repository.getRequired(id);
    if (job.status !== 'completed') throw new AppError('JOB_NOT_COMPLETE', 'Job is not complete.', 409);
    if (!job.resultBasePath || !job.requestedOutputFormats.includes(format)) throw new AppError('FORMAT_NOT_AVAILABLE', 'Result format is unavailable.', 404);
    const filePath = resolveInside(config.dataDir, path.posix.join(job.resultBasePath, `transcript.${format}`));
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      throw new AppError('FORMAT_NOT_AVAILABLE', 'Result format is unavailable.', 404);
    }
    const downloadName = `${safeDownloadBaseName(job.originalFilename)}.${format}`;
    reply.header('content-type', contentTypes[format]);
    reply.header('content-disposition', contentDisposition(downloadName));
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/api/v1/system/status', {
    schema: { tags: ['system'], response: { 200: systemStatusSchema } },
  }, async () => {
    const [reachable, counts, worker] = await Promise.all([
      provider.health(), Promise.resolve(repository.counts()), Promise.resolve(repository.getWorkerFreshness()),
    ]);
    return { provider: { reachable, model: config.defaultModel }, jobs: counts, worker, uploads: uploadRepository.metrics() };
  });
}

export const jobRouteInternals = { parseFormats, parseLanguage, decodeCursor, encodeCursor };
