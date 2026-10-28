import { Button, Callout, Card, NonIdealState, Spinner, Tag } from '@blueprintjs/core';
import type { JobDetail, JobPhase, JobStatus, JobSummary, SystemStatus } from '../api/types';

const statusLabels: Record<JobStatus, string> = {
  queued: '대기 중',
  processing: '처리 중',
  completed: '완료',
  failed: '실패',
  canceled: '취소됨',
};

const phaseLabels: Record<JobPhase, string> = {
  validating: '파일 확인',
  converting: '음성 변환',
  transcribing: '전사',
  exporting: '결과 생성',
};

const statusIntent: Record<JobStatus, 'none' | 'primary' | 'success' | 'danger' | 'warning'> = {
  queued: 'warning',
  processing: 'primary',
  completed: 'success',
  failed: 'danger',
  canceled: 'none',
};

function createdTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function languageLabel(value: string): string {
  return { auto: '자동', ko: '한국어', ja: '일본어', en: '영어' }[value] ?? value;
}

export interface JobsListProps {
  jobs: JobSummary[];
  selectedId: string | null;
  selectedJob: JobDetail | null;
  systemStatus: SystemStatus | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  nextCursor: string | null;
  pendingActionIds: ReadonlySet<string>;
  disabled?: boolean;
  onSelect(id: string): void;
  onRefresh(): void;
  onLoadMore(): Promise<void>;
  onCancel(id: string): Promise<void>;
  onRetry(id: string): Promise<void>;
}

export function JobsList(props: JobsListProps) {
  const cancel = (job: JobSummary) => {
    if (job.status === 'processing' && !window.confirm('처리 중인 작업을 취소할까요? 중단까지 시간이 걸릴 수 있습니다.')) return;
    void props.onCancel(job.id);
  };

  return (
    <Card className="panel jobs-panel" elevation={0}>
      <div className="panel-heading">
        <div>
          <h2>작업 대기열</h2>
          {props.systemStatus && (
            <p className="counts" aria-label="현재 작업 수">
              대기 {props.systemStatus.jobs.queued} · 처리 {props.systemStatus.jobs.processing} · 업로드 {props.systemStatus.uploads.active}
            </p>
          )}
        </div>
        <Button minimal icon="refresh" text="새로고침" disabled={props.disabled || props.loading} onClick={props.onRefresh} />
      </div>

      {props.stale && <Callout compact intent="warning" className="inline-message">연결이 끊겨 이전 목록을 표시합니다. 자동으로 다시 연결합니다.</Callout>}
      {props.error && <Callout compact intent="danger" className="inline-message">{props.error}</Callout>}

      {props.loading && props.jobs.length === 0 ? (
        <div className="centered-loading" role="status"><Spinner size={24} /> 작업을 불러오는 중</div>
      ) : props.jobs.length === 0 ? (
        <NonIdealState title="아직 등록된 작업이 없습니다" description="파일을 선택해 첫 전사 작업을 시작하세요." />
      ) : (
        <ul className="jobs-list" aria-label="전사 작업 목록">
          {props.jobs.map((job) => {
            const pending = props.pendingActionIds.has(job.id);
            const detail = props.selectedJob?.id === job.id ? props.selectedJob : null;
            return (
              <li key={job.id} className={props.selectedId === job.id ? 'job-row selected' : 'job-row'}>
                <button type="button" className="job-main" onClick={() => props.onSelect(job.id)} aria-pressed={props.selectedId === job.id}>
                  <span className="job-title" title={job.originalFilename}>{job.originalFilename}</span>
                  <span className="job-meta">
                    <Tag minimal intent={statusIntent[job.status]}>{statusLabels[job.status]}</Tag>
                    {job.status === 'processing' && <Spinner size={14} />}
                    {job.phase && <span>{phaseLabels[job.phase]}</span>}
                    {detail && <span>{languageLabel(detail.language)}</span>}
                    <span>{createdTime(job.createdAt)}</span>
                    {job.queuePosition !== null && <span>대기 #{job.queuePosition}</span>}
                  </span>
                  {job.error && <span className="job-error">{job.error.message}</span>}
                </button>
                <div className="job-actions">
                  {(job.status === 'queued' || job.status === 'processing') && (
                    <Button small minimal intent="danger" text="취소" loading={pending} disabled={pending} onClick={() => cancel(job)} />
                  )}
                  {job.status === 'failed' && (
                    <Button small minimal icon="repeat" text="재시도" loading={pending} disabled={pending} onClick={() => { void props.onRetry(job.id); }} />
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
    </Card>
  );
}
