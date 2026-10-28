import { Callout, Navbar, Tag } from '@blueprintjs/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, checkHealth } from './api/client';
import { JobsList } from './components/JobsList';
import { TranscriptPanel } from './components/TranscriptPanel';
import { UploadPanel } from './components/UploadPanel';
import { useJobs } from './hooks/useJobs';

export function App() {
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  const api = useMemo(() => new ApiClient(), []);
  const handleUnauthorized = useCallback(() => {
    setAuthNotice('서버의 API 인증 설정을 확인해 주세요.');
  }, []);
  const jobs = useJobs(api, handleUnauthorized);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const probe = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const ready = await checkHealth(controller.signal);
        if (!disposed) setConnected(ready);
      } catch {
        if (!disposed) setConnected(false);
      }
    };
    void probe();
    const timer = window.setInterval(() => { void probe(); }, 15_000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="app-shell">
      <Navbar className="app-navbar">
        <div className="navbar-inner">
          <Navbar.Group>
            <Navbar.Heading>Whisper Hub</Navbar.Heading>
          </Navbar.Group>
          <Navbar.Group align="right">
            <Tag minimal intent={connected === true ? 'success' : connected === false ? 'danger' : 'none'}>
              {connected === true ? '연결됨' : connected === false ? '연결 끊김' : '확인 중'}
            </Tag>
          </Navbar.Group>
        </div>
      </Navbar>

      <main className="app-main">
        {authNotice && <Callout compact intent="warning" className="inline-message auth-notice">{authNotice}</Callout>}

        <div className="workspace-grid">
          <UploadPanel api={api} disabled={connected === false} onCreated={jobs.addCreated} />
          <JobsList
            jobs={jobs.jobs}
            selectedId={jobs.selectedId}
            selectedJob={jobs.selectedJob}
            systemStatus={jobs.systemStatus}
            loading={jobs.loading}
            stale={jobs.stale}
            error={jobs.error}
            nextCursor={jobs.nextCursor}
            pendingActionIds={jobs.pendingActionIds}
            disabled={connected === false}
            onSelect={jobs.selectJob}
            onRefresh={jobs.refresh}
            onLoadMore={jobs.loadMore}
            onCancel={jobs.cancelJob}
            onRetry={jobs.retryJob}
          />
        </div>

        <TranscriptPanel api={api} job={jobs.selectedJob} loading={jobs.detailLoading} />
        <p className="privacy-note">개인용 단일 운영자 서비스 · 업로드와 전사 결과는 서버의 로컬 저장소에 보관됩니다.</p>
      </main>
      <div className="sr-only" aria-live="polite">
        {jobs.error ?? authNotice ?? (connected === false ? '서버 연결이 끊겼습니다.' : '')}
      </div>
    </div>
  );
}
