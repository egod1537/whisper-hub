import { Button, Callout, Card, Checkbox, FormGroup, HTMLSelect, ProgressBar, Spinner } from '@blueprintjs/core';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { readableError, type WhisperApi } from '../api/client';
import { uploadResumably } from '../api/resumable';
import { clearResumeMetadata, loadResumeMetadata, saveResumeMetadata, type ResumeMetadata } from '../api/resumeStorage';
import type { CreateJobResponse, Language, OutputFormat } from '../api/types';

const formatOptions: Array<{ value: OutputFormat; label: string }> = [
  { value: 'txt', label: 'TXT' }, { value: 'srt', label: 'SRT' }, { value: 'vtt', label: 'VTT' }, { value: 'json', label: 'JSON' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}

export interface UploadPanelProps {
  api: WhisperApi | null;
  disabled?: boolean;
  onCreated(job: CreateJobResponse, originalFilename: string): void;
}

export function UploadPanel({ api, disabled = false, onCreated }: UploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<Language>('auto');
  const [formats, setFormats] = useState<ReadonlySet<OutputFormat>>(new Set(['txt']));
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [resume, setResume] = useState<ResumeMetadata | null>(() => loadResumeMetadata());
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const activeUploadId = useRef<string | null>(null);

  useEffect(() => () => requestController.current?.abort(), []);
  const selectedFormats = useMemo(() => formatOptions.map(({ value }) => value).filter((format) => formats.has(format)), [formats]);
  const resumeMatches = file !== null && resume !== null && file.name === resume.filename && file.size === resume.sizeBytes &&
    file.lastModified === resume.lastModified && language === resume.language && selectedFormats.join(',') === resume.formats.join(',');

  const chooseFile = (selected: File | null) => {
    setFile(selected); setError(null); setMessage(null); setProgress(0); idempotencyKeyRef.current = null;
    if (selected && resume && selected.name === resume.filename && selected.size === resume.sizeBytes && selected.lastModified === resume.lastModified) {
      setLanguage(resume.language); setFormats(new Set(resume.formats));
      setMessage('저장된 업로드 세션을 서버 상태부터 확인해 이어서 전송합니다.');
    }
  };

  const toggleFormat = (format: OutputFormat) => {
    setFormats((current) => { const next = new Set(current); if (next.has(format)) next.delete(format); else next.add(format); return next; });
    setError(null); idempotencyKeyRef.current = null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || !api || !file) return;
    if (selectedFormats.length === 0) { setError('출력 형식을 하나 이상 선택해 주세요.'); return; }
    const key = idempotencyKeyRef.current ?? globalThis.crypto.randomUUID();
    idempotencyKeyRef.current = key; submittingRef.current = true; setSubmitting(true); setError(null);
    setMessage('서버의 업로드 상태를 확인하고 있습니다.');
    const controller = new AbortController(); requestController.current = controller;
    try {
      if (resumeMatches) activeUploadId.current = resume.uploadId;
      const created = await uploadResumably(api, file, language, selectedFormats, {
        ...(resumeMatches ? { existingUploadId: resume.uploadId } : {}), idempotencyKey: key, signal: controller.signal, concurrency: 3,
        onSession: (uploadId) => {
          activeUploadId.current = uploadId;
          const metadata: ResumeMetadata = { uploadId, filename: file.name, sizeBytes: file.size, lastModified: file.lastModified, language, formats: selectedFormats };
          saveResumeMetadata(metadata); setResume(metadata);
        },
        onProgress: (completed, total, phase) => {
          setProgress(total === 0 ? 0 : completed / total);
          setMessage(phase === 'finalizing' ? '업로드 완료 · 서버에서 파일을 조립하고 있습니다.' : `${formatBytes(completed)} / ${formatBytes(total)} 업로드 완료`);
        },
      });
      onCreated(created, file.name); setFile(null); if (inputRef.current) inputRef.current.value = '';
      idempotencyKeyRef.current = null; activeUploadId.current = null; clearResumeMetadata(); setResume(null); setProgress(1);
      setMessage('작업이 대기열에 등록되었습니다.');
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setMessage(activeUploadId.current ? '파일을 다시 선택하면 서버에 저장된 청크부터 이어서 전송할 수 있습니다.' : '같은 요청 키로 다시 시도할 수 있습니다.');
      setError(readableError(caught));
    } finally {
      requestController.current = null; submittingRef.current = false; setSubmitting(false);
    }
  };

  const cancelUpload = async () => {
    requestController.current?.abort();
    const uploadId = activeUploadId.current; activeUploadId.current = null;
    if (api && uploadId) { try { await api.abortUpload(uploadId); } catch (caught) { setError(readableError(caught)); return; } }
    clearResumeMetadata(); setResume(null); setProgress(0); setMessage('업로드를 취소했습니다.');
  };

  return (
    <Card className="panel upload-panel" elevation={0}>
      <h2>새 전사 작업</h2>
      <form onSubmit={(event) => { void submit(event); }}>
        <FormGroup label="오디오 또는 비디오 파일" labelFor="media-file" helperText="중단되어도 저장된 청크부터 재개되며, 서버 기본 제한은 2 GiB입니다.">
          <input ref={inputRef} id="media-file" className="native-file-input" type="file" accept="audio/*,video/*,.wav,.mp3,.m4a,.flac,.ogg,.mp4,.mov,.mkv,.webm"
            disabled={disabled || submitting} onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)} />
        </FormGroup>
        {resume && !file && <Callout intent="primary" compact className="inline-message">{resume.filename} ({formatBytes(resume.sizeBytes)}) 업로드를 재개하려면 원본 파일을 다시 선택하세요.</Callout>}
        {file && <div className="selected-file" aria-label="선택된 파일"><span className="filename" title={file.name}>{file.name}</span><span className="muted">{formatBytes(file.size)}</span><Button minimal small type="button" text="선택 해제" disabled={submitting} onClick={() => chooseFile(null)} /></div>}
        <FormGroup label="언어" labelFor="language"><HTMLSelect id="language" fill value={language} disabled={disabled || submitting}
          onChange={(event) => { setLanguage(event.currentTarget.value as Language); setError(null); idempotencyKeyRef.current = null; }}>
          <option value="auto">자동 감지</option><option value="ko">한국어</option><option value="ja">일본어</option><option value="en">영어</option>
        </HTMLSelect></FormGroup>
        <fieldset className="format-fieldset" disabled={disabled || submitting}><legend>출력 형식</legend><div className="format-options">
          {formatOptions.map((option) => <Checkbox key={option.value} label={option.label} checked={formats.has(option.value)} onChange={() => toggleFormat(option.value)} />)}
        </div></fieldset>
        {error && <Callout intent="danger" compact className="inline-message">{error}</Callout>}
        {message && <div className="upload-status" role="status">{submitting && <Spinner size={16} />}<span>{message}</span></div>}
        {submitting && <ProgressBar value={progress} animate={progress < 1} stripes={progress < 1} aria-label="업로드 진행률" />}
        <Button intent="primary" type="submit" text={submitting ? '업로드 중' : '전사 시작'} loading={submitting}
          disabled={disabled || !api || !file || selectedFormats.length === 0 || submitting} fill />
        {submitting && <Button type="button" text="업로드 취소" minimal intent="danger" fill onClick={() => { void cancelUpload(); }} />}
      </form>
    </Card>
  );
}
