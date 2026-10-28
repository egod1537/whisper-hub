import {
  ContractError,
  outputFormats,
  parseCreateJob,
  parseCreateUpload,
  parseCompleteUpload,
  parseJobDetail,
  parseJobSummary,
  parseJobsPage,
  parseResults,
  parseSystemStatus,
  parseUploadStatus,
  type CompleteUploadResponse,
  type CreateUploadResponse,
  type CreateJobResponse,
  type JobDetail,
  type JobOrigin,
  type JobsPage,
  type JobSummary,
  type Language,
  type OutputFormat,
  type ResultsManifest,
  type SystemStatus,
  type UploadStatusResponse,
} from './types';

export interface UploadRequest {
  file: File;
  language: Language;
  formats: OutputFormat[];
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface DownloadedResult {
  blob: Blob;
  filename: string;
}

export interface WhisperApi {
  listJobs(options?: { limit?: number; cursor?: string; origin?: JobOrigin; signal?: AbortSignal }): Promise<JobsPage>;
  getJob(id: string, signal?: AbortSignal): Promise<JobDetail>;
  getSystemStatus(signal?: AbortSignal): Promise<SystemStatus>;
  createJob(request: UploadRequest): Promise<CreateJobResponse>;
  createUpload(request: { filename: string; sizeBytes: number; mimeType?: string; language: Language; formats: OutputFormat[]; idempotencyKey: string; signal?: AbortSignal }): Promise<CreateUploadResponse>;
  getUpload(uploadId: string, signal?: AbortSignal): Promise<UploadStatusResponse>;
  putUploadPart(uploadId: string, index: number, chunk: Blob, sha256: string, signal?: AbortSignal): Promise<void>;
  completeUpload(uploadId: string, signal?: AbortSignal): Promise<CompleteUploadResponse>;
  abortUpload(uploadId: string, signal?: AbortSignal): Promise<void>;
  cancelJob(id: string, signal?: AbortSignal): Promise<JobSummary>;
  pauseJob(id: string, signal?: AbortSignal): Promise<JobSummary>;
  resumeJob(id: string, signal?: AbortSignal): Promise<JobSummary>;
  retryJob(id: string, signal?: AbortSignal): Promise<JobSummary>;
  getResults(id: string, signal?: AbortSignal): Promise<ResultsManifest>;
  fetchResultText(id: string, signal?: AbortSignal): Promise<string>;
  downloadResult(id: string, format: OutputFormat, fallbackName: string, signal?: AbortSignal): Promise<DownloadedResult>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageFor(status: number, code: string): string {
  if (status === 401) return 'API 키가 올바르지 않습니다.';
  if (status === 413) return '파일이 서버의 업로드 제한을 초과했습니다.';
  if (status === 415) return '지원하지 않는 파일 형식입니다.';
  if (status === 422) return '파일 또는 전사 옵션을 확인해 주세요.';
  if (status === 409 && code === 'JOB_NOT_COMPLETE') return '아직 결과를 받을 수 없는 작업입니다.';
  if (status === 409) return '현재 작업 상태에서는 요청을 처리할 수 없습니다.';
  if (status === 404) return '작업 또는 결과를 찾을 수 없습니다. 보존 기간이 지났을 수 있습니다.';
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 507) return '서버 저장 공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요.';
  if (status === 410) return '업로드 세션이 만료되었습니다. 새 업로드를 시작해 주세요.';
  if (status >= 500) return '서버를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.';
  return '요청을 처리하지 못했습니다.';
}

async function errorFrom(response: Response): Promise<ApiError> {
  let code = 'HTTP_ERROR';
  let requestId: string | null = response.headers.get('x-request-id');
  try {
    const body = await response.json() as unknown;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        if (typeof record.code === 'string') code = record.code;
        if (typeof record.requestId === 'string') requestId = record.requestId;
      }
    }
  } catch {
    // The status code remains authoritative when an intermediary returns non-JSON.
  }
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null;
  return new ApiError(response.status, code, messageFor(response.status, code), requestId, retryAfterSeconds);
}

function safeId(id: string): string {
  return encodeURIComponent(id);
}

function resultPath(id: string, format: OutputFormat): string {
  if (!outputFormats.includes(format)) throw new ContractError();
  return `/jobs/${safeId(id)}/results/${format}`;
}

function sanitizeFilename(value: string, fallback: string): string {
  const withoutControls = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? '_' : character;
  }).join('');
  const cleaned = withoutControls.replaceAll('\\', '_').replaceAll('/', '_').trim();
  return cleaned.slice(0, 180) || fallback;
}

function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return null; }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null;
}

function fallbackResultName(sourceName: string, format: OutputFormat): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'transcript';
  return sanitizeFilename(`${base}.${format}`, `transcript.${format}`);
}

export class ApiClient implements WhisperApi {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey = '',
    baseUrl = '/web-api/v1',
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.response(path, init);
    try {
      return await response.json() as unknown;
    } catch {
      throw new ContractError();
    }
  }

  async listJobs(options: { limit?: number; cursor?: string; origin?: JobOrigin; signal?: AbortSignal } = {}): Promise<JobsPage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.origin) query.set('origin', options.origin);
    return parseJobsPage(await this.json(`/jobs?${query.toString()}`, { signal: options.signal }));
  }

  async getJob(id: string, signal?: AbortSignal): Promise<JobDetail> {
    return parseJobDetail(await this.json(`/jobs/${safeId(id)}`, { signal }));
  }

  async getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
    return parseSystemStatus(await this.json('/system/status', { signal }));
  }

  async createJob(request: UploadRequest): Promise<CreateJobResponse> {
    const body = new FormData();
    body.append('file', request.file);
    body.append('language', request.language);
    body.append('formats', request.formats.join(','));
    return parseCreateJob(await this.json('/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': request.idempotencyKey },
      body,
      signal: request.signal,
    }));
  }

  async createUpload(request: { filename: string; sizeBytes: number; mimeType?: string; language: Language; formats: OutputFormat[]; idempotencyKey: string; signal?: AbortSignal }): Promise<CreateUploadResponse> {
    return parseCreateUpload(await this.json('/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
      body: JSON.stringify({ filename: request.filename, sizeBytes: request.sizeBytes, ...(request.mimeType ? { mimeType: request.mimeType } : {}), language: request.language, formats: request.formats }),
      signal: request.signal,
    }));
  }

  async getUpload(uploadId: string, signal?: AbortSignal): Promise<UploadStatusResponse> {
    return parseUploadStatus(await this.json(`/uploads/${safeId(uploadId)}`, { signal }));
  }

  async putUploadPart(uploadId: string, index: number, chunk: Blob, sha256: string, signal?: AbortSignal): Promise<void> {
    await this.response(`/uploads/${safeId(uploadId)}/parts/${index}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': sha256 }, body: chunk, signal,
    });
  }

  async completeUpload(uploadId: string, signal?: AbortSignal): Promise<CompleteUploadResponse> {
    return parseCompleteUpload(await this.json(`/uploads/${safeId(uploadId)}/complete`, { method: 'POST', signal }));
  }

  async abortUpload(uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.response(`/uploads/${safeId(uploadId)}`, { method: 'DELETE', signal });
  }

  async cancelJob(id: string, signal?: AbortSignal): Promise<JobSummary> {
    return parseJobSummary(await this.json(`/jobs/${safeId(id)}`, { method: 'DELETE', signal }));
  }

  async pauseJob(id: string, signal?: AbortSignal): Promise<JobSummary> {
    return parseJobSummary(await this.json(`/jobs/${safeId(id)}/pause`, { method: 'POST', signal }));
  }

  async resumeJob(id: string, signal?: AbortSignal): Promise<JobSummary> {
    return parseJobSummary(await this.json(`/jobs/${safeId(id)}/resume`, { method: 'POST', signal }));
  }

  async retryJob(id: string, signal?: AbortSignal): Promise<JobSummary> {
    return parseJobSummary(await this.json(`/jobs/${safeId(id)}/retry`, { method: 'POST', signal }));
  }

  async getResults(id: string, signal?: AbortSignal): Promise<ResultsManifest> {
    return parseResults(await this.json(`/jobs/${safeId(id)}/results`, { signal }));
  }

  async fetchResultText(id: string, signal?: AbortSignal): Promise<string> {
    const response = await this.response(resultPath(id, 'txt'), { signal });
    return response.text();
  }

  async downloadResult(id: string, format: OutputFormat, fallbackName: string, signal?: AbortSignal): Promise<DownloadedResult> {
    const response = await this.response(resultPath(id, format), { signal });
    const receivedName = dispositionFilename(response.headers.get('content-disposition'));
    return {
      blob: await response.blob(),
      filename: sanitizeFilename(receivedName ?? '', fallbackResultName(fallbackName, format)),
    };
  }
}

export async function checkHealth(signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<boolean> {
  try {
    const response = await fetcher('/health/ready', { signal });
    return response.ok;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return false;
  }
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError || error instanceof ContractError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (error instanceof Error && !(error instanceof TypeError)) return error.message;
  return '서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.';
}
