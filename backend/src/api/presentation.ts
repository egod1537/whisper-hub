import type { JobRepository } from '../shared/queue/repository.js';
import type { Job } from '../shared/queue/types.js';

function errorFor(job: Job): { code: string; message: string } | null {
  if (job.status !== 'failed' || !job.errorCode || !job.errorMessage) return null;
  return { code: job.errorCode, message: job.errorMessage };
}

function progressFor(job: Job): { current: number; total: number; unit: 'bytes' | 'seconds'; percent: number } | null {
  if (!['processing', 'pausing'].includes(job.status) || job.progressCurrent === null || job.progressTotal === null || job.progressUnit === null || job.progressTotal <= 0) return null;
  const current = Math.min(Math.max(job.progressCurrent, 0), job.progressTotal);
  return { current, total: job.progressTotal, unit: job.progressUnit, percent: Math.round(current / job.progressTotal * 1_000) / 10 };
}

export function jobSummary(job: Job, repository: JobRepository) {
  return {
    id: job.id,
    origin: job.origin,
    status: job.status,
    phase: job.phase,
    progress: progressFor(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    originalFilename: job.originalFilename,
    attempts: job.attempts,
    queuePosition: repository.queuePosition(job.id),
    error: errorFor(job),
  };
}

export function jobDetail(job: Job, repository: JobRepository) {
  return {
    id: job.id,
    origin: job.origin,
    status: job.status,
    phase: job.phase,
    progress: progressFor(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    originalFilename: job.originalFilename,
    fileSizeBytes: job.fileSizeBytes,
    durationSeconds: job.durationSeconds,
    language: job.language,
    formats: job.requestedOutputFormats,
    attempts: job.attempts,
    queuePosition: repository.queuePosition(job.id),
    error: errorFor(job),
  };
}

