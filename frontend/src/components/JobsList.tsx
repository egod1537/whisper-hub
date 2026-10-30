import {
  Alert, Button, ButtonGroup, Callout, Card, NonIdealState, OverlayToaster, Position, ProgressBar, Spinner, Tag, type Toaster,
} from '@blueprintjs/core';
import { useState } from 'react';
import type { JobDetail, JobOrigin, JobPhase, JobProgress, JobStatus, JobSummary, SystemStatus } from '../api/types';

const statusLabels: Record<JobStatus, string> = {
  queued: '대기 중', processing: '처리 중', pausing: '일시 중지 중', paused: '일시 중지됨',
  completed: '완료', failed: '실패', canceled: '취소됨',
};

const phaseLabels: Record<JobPhase, string> = {
  fetching: 'YouTube 영상 내려받는 중',
  validating: '미디어 파일 확인 중',
  converting: '음성을 전사용 형식으로 변환 중',
  transcribing: 'Whisper로 음성을 전사하는 중',
  exporting: 'GPT 교정 및 결과 파일 생성 중',
};

const statusIntent: Record<JobStatus, 'none' | 'primary' | 'success' | 'danger' | 'warning'> = {
  queued: 'warning', processing: 'primary', pausing: 'warning', paused: 'warning',
  completed: 'success', failed: 'danger', canceled: 'none',
};

const originLabels: Record<JobOrigin, string> = { web: '웹', api: 'API', unknown: '출처 불명' };
let toasterPromise: Promise<Toaster> | null = null;

function notify(message: string, intent: 'success' | 'danger' = 'success'): void {
  if (typeof document === 'undefined') return;
  toasterPromise ??= OverlayToaster.create({ position: Position.TOP });
  void toasterPromise.then((toaster) => toaster.show({ message, intent, timeout: 3_000 }));
}

function createdTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function languageLabel(value: string): string {
  return { auto: '자동', ko: '한국어', ja: '일본어', en: '영어' }[value] ?? value;
}

function progressLabel(progress: JobProgress): string {
  const percent = Number.isInteger(progress.percent) ? progress.percent.toFixed(0) : progress.percent.toFixed(1);
  if (progress.unit === 'bytes') {
    const format = (bytes: number) => bytes < 1_048_576 ? `${(bytes / 1_024).toFixed(1)} KiB` : `${(bytes / 1_048_576).toFixed(1)} MiB`;
    return `${percent}% · ${format(progress.current)} / ${format(progress.total)}`;
  }
  const format = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  return `${percent}% · ${format(progress.current)} / ${format(progress.total)}`;
}

interface JobProgressView {
  percent: number | null;
  estimated: boolean;
  task: string;
  detail: string | null;
  running: boolean;
}

const phaseProgress: Record<JobPhase, { start: number; end: number }> = {
  fetching: { start: 5, end: 20 },
  validating: { start: 25, end: 25 },
  converting: { start: 30, end: 45 },
  transcribing: { start: 55, end: 55 },
  exporting: { start: 90, end: 90 },
};

function activeProgress(job: JobSummary): number {
  if (!job.phase) return 1;
  const range = phaseProgress[job.phase];
  const measured = job.progress ? Math.min(100, Math.max(0, job.progress.percent)) / 100 : 0;
  return Math.round(range.start + ((range.end - range.start) * measured));
}

export function jobProgressView(job: JobSummary): JobProgressView {
  if (job.status === 'completed') {
    return { percent: 100, estimated: false, task: '전사와 결과 생성이 완료되었습니다.', detail: null, running: false };
  }
  if (job.status === 'queued') {
    const position = job.queuePosition === null ? '' : ` · 대기 순번 ${job.queuePosition}`;
    return { percent: 0, estimated: false, task: `작업 시작을 기다리는 중${position}`, detail: null, running: false };
  }
  if (job.status === 'paused') {
    return { percent: 0, estimated: false, task: '일시 중지됨 · 재개하면 처음부터 다시 처리합니다.', detail: null, running: false };
  }
  if (job.status === 'failed') {
    return { percent: null, estimated: false, task: '오류로 작업이 중단되었습니다.', detail: null, running: false };
  }
  if (job.status === 'canceled') {
    return { percent: null, estimated: false, task: '사용자가 작업을 취소했습니다.', detail: null, running: false };
  }

  const currentTask = job.phase ? phaseLabels[job.phase] : '작업 환경 준비 중';
  return {
    percent: activeProgress(job),
    estimated: true,
    task: job.status === 'pausing' ? `안전하게 일시 중지하는 중 · ${currentTask}` : currentTask,
    detail: job.progress ? progressLabel(job.progress) : null,
    running: true,
  };
}

export type OriginFilter = JobOrigin | 'all';

export interface JobsListProps {
  jobs: JobSummary[];
  selectedId: string | null;
  selectedJob: JobDetail | null;
  systemStatus: SystemStatus | null;
  originFilter: OriginFilter;
  loading: boolean;
  stale: boolean;
  error: string | null;
  nextCursor: string | null;
  pendingActionIds: ReadonlySet<string>;
  disabled?: boolean;
  onOriginFilter(filter: OriginFilter): void;
  onSelect(id: string): void;
  onRefresh(): void;
  onLoadMore(): Promise<void>;
  onCancel(id: string): Promise<boolean>;
  onPause(id: string): Promise<boolean>;
  onResume(id: string): Promise<boolean>;
  onRetry(id: string): Promise<boolean>;
}

export function JobsList(props: JobsListProps) {
  const [cancelTarget, setCancelTarget] = useState<JobSummary | null>(null);

  const act = async (action: 'pause' | 'resume' | 'retry', job: JobSummary) => {
    const success = action === 'pause' ? await props.onPause(job.id)
      : action === 'resume' ? await props.onResume(job.id)
        : await props.onRetry(job.id);
    if (success) notify(action === 'pause' ? '일시 중지를 요청했습니다.' : action === 'resume' ? '작업을 대기열에 다시 넣었습니다.' : '재시도를 요청했습니다.');
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    const success = await props.onCancel(cancelTarget.id);
    if (success) {
      notify(cancelTarget.status === 'processing' || cancelTarget.status === 'pausing' ? '작업 취소를 요청했습니다.' : '작업을 취소했습니다.');
      setCancelTarget(null);
    } else {
      notify('작업을 취소하지 못했습니다.', 'danger');
    }
  };

  const originCount = (origin: JobOrigin) => props.systemStatus?.jobs.origins[origin] ?? 0;

  return (
    <Card className="panel jobs-panel" elevation={0}>
      <div className="panel-heading">
        <div>
          <h2>작업 대기열</h2>
          {props.systemStatus && (
            <p className="counts" aria-label="현재 작업 수">
              대기 {props.systemStatus.jobs.queued} · 처리 {props.systemStatus.jobs.processing} · 일시 중지 {props.systemStatus.jobs.paused}
            </p>
          )}
        </div>
        <Button minimal icon="refresh" text="새로고침" disabled={props.disabled || props.loading} onClick={props.onRefresh} />
      </div>

      <ButtonGroup fill className="origin-filter" aria-label="작업 출처 필터">
        <Button active={props.originFilter === 'web'} text={`웹에서 등록 ${originCount('web')}`} onClick={() => props.onOriginFilter('web')} />
        <Button active={props.originFilter === 'api'} text={`API에서 등록 ${originCount('api')}`} onClick={() => props.onOriginFilter('api')} />
        <Button active={props.originFilter === 'all'} text="전체" onClick={() => props.onOriginFilter('all')} />
        <Button active={props.originFilter === 'unknown'} text={`출처 불명 ${originCount('unknown')}`} onClick={() => props.onOriginFilter('unknown')} />
      </ButtonGroup>
      <p className="queue-note">출처와 관계없이 하나의 FIFO 대기열에서 순서대로 처리됩니다.</p>

      {props.stale && <Callout compact intent="warning" className="inline-message">연결이 끊겨 이전 목록을 표시합니다. 자동으로 다시 연결합니다.</Callout>}
      {props.error && <Callout compact intent="danger" className="inline-message">{props.error}</Callout>}

      {props.loading && props.jobs.length === 0 ? (
        <div className="centered-loading" role="status"><Spinner size={24} /> 작업을 불러오는 중</div>
      ) : props.jobs.length === 0 ? (
        <NonIdealState title="이 출처에 등록된 작업이 없습니다" description="다른 출처 탭을 선택하거나 새 작업을 등록하세요." />
      ) : (
        <ul className="jobs-list" aria-label="전사 작업 목록">
          {props.jobs.map((job) => {
            const pending = props.pendingActionIds.has(job.id);
            const detail = props.selectedJob?.id === job.id ? props.selectedJob : null;
            const progress = jobProgressView(job);
            return (
              <li key={job.id} className={props.selectedId === job.id ? 'job-row selected' : 'job-row'}>
                <button type="button" className="job-main" onClick={() => props.onSelect(job.id)} aria-pressed={props.selectedId === job.id}>
                  <span className="job-title" title={job.originalFilename}>{job.originalFilename}</span>
                  <span className="job-meta">
                    <Tag minimal>{originLabels[job.origin]}</Tag>
                    <Tag minimal intent={statusIntent[job.status]}>{statusLabels[job.status]}</Tag>
                    {(job.status === 'processing' || job.status === 'pausing') && <Spinner size={14} />}
                    {detail && <span>{languageLabel(detail.language)}</span>}
                    <span>{createdTime(job.createdAt)}</span>
                    {job.queuePosition !== null && <span>대기 #{job.queuePosition}</span>}
                  </span>
                  {progress.percent !== null ? (
                    <span
                      className="job-progress"
                      aria-label={`${progress.task} ${progress.estimated ? '단계 기준 ' : ''}진행률 ${progress.percent}%`}
                    >
                      <span className="job-progress-copy">
                        <strong>{progress.estimated ? `단계 기준 ${progress.percent}%` : `${progress.percent}%`}</strong>
                        <span>{progress.task}</span>
                      </span>
                      <ProgressBar
                        value={progress.percent / 100}
                        intent={job.status === 'completed' ? 'success' : 'primary'}
                        animate={progress.running && !job.progress}
                        stripes={progress.running && !job.progress}
                      />
                      {progress.detail && <span className="job-progress-detail">현재 단계 {progress.detail}</span>}
                    </span>
                  ) : (
                    <span className="job-progress-state">{progress.task}</span>
                  )}
                  {job.error && <span className="job-error">{job.error.message}</span>}
                </button>
                <div className="job-actions">
                  {(job.status === 'queued' || job.status === 'processing') && (
                    <Button small minimal icon="pause" text="일시 중지" aria-label={`${job.originalFilename} 일시 중지`} loading={pending} disabled={pending || props.disabled} onClick={() => { void act('pause', job); }} />
                  )}
                  {job.status === 'paused' && (
                    <Button small minimal icon="play" text="재개" aria-label={`${job.originalFilename} 재개`} loading={pending} disabled={pending || props.disabled} onClick={() => { void act('resume', job); }} />
                  )}
                  {['queued', 'processing', 'pausing', 'paused'].includes(job.status) && (
                    <Button small minimal intent="danger" text="취소" aria-label={`${job.originalFilename} 취소`} disabled={pending || props.disabled} onClick={() => setCancelTarget(job)} />
                  )}
                  {job.status === 'completed' && (
                    <Button small minimal icon="document-open" text="결과 열기" aria-label={`${job.originalFilename} 결과 열기`} onClick={() => props.onSelect(job.id)} />
                  )}
                  {job.status === 'failed' && (
                    <Button small minimal icon="repeat" text="재시도" aria-label={`${job.originalFilename} 재시도`} loading={pending} disabled={pending || props.disabled} onClick={() => { void act('retry', job); }} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {props.nextCursor && (
        <Button minimal fill text="더 보기" disabled={props.disabled} onClick={() => { void props.onLoadMore(); }} />
      )}

      <Alert
        isOpen={cancelTarget !== null}
        cancelButtonText="돌아가기"
        confirmButtonText="영구 취소"
        icon="trash"
        intent="danger"
        loading={cancelTarget ? props.pendingActionIds.has(cancelTarget.id) : false}
        canEscapeKeyCancel={!cancelTarget || !props.pendingActionIds.has(cancelTarget.id)}
        canOutsideClickCancel={!cancelTarget || !props.pendingActionIds.has(cancelTarget.id)}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => { void confirmCancel(); }}
      >
        <p><strong>{cancelTarget?.originalFilename}</strong> 작업을 취소할까요?</p>
        <p>취소한 작업은 재개할 수 없습니다. 처리 중이면 안전하게 중단될 때까지 잠시 걸릴 수 있습니다.</p>
      </Alert>
    </Card>
  );
}
