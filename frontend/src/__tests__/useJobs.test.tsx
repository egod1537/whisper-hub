import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type WhisperApi } from '../api/client';
import type { JobStatus, JobSummary } from '../api/types';
import { pollDelayForFailure, useJobs } from '../hooks/useJobs';

function job(status: JobStatus, updatedAt: string): JobSummary {
  return {
    id: 'job-1', origin: 'web', status, phase: status === 'processing' ? 'transcribing' : null, progress: null,
    createdAt: '2026-10-28T10:00:00Z', updatedAt, originalFilename: 'speech.wav', attempts: 1,
    queuePosition: status === 'queued' ? 1 : null, error: status === 'failed' ? { code: 'FAILED', message: '실패' } : null,
  };
}

function pollingApi(pages: JobSummary[][]): WhisperApi {
  const listJobs = vi.fn<WhisperApi['listJobs']>();
  for (const items of pages) listJobs.mockResolvedValueOnce({ items, nextCursor: null });
  return {
    listJobs,
    getSystemStatus: vi.fn().mockResolvedValue({ provider: { reachable: true, model: 'base' }, jobs: { queued: 0, processing: 0, paused: 0, origins: { web: 0, api: 0, unknown: 0 } }, worker: { fresh: true, lastHeartbeatAt: null }, uploads: { active: 0, stagedBytes: 0, finalizing: 0 } }),
    getJob: vi.fn().mockResolvedValue({ ...job('completed', '3'), startedAt: null, completedAt: null, fileSizeBytes: 1, durationSeconds: null, language: 'ko', formats: ['txt'] }),
    createJob: vi.fn(), createYoutubeJob: vi.fn(), createUpload: vi.fn(), getUpload: vi.fn(), putUploadPart: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn(),
    cancelJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), retryJob: vi.fn(), getResults: vi.fn(), fetchResultText: vi.fn(), downloadResult: vi.fn(),
  };
}

describe('useJobs polling', () => {
  afterEach(() => vi.useRealTimers());

  it('uses bounded exponential backoff', () => {
    expect([1, 2, 3, 4, 5].map(pollDelayForFailure)).toEqual([2_500, 5_000, 10_000, 20_000, 20_000]);
  });

  it('polls active jobs through queued, processing, and completed then stops', async () => {
    vi.useFakeTimers();
    const api = pollingApi([[job('queued', '1')], [job('processing', '2')], [job('completed', '3')]]);
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useJobs(api, onUnauthorized));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.jobs[0]?.status).toBe('queued');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(result.current.jobs[0]?.status).toBe('processing');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(result.current.jobs[0]?.status).toBe('completed');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.listJobs).toHaveBeenCalledTimes(3);
  });

  it('stops and requests a new key after 401', async () => {
    const onUnauthorized = vi.fn();
    const api = pollingApi([]);
    vi.mocked(api.listJobs).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'API 키가 올바르지 않습니다.'));
    renderHook(() => useJobs(api, onUnauthorized));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('keeps backend order when loading another cursor page', async () => {
    const api = pollingApi([]);
    vi.mocked(api.listJobs)
      .mockResolvedValueOnce({ items: [job('completed', 'new')], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [{ ...job('completed', 'old'), id: 'job-2' }], nextCursor: null });
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useJobs(api, onUnauthorized));
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.jobs.map((item) => item.id)).toEqual(['job-1', 'job-2']);
  });

  it('passes the selected origin to polling and pagination', async () => {
    const api = pollingApi([]);
    vi.mocked(api.listJobs)
      .mockResolvedValueOnce({ items: [job('completed', 'new')], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [{ ...job('completed', 'old'), id: 'job-2' }], nextCursor: null });
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useJobs(api, onUnauthorized, 'api'));
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(api.listJobs).toHaveBeenNthCalledWith(1, expect.objectContaining({ origin: 'api' }));
    await act(async () => { await result.current.loadMore(); });
    expect(api.listJobs).toHaveBeenNthCalledWith(2, expect.objectContaining({ origin: 'api', cursor: 'next-page' }));
  });

  it('reconciles pause, resume, cancel, and retry actions with the server response', async () => {
    const queued = job('queued', '1');
    const failed = { ...job('failed', '1'), id: 'job-2' };
    const api = pollingApi([[queued, failed]]);
    vi.mocked(api.cancelJob).mockResolvedValue({ ...queued, status: 'canceled', queuePosition: null });
    vi.mocked(api.pauseJob).mockResolvedValue({ ...queued, status: 'paused', queuePosition: null });
    vi.mocked(api.resumeJob).mockResolvedValue({ ...queued, status: 'queued', queuePosition: 2 });
    vi.mocked(api.retryJob).mockResolvedValue({ ...failed, status: 'queued', error: null, queuePosition: 1 });
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useJobs(api, onUnauthorized));
    await waitFor(() => expect(result.current.jobs).toHaveLength(2));

    await act(async () => { await result.current.pauseJob('job-1'); });
    expect(result.current.jobs.find((item) => item.id === 'job-1')?.status).toBe('paused');
    await act(async () => { await result.current.resumeJob('job-1'); });
    expect(result.current.jobs.find((item) => item.id === 'job-1')?.status).toBe('queued');
    await act(async () => { await result.current.cancelJob('job-1'); });
    expect(result.current.jobs.find((item) => item.id === 'job-1')?.status).toBe('canceled');
    await act(async () => { await result.current.retryJob('job-2'); });
    expect(result.current.jobs.find((item) => item.id === 'job-2')?.status).toBe('queued');
  });
});
