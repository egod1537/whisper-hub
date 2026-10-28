import type { JobRepository } from '../shared/queue/repository.js';
import type { Job } from '../shared/queue/types.js';

function errorFor(job: Job): { code: string; message: string } | null {
  if (job.status !== 'failed' || !job.errorCode || !job.errorMessage) return null;
  return { code: job.errorCode, message: job.errorMessage };
}

export function jobSummary(job: Job, repository: JobRepository) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
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
    status: job.status,
    phase: job.phase,
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

