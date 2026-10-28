import { Button, Callout, Card, InputGroup, Navbar, Tag } from '@blueprintjs/core';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiClient, checkHealth } from './api/client';
import { JobsList } from './components/JobsList';
import { TranscriptPanel } from './components/TranscriptPanel';
import { UploadPanel } from './components/UploadPanel';
import { useJobs } from './hooks/useJobs';

export function App() {
  const [apiKey, setApiKey] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  const api = useMemo(() => apiKey ? new ApiClient(apiKey) : null, [apiKey]);
  const handleUnauthorized = useCallback(() => {
    setApiKey('');
    setKeyDraft('');
    setEditingKey(true);
    setAuthNotice('API 키가 만료되었거나 올바르지 않습니다. 다시 입력해 주세요.');
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

  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    const value = keyDraft.trim();
    if (value.length < 16) {
      setAuthNotice('API 키를 정확히 입력해 주세요.');
      return;
    }
    setApiKey(value);
    setKeyDraft('');
    setEditingKey(false);
    setAuthNotice(null);
  };

  return (
    <div className="app-shell">
      <Navbar className="app-navbar">
        <div className="navbar-inner">
          <Navbar.Group>
            <Navbar.Heading>Whisper Hub</Navbar.Heading>
          </Navbar.Group>
          <Navbar.Group align="right" className="header-actions">
            <Tag minimal intent={connected === true ? 'success' : connected === false ? 'danger' : 'none'}>
              {connected === true ? '연결됨' : connected === false ? '연결 끊김' : '확인 중'}
            </Tag>
            <Button
              minimal
              icon="key"
              text={apiKey ? 'API 키 변경' : 'API 키 설정'}
              onClick={() => setEditingKey((value) => !value)}
            />
          </Navbar.Group>
        </div>
      </Navbar>

      <main className="app-main">
        {(editingKey || !apiKey) && (
          <Card className="key-panel" elevation={0}>
            <form className="key-form" onSubmit={saveKey}>
              <div className="key-copy">
                <h2>API 키</h2>
                <p>키는 이 브라우저 탭의 메모리에만 보관되며 새로고침하면 사라집니다.</p>
              </div>
              <InputGroup
                id="api-key"
                aria-label="API 키"
                type="password"
                autoComplete="off"
                placeholder="Bearer 키 입력"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.currentTarget.value)}
              />
              <Button intent="primary" type="submit" text="연결" disabled={keyDraft.trim().length < 16} />
              {apiKey && <Button type="button" text="취소" onClick={() => setEditingKey(false)} />}
            </form>
            {authNotice && <Callout compact intent="warning" className="inline-message">{authNotice}</Callout>}
          </Card>
        )}

        {!apiKey && !authNotice && (
          <Callout intent="primary" className="access-callout">작업을 조회하거나 등록하려면 API 키를 입력해 주세요.</Callout>
        )}

        <div className="workspace-grid">
          <UploadPanel api={api} disabled={!apiKey || connected === false} onCreated={jobs.addCreated} />
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
            disabled={!apiKey}
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
