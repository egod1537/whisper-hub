import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type WhisperApi } from '../api/client';
import { JobsList } from '../components/JobsList';
import { TranscriptPanel } from '../components/TranscriptPanel';
import type { JobDetail, JobStatus, JobSummary } from '../api/types';

function summary(status: JobStatus, id: string = status): JobSummary {
  return {
    id, origin: 'web', status, phase: status === 'processing' ? 'transcribing' : null,
    createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z', originalFilename: `${id}.wav`,
    attempts: status === 'failed' ? 1 : 0, queuePosition: status === 'queued' ? 1 : null,
    error: status === 'failed' ? { code: 'PROVIDER_UNAVAILABLE', message: '제공자를 사용할 수 없습니다.' } : null,
  };
}

function completeJob(): JobDetail {
  return {
    ...summary('completed', 'complete'), startedAt: '2026-10-28T10:00:01Z', completedAt: '2026-10-28T10:00:10Z',
    fileSizeBytes: 100, durationSeconds: 9, language: 'ko', formats: ['txt', 'srt'],
  };
}

function resultApi(text: string): WhisperApi {
  return {
    getResults: vi.fn().mockResolvedValue({ jobId: 'complete', availableFormats: ['txt', 'srt'] }),
    fetchResultText: vi.fn().mockResolvedValue(text),
    downloadResult: vi.fn().mockResolvedValue({ blob: new Blob(['x']), filename: 'complete.txt' }),
    listJobs: vi.fn(), getJob: vi.fn(), getSystemStatus: vi.fn(), createJob: vi.fn(), createYoutubeJob: vi.fn(), createUpload: vi.fn(), getUpload: vi.fn(),
    putUploadPart: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn(), cancelJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), retryJob: vi.fn(),
  };
}

describe('job actions and results', () => {
  it('filters by origin and exposes only legal pause, resume, cancel, retry, and result actions', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(true);
    const onPause = vi.fn().mockResolvedValue(true);
    const onResume = vi.fn().mockResolvedValue(true);
    const onRetry = vi.fn().mockResolvedValue(true);
    const onOriginFilter = vi.fn();
    render(<JobsList
      jobs={[summary('queued'), summary('processing'), summary('pausing'), summary('paused'), summary('completed'), summary('failed'), summary('canceled')]}
      selectedId={null} selectedJob={null} originFilter="web"
      systemStatus={{ provider: { reachable: true, model: 'base' }, jobs: { queued: 1, processing: 2, paused: 1, origins: { web: 5, api: 2, unknown: 0 } }, worker: { fresh: true, lastHeartbeatAt: null }, uploads: { active: 0, stagedBytes: 0, finalizing: 0 } }}
      loading={false} stale={false} error={null} nextCursor={null} pendingActionIds={new Set()}
      onOriginFilter={onOriginFilter} onSelect={vi.fn()} onRefresh={vi.fn()} onLoadMore={vi.fn()}
      onCancel={onCancel} onPause={onPause} onResume={onResume} onRetry={onRetry}
    />);

    expect(screen.getAllByRole('button', { name: /일시 중지$/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /취소$/ })).toHaveLength(4);
    expect(screen.getByRole('button', { name: /재개$/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /재시도$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /결과 열기$/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /API에서 등록/ }));
    expect(onOriginFilter).toHaveBeenCalledWith('api');
    await user.click(screen.getAllByRole('button', { name: /일시 중지$/ })[0]!);
    expect(onPause).toHaveBeenCalledWith('queued');
    await user.click(screen.getAllByRole('button', { name: /취소$/ })[0]!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '영구 취소' }));
    expect(onCancel).toHaveBeenCalledWith('queued');
    await user.click(screen.getByRole('button', { name: /재개$/ }));
    expect(onResume).toHaveBeenCalledWith('paused');
    await user.click(screen.getByRole('button', { name: /재시도$/ }));
    expect(onRetry).toHaveBeenCalledWith('failed');
  });

  it('renders transcript as escaped text and truncates a giant preview', async () => {
    const transcript = '<script>window.bad=true</script>' + '가'.repeat(100_100);
    const { container } = render(<TranscriptPanel api={resultApi(transcript)} job={completeJob()} />);

    await waitFor(() => expect(container.querySelector('.transcript-preview')).toBeInTheDocument());
    const preview = container.querySelector('.transcript-preview');
    expect(preview?.textContent).toHaveLength(100_000);
    expect(preview?.textContent).toContain('<script>window.bad=true</script>');
    expect(preview?.querySelector('script')).toBeNull();
    expect(screen.getByText(/처음 100,000자만 표시/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TXT 다운로드' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SRT 다운로드' })).toBeInTheDocument();
  });

  it('disables mutations while the selected job action is pending', () => {
    render(<JobsList
      jobs={[summary('queued')]} selectedId={null} selectedJob={null} originFilter="web" systemStatus={null}
      loading={false} stale={false} error={null} nextCursor={null} pendingActionIds={new Set(['queued'])}
      onOriginFilter={vi.fn()} onSelect={vi.fn()} onRefresh={vi.fn()} onLoadMore={vi.fn()}
      onCancel={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onRetry={vi.fn()}
    />);
    expect(screen.getByRole('button', { name: /일시 중지$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /취소$/ })).toBeDisabled();
  });

  it('does not request a TXT preview when TXT was not produced', async () => {
    const api = resultApi('unused');
    vi.mocked(api.getResults).mockResolvedValue({ jobId: 'complete', availableFormats: ['srt'] });
    render(<TranscriptPanel api={api} job={completeJob()} />);

    expect(await screen.findByText('미리보기 없음')).toBeInTheDocument();
    expect(api.fetchResultText).not.toHaveBeenCalled();
  });

  it('shows an expired result without a misleading preview state', async () => {
    const api = resultApi('unused');
    vi.mocked(api.getResults).mockRejectedValue(new ApiError(404, 'NOT_FOUND', '작업 또는 결과를 찾을 수 없습니다. 보존 기간이 지났을 수 있습니다.'));
    render(<TranscriptPanel api={api} job={completeJob()} />);

    expect(await screen.findByText(/보존 기간이 지났을 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByText('미리보기 없음')).not.toBeInTheDocument();
  });
});
