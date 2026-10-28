import { Button, Callout, Card, NonIdealState, Spinner, Tag } from '@blueprintjs/core';
import { useEffect, useState } from 'react';
import { ApiError, readableError, type WhisperApi } from '../api/client';
import type { JobDetail, OutputFormat, ResultsManifest } from '../api/types';

const PREVIEW_LIMIT = 100_000;

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy failed');
}

export interface TranscriptPanelProps {
  api: WhisperApi | null;
  job: JobDetail | null;
  loading?: boolean;
}

function incompleteState(job: JobDetail): { title: string; description: string } {
  if (job.status === 'failed') return { title: '전사에 실패했습니다', description: job.error?.message ?? '작업 대기열에서 오류를 확인하세요.' };
  if (job.status === 'canceled') return { title: '취소된 작업입니다', description: '취소된 작업은 재개할 수 없습니다.' };
  if (job.status === 'paused') return { title: '일시 중지된 작업입니다', description: '재개하면 대기열 끝에 들어가 처음부터 다시 처리합니다.' };
  if (job.status === 'pausing') return { title: '일시 중지 중입니다', description: '현재 처리를 안전하게 멈추고 있습니다.' };
  if (job.status === 'queued') return { title: '대기 중인 작업입니다', description: '차례가 되면 전사를 시작합니다.' };
  return { title: '전사가 진행 중입니다', description: '완료되면 결과가 자동으로 표시됩니다.' };
}

export function TranscriptPanel({ api, job, loading = false }: TranscriptPanelProps) {
  const [manifest, setManifest] = useState<ResultsManifest | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<OutputFormat | null>(null);

  useEffect(() => {
    setManifest(null);
    setTranscript(null);
    setError(null);
    setCopyStatus(null);
    setResultLoading(false);
    if (!api || !job || job.status !== 'completed') return;
    const controller = new AbortController();
    let activeRequest = true;
    setResultLoading(true);
    void api.getResults(job.id, controller.signal).then(async (result) => {
      if (!activeRequest) return;
      setManifest(result);
      if (result.availableFormats.includes('txt')) {
        const text = await api.fetchResultText(job.id, controller.signal);
        if (activeRequest) setTranscript(text);
      }
    }).catch((caught: unknown) => {
      if (!activeRequest || (caught instanceof DOMException && caught.name === 'AbortError')) return;
      setError(caught instanceof ApiError && caught.status === 409 ? '작업 상태를 다시 확인하고 있습니다.' : readableError(caught));
    }).finally(() => { if (activeRequest) setResultLoading(false); });
    return () => {
      activeRequest = false;
      controller.abort();
    };
  }, [api, job?.id, job?.status, job?.updatedAt]);

  const download = async (format: OutputFormat) => {
    if (!api || !job) return;
    setDownloading(format);
    setError(null);
    try {
      const result = await api.downloadResult(job.id, format, job.originalFilename);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setDownloading(null);
    }
  };

  const copy = async () => {
    if (transcript === null) return;
    try {
      await copyText(transcript);
      setCopyStatus('복사했습니다.');
    } catch {
      setCopyStatus('클립보드에 복사하지 못했습니다.');
    }
  };

  const preview = transcript?.slice(0, PREVIEW_LIMIT) ?? null;
  const truncated = transcript !== null && transcript.length > PREVIEW_LIMIT;

  return (
    <Card className="panel transcript-panel" elevation={0}>
      <div className="panel-heading">
        <div>
          <h2>전사 결과</h2>
          {job && <p className="counts filename" title={job.originalFilename}>{job.originalFilename}</p>}
        </div>
        {job?.status === 'completed' && <Tag intent="success">완료</Tag>}
      </div>

      {loading ? (
        <div className="centered-loading" role="status"><Spinner size={24} /> 작업 상세를 불러오는 중</div>
      ) : !job ? (
        <NonIdealState title="작업을 선택해 주세요" description="완료된 작업의 결과를 미리 보고 내려받을 수 있습니다." />
      ) : job.status !== 'completed' ? (
        <NonIdealState
          title={incompleteState(job).title}
          description={incompleteState(job).description}
        />
      ) : resultLoading ? (
        <div className="centered-loading" role="status"><Spinner size={24} /> 결과를 불러오는 중</div>
      ) : (
        <>
          {error && <Callout compact intent="danger" className="inline-message">{error}</Callout>}
          {manifest && (
            <>
              <div className="result-actions">
                {preview !== null && <Button icon="clipboard" text="복사" onClick={() => { void copy(); }} />}
                {manifest.availableFormats.map((format) => (
                  <Button
                    key={format}
                    icon="download"
                    text={`${format.toUpperCase()} 다운로드`}
                    loading={downloading === format}
                    disabled={downloading !== null}
                    onClick={() => { void download(format); }}
                  />
                ))}
              </div>
              {copyStatus && <p className="copy-status" role="status">{copyStatus}</p>}
              {preview === null ? (
                <NonIdealState title="미리보기 없음" description="TXT 형식을 요청하지 않았습니다. 위 버튼에서 결과 파일을 내려받으세요." />
              ) : (
                <>
                  <pre className="transcript-preview" tabIndex={0}>{preview}</pre>
                  {truncated && <Callout compact>미리보기는 처음 100,000자만 표시합니다. 전체 내용은 TXT 파일을 내려받아 확인하세요.</Callout>}
                </>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
