import { ApiError, type WhisperApi } from './client';
import type { CreateJobResponse, Language, OutputFormat, UploadStatusResponse } from './types';

export interface ResumableUploadOptions {
  existingUploadId?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  concurrency?: number;
  onSession?(uploadId: string): void;
  onProgress?(completedBytes: number, totalBytes: number, phase: 'uploading' | 'finalizing'): void;
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const bytes = typeof blob.arrayBuffer === 'function'
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('청크를 읽지 못했습니다.'));
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function retryable(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && (error.status === 429 || error.status >= 500));
}

async function uploadPartWithRetry(api: WhisperApi, uploadId: string, index: number, chunk: Blob, signal: AbortSignal | undefined, wait: ResumableUploadOptions['wait'], random: () => number): Promise<void> {
  const digest = await sha256Blob(chunk);
  for (let retries = 0; ; retries += 1) {
    try {
      await api.putUploadPart(uploadId, index, chunk, digest, signal);
      return;
    } catch (error) {
      if (!retryable(error) || retries >= 3) throw error;
      const retryAfter = error instanceof ApiError ? error.retryAfterSeconds : null;
      const delay = retryAfter === null ? 300 * (2 ** retries) + Math.floor(random() * 150) : retryAfter * 1_000;
      await (wait ?? defaultWait)(delay, signal);
    }
  }
}

function completedBytes(status: UploadStatusResponse, fileSize: number): number {
  return status.receivedParts.reduce((sum, index) => {
    const start = index * status.chunkSizeBytes;
    return sum + Math.max(0, Math.min(status.chunkSizeBytes, fileSize - start));
  }, 0);
}

export async function uploadResumably(api: WhisperApi, file: File, language: Language, formats: OutputFormat[], options: ResumableUploadOptions): Promise<CreateJobResponse> {
  const wait = options.wait ?? defaultWait;
  const random = options.random ?? Math.random;
  let uploadId = options.existingUploadId;
  let status: UploadStatusResponse;
  if (uploadId) {
    status = await api.getUpload(uploadId, options.signal);
    if (status.sizeBytes !== file.size) throw new Error('선택한 파일 크기가 재개할 업로드와 다릅니다.');
  } else {
    const created = await api.createUpload({ filename: file.name, sizeBytes: file.size, ...(file.type ? { mimeType: file.type } : {}), language, formats, idempotencyKey: options.idempotencyKey, signal: options.signal });
    uploadId = created.uploadId;
    options.onSession?.(uploadId);
    status = await api.getUpload(uploadId, options.signal);
  }
  if (status.status === 'expired' || status.status === 'aborted') throw new Error(status.error?.message ?? '재개할 수 없는 업로드입니다.');
  if (status.status === 'uploading') {
    const received = new Set(status.receivedParts);
    const pending = Array.from({ length: status.totalChunks }, (_, index) => index).filter((index) => !received.has(index));
    let bytesDone = completedBytes(status, file.size);
    options.onProgress?.(bytesDone, file.size, 'uploading');
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const index = pending[cursor++]!;
        const start = index * status.chunkSizeBytes;
        const chunk = file.slice(start, Math.min(file.size, start + status.chunkSizeBytes));
        await uploadPartWithRetry(api, uploadId!, index, chunk, options.signal, wait, random);
        bytesDone += chunk.size;
        options.onProgress?.(bytesDone, file.size, 'uploading');
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, pending.length) }, worker));
    const completing = await api.completeUpload(uploadId, options.signal);
    if (completing.status === 'completed' && completing.jobId) status = await api.getUpload(uploadId, options.signal);
  }
  options.onProgress?.(status.assembledBytes, file.size, 'finalizing');
  while (status.status !== 'completed') {
    await wait(1_000, options.signal);
    status = await api.getUpload(uploadId, options.signal);
    options.onProgress?.(status.status === 'completed' ? file.size : status.assembledBytes, file.size, 'finalizing');
    if (status.status === 'expired' || status.status === 'aborted') throw new Error(status.error?.message ?? '업로드 조립에 실패했습니다.');
  }
  if (!status.jobId) throw new Error('완료된 업로드에 작업 ID가 없습니다.');
  const job = await api.getJob(status.jobId, options.signal);
  return {
    id: job.id, origin: job.origin, status: job.status, phase: job.phase, createdAt: job.createdAt, queuePosition: job.queuePosition,
    links: { self: `/api/v1/jobs/${job.id}`, results: `/api/v1/jobs/${job.id}/results` },
  };
}
