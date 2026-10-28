import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhisperApi } from '../api/client';
import { UploadPanel } from '../components/UploadPanel';

const detail = {
  id: 'job-1', origin: 'web' as const, status: 'queued' as const, phase: null, progress: null, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z',
  originalFilename: 'speech.wav', attempts: 0, queuePosition: 1, error: null, startedAt: null, completedAt: null,
  fileSizeBytes: 5, durationSeconds: null, language: 'auto', formats: ['txt' as const],
};

function resumableApi(overrides: Partial<WhisperApi> = {}): WhisperApi {
  const uploadStatus = { uploadId: 'upload-1', status: 'uploading' as const, sizeBytes: 5, chunkSizeBytes: 5, totalChunks: 1, receivedParts: [], receivedBytes: 0, assembledBytes: 0, expiresAt: '2026-10-29T10:00:00Z', jobId: null, error: null };
  return {
    createUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', chunkSizeBytes: 5, totalChunks: 1, expiresAt: uploadStatus.expiresAt, status: 'uploading' }),
    getUpload: vi.fn().mockResolvedValueOnce(uploadStatus).mockResolvedValue({ ...uploadStatus, status: 'completed', receivedParts: [0], receivedBytes: 5, assembledBytes: 5, jobId: 'job-1' }),
    putUploadPart: vi.fn().mockResolvedValue(undefined), completeUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', status: 'completed', jobId: 'job-1', jobUrl: '/api/v1/jobs/job-1' }),
    abortUpload: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(detail), createJob: vi.fn(), createYoutubeJob: vi.fn(), listJobs: vi.fn(),
    getSystemStatus: vi.fn(), cancelJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), retryJob: vi.fn(), getResults: vi.fn(), fetchResultText: vi.fn(), downloadResult: vi.fn(),
    ...overrides,
  };
}

describe('UploadPanel', () => {
  beforeEach(() => localStorage.clear());

  it('has labeled controls and requires a file and one format', async () => {
    const user = userEvent.setup();
    render(<UploadPanel api={resumableApi()} onCreated={vi.fn()} />);
    const submit = screen.getByRole('button', { name: '전사 시작' });
    expect(screen.getByLabelText('오디오 또는 비디오 파일')).toBeInTheDocument();
    expect(screen.getByLabelText('언어')).toBeInTheDocument();
    expect(screen.getByLabelText('TXT')).toBeChecked();
    expect(submit).toBeDisabled();
    await user.upload(screen.getByLabelText('오디오 또는 비디오 파일'), new File(['audio'], 'speech.wav', { type: 'audio/wav' }));
    expect(submit).toBeEnabled();
    await user.click(screen.getByLabelText('TXT'));
    expect(submit).toBeDisabled();
  });

  it('uses resumable upload and clears non-secret resume metadata after queueing', async () => {
    const user = userEvent.setup();
    const api = resumableApi();
    const onCreated = vi.fn();
    render(<UploadPanel api={api} onCreated={onCreated} />);
    await user.upload(screen.getByLabelText('오디오 또는 비디오 파일'), new File(['audio'], 'speech.wav', { type: 'audio/wav' }));
    await user.click(screen.getByRole('button', { name: '전사 시작' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(api.createUpload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'speech.wav', language: 'auto', formats: ['txt'] }));
    expect(api.putUploadPart).toHaveBeenCalledOnce();
    expect(screen.getByText('작업이 대기열에 등록되었습니다.')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it('queues a YouTube link with the selected options', async () => {
    const user = userEvent.setup();
    const api = resumableApi({ createYoutubeJob: vi.fn().mockResolvedValue({
      id: 'youtube-job', origin: 'web', status: 'queued', phase: null, createdAt: '2026-10-28T10:00:00Z', queuePosition: 1,
      links: { self: '/api/v1/jobs/youtube-job', results: '/api/v1/jobs/youtube-job/results' },
    }) });
    const onCreated = vi.fn();
    render(<UploadPanel api={api} onCreated={onCreated} />);
    await user.click(screen.getByRole('button', { name: 'YouTube 링크' }));
    await user.type(screen.getByLabelText('YouTube 영상 링크'), 'https://youtu.be/abc123xyz00');
    await user.selectOptions(screen.getByLabelText('언어'), 'ko');
    await user.click(screen.getByRole('button', { name: '전사 시작' }));

    await waitFor(() => expect(api.createYoutubeJob).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://youtu.be/abc123xyz00', language: 'ko', formats: ['txt'],
    })));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'youtube-job' }), 'YouTube 영상');
    expect(screen.getByText('작업이 대기열에 등록되었습니다.')).toBeInTheDocument();
  });

  it('prevents a double submit while a chunk is pending', async () => {
    const user = userEvent.setup();
    let resolvePart: (() => void) | undefined;
    const api = resumableApi({ putUploadPart: vi.fn(() => new Promise<void>((resolve) => { resolvePart = resolve; })) });
    render(<UploadPanel api={api} onCreated={vi.fn()} />);
    await user.upload(screen.getByLabelText('오디오 또는 비디오 파일'), new File(['audio'], 'speech.wav', { type: 'audio/wav' }));
    await user.dblClick(screen.getByRole('button', { name: '전사 시작' }));
    await waitFor(() => expect(api.putUploadPart).toHaveBeenCalledOnce());
    expect(api.createUpload).toHaveBeenCalledOnce();
    resolvePart?.();
    await screen.findByText('작업이 대기열에 등록되었습니다.');
  });

  it('offers persisted upload metadata without storing an API key', () => {
    localStorage.setItem('whisper-hub-resumable-upload-v1', JSON.stringify({ uploadId: 'u-1', filename: 'large.mp4', sizeBytes: 500, lastModified: 1, language: 'ko', formats: ['txt'] }));
    render(<UploadPanel api={resumableApi()} onCreated={vi.fn()} />);
    expect(screen.getByText(/large.mp4.*업로드를 재개/)).toBeInTheDocument();
    expect(localStorage.getItem('apiKey')).toBeNull();
  });
});
