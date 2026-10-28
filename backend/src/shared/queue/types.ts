export const jobStatuses = ['queued', 'processing', 'pausing', 'paused', 'completed', 'failed', 'canceled'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const jobOrigins = ['web', 'api', 'unknown'] as const;
export type JobOrigin = (typeof jobOrigins)[number];
export const jobPhases = ['fetching', 'validating', 'converting', 'transcribing', 'exporting'] as const;
export type JobPhase = (typeof jobPhases)[number];
export const jobSourceTypes = ['upload', 'youtube'] as const;
export type JobSourceType = (typeof jobSourceTypes)[number];
export const outputFormats = ['txt', 'srt', 'vtt', 'json'] as const;
export type OutputFormat = (typeof outputFormats)[number];

export interface Job {
  id: string;
  status: JobStatus;
  phase: JobPhase | null;
  origin: JobOrigin;
  sourceType: JobSourceType;
  sourceUrl: string | null;
  createdAt: string;
  queueEnteredAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  originalFilename: string;
  mediaType: string;
  fileSizeBytes: number;
  sourcePath: string;
  durationSeconds: number | null;
  language: string;
  requestedOutputFormats: OutputFormat[];
  provider: string;
  model: string | null;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  resultBasePath: string | null;
  resultMetadata: Record<string, unknown> | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  nextAttemptAt: string | null;
  manualRetryCount: number;
}

export interface CreateJobInput {
  id: string;
  originalFilename: string;
  mediaType: string;
  fileSizeBytes: number;
  sourcePath: string;
  language: string;
  requestedOutputFormats: OutputFormat[];
  maxAttempts: number;
  model: string;
  origin: JobOrigin;
  sourceType?: JobSourceType;
  sourceUrl?: string;
  idempotencyKey?: string;
  requestHash?: string;
}

export interface ListJobsInput {
  status?: JobStatus;
  origin?: JobOrigin;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

