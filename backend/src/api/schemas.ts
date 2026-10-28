import { z } from 'zod';
import { jobOrigins, jobPhases, jobStatuses, outputFormats } from '../shared/queue/types.js';

const jobProgressSchema = z.object({
  current: z.number().nonnegative(), total: z.number().positive(), unit: z.enum(['bytes', 'seconds']),
  percent: z.number().min(0).max(100),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const jobSummarySchema = z.object({
  id: z.string(),
  origin: z.enum(jobOrigins),
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
  progress: jobProgressSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  originalFilename: z.string(),
  attempts: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const jobDetailSchema = z.object({
  id: z.string(),
  origin: z.enum(jobOrigins),
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
  progress: jobProgressSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  originalFilename: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  language: z.string(),
  formats: z.array(z.enum(outputFormats)),
  attempts: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const createJobResponseSchema = z.object({
  id: z.string(),
  origin: z.enum(jobOrigins),
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
  createdAt: z.iso.datetime(),
  queuePosition: z.number().int().positive().nullable(),
  links: z.object({ self: z.string(), results: z.string() }),
});

export const createYoutubeJobBodySchema = z.strictObject({
  url: z.string().min(1).max(2_048),
  language: z.string().min(1).max(16).default('auto'),
  formats: z.array(z.enum(outputFormats)).min(1).max(outputFormats.length).default(['txt', 'srt', 'json']),
});

export const idParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const resultParamsSchema = idParamsSchema.extend({ format: z.enum(outputFormats) });
export const listQuerySchema = z.object({
  status: z.enum(jobStatuses).optional(),
  origin: z.enum(jobOrigins).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1_024).optional(),
});

export const resultsSchema = z.object({
  jobId: z.string(),
  availableFormats: z.array(z.enum(outputFormats)),
  files: z.array(z.object({ format: z.enum(outputFormats), url: z.string() })),
});

export const systemStatusSchema = z.object({
  provider: z.object({ reachable: z.boolean(), model: z.string() }),
  jobs: z.object({
    processing: z.number().int(), queued: z.number().int(), paused: z.number().int(),
    origins: z.object({ web: z.number().int(), api: z.number().int(), unknown: z.number().int() }),
  }),
  worker: z.object({ fresh: z.boolean(), lastHeartbeatAt: z.string().nullable() }),
  uploads: z.object({ active: z.number().int(), stagedBytes: z.number().int(), finalizing: z.number().int() }),
});

export const createUploadBodySchema = z.strictObject({
  filename: z.string().min(1).max(1024),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mimeType: z.string().min(1).max(255).optional(),
  language: z.string().min(1).max(16),
  formats: z.array(z.enum(outputFormats)).min(1).max(outputFormats.length),
});

export const uploadParamsSchema = z.object({ uploadId: z.uuid() });
export const uploadPartParamsSchema = uploadParamsSchema.extend({ index: z.coerce.number().int().nonnegative() });

export const uploadStatusSchema = z.object({
  uploadId: z.string(), status: z.enum(['uploading', 'finalizing', 'completed', 'expired', 'aborted']),
  sizeBytes: z.number().int().positive(), chunkSizeBytes: z.number().int().positive(), totalChunks: z.number().int().positive(),
  receivedParts: z.array(z.number().int().nonnegative()), receivedBytes: z.number().int().nonnegative(), assembledBytes: z.number().int().nonnegative(), expiresAt: z.iso.datetime(),
  jobId: z.string().nullable(), error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const createUploadResponseSchema = z.object({
  uploadId: z.string(), chunkSizeBytes: z.number().int().positive(), totalChunks: z.number().int().positive(),
  expiresAt: z.iso.datetime(), status: z.enum(['uploading', 'finalizing', 'completed', 'expired', 'aborted']),
});

export const completeUploadResponseSchema = z.object({
  uploadId: z.string(), status: z.enum(['finalizing', 'completed']), jobId: z.string().nullable(), jobUrl: z.string().nullable(),
});

