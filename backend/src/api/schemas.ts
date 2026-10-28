import { z } from 'zod';
import { jobPhases, jobStatuses, outputFormats } from '../shared/queue/types.js';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export const jobSummarySchema = z.object({
  id: z.string(),
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  originalFilename: z.string(),
  attempts: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const jobDetailSchema = z.object({
  id: z.string(),
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
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
  status: z.enum(jobStatuses),
  phase: z.enum(jobPhases).nullable(),
  createdAt: z.iso.datetime(),
  queuePosition: z.number().int().positive().nullable(),
  links: z.object({ self: z.string(), results: z.string() }),
});

export const idParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const resultParamsSchema = idParamsSchema.extend({ format: z.enum(outputFormats) });
export const listQuerySchema = z.object({
  status: z.enum(jobStatuses).optional(),
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
  jobs: z.object({ processing: z.number().int(), queued: z.number().int() }),
  worker: z.object({ fresh: z.boolean(), lastHeartbeatAt: z.string().nullable() }),
});

