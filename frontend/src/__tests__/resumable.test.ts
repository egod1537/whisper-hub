import { describe, expect, it, vi } from 'vitest';
import { ApiError, type WhisperApi } from '../api/client';
import { uploadResumably } from '../api/resumable';

function status(receivedParts: number[] = []) {
  return { uploadId: 'u-1', status: 'uploading' as const, sizeBytes: 10, chunkSizeBytes: 2, totalChunks: 5, receivedParts, receivedBytes: receivedParts.length * 2, assembledBytes: 0, expiresAt: '2026-10-29T00:00:00Z', jobId: null, error: null };
}

function apiForUpload(putUploadPart: WhisperApi['putUploadPart'], receivedParts: number[] = []): WhisperApi {
  return {
    createUpload: vi.fn().mockResolvedValue({ uploadId: 'u-1', chunkSizeBytes: 2, totalChunks: 5, expiresAt: '2026-10-29T00:00:00Z', status: 'uploading' }),
    getUpload: vi.fn().mockResolvedValueOnce(status(receivedParts)).mockResolvedValue({ ...status([0, 1, 2, 3, 4]), status: 'completed', assembledBytes: 10, jobId: 'job-1' }),
    putUploadPart, completeUpload: vi.fn().mockResolvedValue({ uploadId: 'u-1', status: 'completed', jobId: 'job-1', jobUrl: '/api/v1/jobs/job-1' }),
    getJob: vi.fn().mockResolvedValue({ id: 'job-1', origin: 'web', status: 'queued', phase: null, progress: null, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', originalFilename: 'x.wav', attempts: 0, queuePosition: 1, error: null, startedAt: null, completedAt: null, fileSizeBytes: 10, durationSeconds: null, language: 'auto', formats: ['txt'] }),
    abortUpload: vi.fn(), createJob: vi.fn(), createYoutubeJob: vi.fn(), listJobs: vi.fn(), getSystemStatus: vi.fn(), cancelJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), retryJob: vi.fn(),
    getResults: vi.fn(), fetchResultText: vi.fn(), downloadResult: vi.fn(),
  };
}

describe('resumable uploader', () => {
  it('limits chunk uploads to three concurrent requests and reports completed bytes', async () => {
    let active = 0; let peak = 0;
    const resolvers: Array<() => void> = [];
    const put = vi.fn<WhisperApi['putUploadPart']>(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
    });
    const api = apiForUpload(put);
    const progress = vi.fn();
    const promise = uploadResumably(api, new File(['0123456789'], 'x.wav'), 'auto', ['txt'], { idempotencyKey: 'key', onProgress: progress, wait: vi.fn().mockResolvedValue(undefined) });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(5));
    resolvers.splice(0).forEach((resolve) => resolve());
    await promise;
    expect(peak).toBe(3);
    expect(progress).toHaveBeenCalledWith(10, 10, 'uploading');
    expect(progress).toHaveBeenCalledWith(10, 10, 'finalizing');
  });

  it('polls and reports server-side assembly bytes after upload completes', async () => {
    const api = apiForUpload(vi.fn<WhisperApi['putUploadPart']>().mockResolvedValue(undefined), [0, 1, 2, 3, 4]);
    vi.mocked(api.completeUpload).mockResolvedValue({ uploadId: 'u-1', status: 'finalizing', jobId: null, jobUrl: null });
    vi.mocked(api.getUpload)
      .mockReset()
      .mockResolvedValueOnce(status([0, 1, 2, 3, 4]))
      .mockResolvedValueOnce({ ...status([0, 1, 2, 3, 4]), status: 'finalizing', assembledBytes: 4 })
      .mockResolvedValueOnce({ ...status([0, 1, 2, 3, 4]), status: 'completed', assembledBytes: 10, jobId: 'job-1' });
    const progress = vi.fn();

    await uploadResumably(api, new File(['0123456789'], 'x.wav'), 'auto', ['txt'], {
      existingUploadId: 'u-1', idempotencyKey: 'unused', onProgress: progress, wait: vi.fn().mockResolvedValue(undefined),
    });

    expect(progress).toHaveBeenCalledWith(0, 10, 'finalizing');
    expect(progress).toHaveBeenCalledWith(4, 10, 'finalizing');
    expect(progress).toHaveBeenCalledWith(10, 10, 'finalizing');
  });

  it('skips server-authoritative received parts when resuming', async () => {
    const put = vi.fn<WhisperApi['putUploadPart']>().mockResolvedValue(undefined);
    const api = apiForUpload(put, [0, 2]);
    await uploadResumably(api, new File(['0123456789'], 'x.wav'), 'auto', ['txt'], { existingUploadId: 'u-1', idempotencyKey: 'unused', wait: vi.fn().mockResolvedValue(undefined) });
    expect(put.mock.calls.map((call) => call[1]).sort()).toEqual([1, 3, 4]);
    expect(api.createUpload).not.toHaveBeenCalled();
  });

  it('retries only retryable failures at most three times', async () => {
    const put = vi.fn<WhisperApi['putUploadPart']>()
      .mockRejectedValueOnce(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'retry'))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValue(undefined);
    const api = apiForUpload(put, [1, 2, 3, 4]);
    const wait = vi.fn().mockResolvedValue(undefined);
    await uploadResumably(api, new File(['0123456789'], 'x.wav'), 'auto', ['txt'], { existingUploadId: 'u-1', idempotencyKey: 'unused', wait, random: () => 0 });
    expect(put).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 300, undefined);
    expect(wait).toHaveBeenNthCalledWith(2, 600, undefined);
  });
});
