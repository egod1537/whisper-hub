export const jobStatuses = ['queued', 'processing', 'pausing', 'paused', 'completed', 'failed', 'canceled'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const jobOrigins = ['web', 'api', 'unknown'] as const;
export type JobOrigin = (typeof jobOrigins)[number];

export const jobPhases = ['validating', 'converting', 'transcribing', 'exporting'] as const;
export type JobPhase = (typeof jobPhases)[number];

export const outputFormats = ['txt', 'srt', 'vtt', 'json'] as const;
export type OutputFormat = (typeof outputFormats)[number];

export type Language = 'auto' | 'ko' | 'ja' | 'en';

export interface JobError {
  code: string;
  message: string;
}

export interface JobSummary {
  id: string;
  origin: JobOrigin;
  status: JobStatus;
  phase: JobPhase | null;
  createdAt: string;
  updatedAt: string;
  originalFilename: string;
  attempts: number;
  queuePosition: number | null;
  error: JobError | null;
}

export interface JobDetail extends JobSummary {
  startedAt: string | null;
  completedAt: string | null;
  fileSizeBytes: number;
  durationSeconds: number | null;
  language: string;
  formats: OutputFormat[];
}

export interface CreateJobResponse {
  id: string;
  origin: JobOrigin;
  status: JobStatus;
  phase: JobPhase | null;
  createdAt: string;
  queuePosition: number | null;
  links: { self: string; results: string };
}

export interface JobsPage {
  items: JobSummary[];
  nextCursor: string | null;
}

export interface ResultsManifest {
  jobId: string;
  availableFormats: OutputFormat[];
}

export interface SystemStatus {
  provider: { reachable: boolean; model: string };
  jobs: { processing: number; queued: number; paused: number; origins: Record<JobOrigin, number> };
  worker: { fresh: boolean; lastHeartbeatAt: string | null };
  uploads: { active: number; stagedBytes: number; finalizing: number };
}

export const uploadStatuses = ['uploading', 'finalizing', 'completed', 'expired', 'aborted'] as const;
export type UploadStatusName = (typeof uploadStatuses)[number];

export interface CreateUploadResponse {
  uploadId: string;
  chunkSizeBytes: number;
  totalChunks: number;
  expiresAt: string;
  status: UploadStatusName;
}

export interface UploadStatusResponse {
  uploadId: string;
  status: UploadStatusName;
  sizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  receivedParts: number[];
  receivedBytes: number;
  expiresAt: string;
  jobId: string | null;
  error: JobError | null;
}

export interface CompleteUploadResponse {
  uploadId: string;
  status: 'finalizing' | 'completed';
  jobId: string | null;
  jobUrl: string | null;
}

export class ContractError extends Error {
  constructor(message = '서버 응답 형식이 올바르지 않습니다.') {
    super(message);
    this.name = 'ContractError';
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError();
  return value as JsonRecord;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new ContractError();
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ContractError();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] {
  const candidate = string(value);
  if (!values.includes(candidate)) throw new ContractError();
  return candidate as T[number];
}

function nullableEnum<T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return value === null ? null : enumValue(value, values);
}

function jobError(value: unknown): JobError | null {
  if (value === null) return null;
  const item = record(value);
  return { code: string(item.code), message: string(item.message) };
}

export function parseJobSummary(value: unknown): JobSummary {
  const item = record(value);
  return {
    id: string(item.id),
    origin: enumValue(item.origin, jobOrigins),
    status: enumValue(item.status, jobStatuses),
    phase: nullableEnum(item.phase, jobPhases),
    createdAt: string(item.createdAt),
    updatedAt: string(item.updatedAt),
    originalFilename: string(item.originalFilename),
    attempts: number(item.attempts),
    queuePosition: nullableNumber(item.queuePosition),
    error: jobError(item.error),
  };
}

export function parseJobDetail(value: unknown): JobDetail {
  const item = record(value);
  const summary = parseJobSummary(item);
  if (!Array.isArray(item.formats)) throw new ContractError();
  return {
    ...summary,
    startedAt: nullableString(item.startedAt),
    completedAt: nullableString(item.completedAt),
    fileSizeBytes: number(item.fileSizeBytes),
    durationSeconds: nullableNumber(item.durationSeconds),
    language: string(item.language),
    formats: item.formats.map((format) => enumValue(format, outputFormats)),
  };
}

export function parseCreateJob(value: unknown): CreateJobResponse {
  const item = record(value);
  const links = record(item.links);
  return {
    id: string(item.id),
    origin: enumValue(item.origin, jobOrigins),
    status: enumValue(item.status, jobStatuses),
    phase: nullableEnum(item.phase, jobPhases),
    createdAt: string(item.createdAt),
    queuePosition: nullableNumber(item.queuePosition),
    links: { self: string(links.self), results: string(links.results) },
  };
}

export function parseJobsPage(value: unknown): JobsPage {
  const item = record(value);
  if (!Array.isArray(item.items)) throw new ContractError();
  return {
    items: item.items.map(parseJobSummary),
    nextCursor: nullableString(item.nextCursor),
  };
}

export function parseResults(value: unknown): ResultsManifest {
  const item = record(value);
  if (!Array.isArray(item.availableFormats)) throw new ContractError();
  return {
    jobId: string(item.jobId),
    availableFormats: item.availableFormats.map((format) => enumValue(format, outputFormats)),
  };
}

export function parseSystemStatus(value: unknown): SystemStatus {
  const item = record(value);
  const provider = record(item.provider);
  const jobs = record(item.jobs);
  const worker = record(item.worker);
  const uploads = record(item.uploads);
  return {
    provider: { reachable: boolean(provider.reachable), model: string(provider.model) },
    jobs: {
      processing: number(jobs.processing), queued: number(jobs.queued), paused: number(jobs.paused),
      origins: (() => {
        const origins = record(jobs.origins);
        return { web: number(origins.web), api: number(origins.api), unknown: number(origins.unknown) };
      })(),
    },
    worker: { fresh: boolean(worker.fresh), lastHeartbeatAt: nullableString(worker.lastHeartbeatAt) },
    uploads: { active: number(uploads.active), stagedBytes: number(uploads.stagedBytes), finalizing: number(uploads.finalizing) },
  };
}

export function parseCreateUpload(value: unknown): CreateUploadResponse {
  const item = record(value);
  return {
    uploadId: string(item.uploadId), chunkSizeBytes: number(item.chunkSizeBytes), totalChunks: number(item.totalChunks),
    expiresAt: string(item.expiresAt), status: enumValue(item.status, uploadStatuses),
  };
}

export function parseUploadStatus(value: unknown): UploadStatusResponse {
  const item = record(value);
  if (!Array.isArray(item.receivedParts)) throw new ContractError();
  return {
    uploadId: string(item.uploadId), status: enumValue(item.status, uploadStatuses), sizeBytes: number(item.sizeBytes),
    chunkSizeBytes: number(item.chunkSizeBytes), totalChunks: number(item.totalChunks),
    receivedParts: item.receivedParts.map(number), receivedBytes: number(item.receivedBytes), expiresAt: string(item.expiresAt),
    jobId: nullableString(item.jobId), error: jobError(item.error),
  };
}

export function parseCompleteUpload(value: unknown): CompleteUploadResponse {
  const item = record(value);
  return {
    uploadId: string(item.uploadId), status: enumValue(item.status, ['finalizing', 'completed'] as const),
    jobId: nullableString(item.jobId), jobUrl: nullableString(item.jobUrl),
  };
}
