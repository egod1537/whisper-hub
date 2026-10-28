import { Button, ButtonGroup, Callout, Card, Checkbox, FormGroup, HTMLSelect, ProgressBar, Spinner, TextArea } from '@blueprintjs/core';
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

function fileKey(file: File): string {
  return `file:${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function youtubeUrls(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export interface UploadPanelProps {
  api: WhisperApi | null;
  disabled?: boolean;
  onCreated(job: CreateJobResponse, originalFilename: string): void;
}

export function UploadPanel({ api, disabled = false, onCreated }: UploadPanelProps) {
  const [sourceMode, setSourceMode] = useState<'file' | 'youtube'>('file');
  const [files, setFiles] = useState<File[]>([]);
  const [youtubeInput, setYoutubeInput] = useState('');
  const [language, setLanguage] = useState<Language>('auto');
  const [formats, setFormats] = useState<ReadonlySet<OutputFormat>>(new Set(['txt']));
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [batchPosition, setBatchPosition] = useState<{ current: number; total: number } | null>(null);
  const [resume, setResume] = useState<ResumeMetadata | null>(() => loadResumeMetadata());
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const idempotencyKeysRef = useRef(new Map<string, string>());
  const requestController = useRef<AbortController | null>(null);
  const activeUploadId = useRef<string | null>(null);
  const activeItemKey = useRef<string | null>(null);

  useEffect(() => () => requestController.current?.abort(), []);
  const selectedFormats = useMemo(() => formatOptions.map(({ value }) => value).filter((format) => formats.has(format)), [formats]);
  const parsedYoutubeUrls = useMemo(() => youtubeUrls(youtubeInput), [youtubeInput]);
  const totalSelectedBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const matchesResume = (file: File) => resume !== null && file.name === resume.filename && file.size === resume.sizeBytes &&
    file.lastModified === resume.lastModified && language === resume.language && selectedFormats.join(',') === resume.formats.join(',');

  const chooseFiles = (selected: File[]) => {
    let ordered = selected;
    const resumeIndex = resume ? selected.findIndex((file) => file.name === resume.filename && file.size === resume.sizeBytes && file.lastModified === resume.lastModified) : -1;
    if (resumeIndex > 0) ordered = [selected[resumeIndex]!, ...selected.filter((_, index) => index !== resumeIndex)];
    setFiles(ordered); setError(null); setMessage(null); setProgress(0); idempotencyKeysRef.current.clear();
    if (resumeIndex >= 0 && resume) {
      setLanguage(resume.language); setFormats(new Set(resume.formats));
      setMessage('저장된 업로드 세션을 서버 상태부터 확인해 이어서 전송합니다.');
    }
  };

  const toggleFormat = (format: OutputFormat) => {
    setFormats((current) => { const next = new Set(current); if (next.has(format)) next.delete(format); else next.add(format); return next; });
    setError(null); idempotencyKeysRef.current.clear();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const selectedFiles = [...files];
    const selectedYoutubeUrls = [...parsedYoutubeUrls];
    if (submittingRef.current || !api || (sourceMode === 'file' ? selectedFiles.length === 0 : selectedYoutubeUrls.length === 0)) return;
    if (selectedFormats.length === 0) { setError('출력 형식을 하나 이상 선택해 주세요.'); return; }
    if (sourceMode === 'youtube' && selectedYoutubeUrls.length > 10) { setError('YouTube 링크는 한 번에 최대 10개까지 등록할 수 있습니다.'); return; }
    submittingRef.current = true; setSubmitting(true); setError(null);
    setMessage(sourceMode === 'file' ? '서버의 업로드 상태를 확인하고 있습니다.' : 'YouTube 작업을 대기열에 등록하고 있습니다.');
    const controller = new AbortController(); requestController.current = controller;
    let completedCount = 0;
    try {
      if (sourceMode === 'youtube') {
        for (const [index, url] of selectedYoutubeUrls.entries()) {
          const itemKey = `youtube:${url}`;
          activeItemKey.current = itemKey;
          setBatchPosition({ current: index + 1, total: selectedYoutubeUrls.length });
          setMessage(`${index + 1} / ${selectedYoutubeUrls.length} YouTube 작업을 등록하고 있습니다.`);
          let key = idempotencyKeysRef.current.get(itemKey);
          if (!key) { key = globalThis.crypto.randomUUID(); idempotencyKeysRef.current.set(itemKey, key); }
          const created = await api.createYoutubeJob({ url, language, formats: selectedFormats, idempotencyKey: key, signal: controller.signal });
          onCreated(created, selectedYoutubeUrls.length === 1 ? 'YouTube 영상' : `YouTube 영상 ${index + 1}`);
          completedCount += 1;
          idempotencyKeysRef.current.delete(itemKey);
          activeItemKey.current = null;
          setYoutubeInput(selectedYoutubeUrls.slice(index + 1).join('\n'));
        }
      } else {
        for (const [index, selectedFile] of selectedFiles.entries()) {
          const itemKey = fileKey(selectedFile);
          activeItemKey.current = itemKey;
          setBatchPosition({ current: index + 1, total: selectedFiles.length });
          setProgress(0);
          setMessage(`${index + 1} / ${selectedFiles.length} · ${selectedFile.name} 업로드 준비 중`);
          let key = idempotencyKeysRef.current.get(itemKey);
          if (!key) { key = globalThis.crypto.randomUUID(); idempotencyKeysRef.current.set(itemKey, key); }
          const resumeMatches = matchesResume(selectedFile);
          if (resumeMatches && resume) activeUploadId.current = resume.uploadId;
          const created = await uploadResumably(api, selectedFile, language, selectedFormats, {
            ...(resumeMatches && resume ? { existingUploadId: resume.uploadId } : {}), idempotencyKey: key, signal: controller.signal, concurrency: 3,
            onSession: (uploadId) => {
              activeUploadId.current = uploadId;
              const metadata: ResumeMetadata = { uploadId, filename: selectedFile.name, sizeBytes: selectedFile.size, lastModified: selectedFile.lastModified, language, formats: selectedFormats };
              saveResumeMetadata(metadata); setResume(metadata);
            },
            onProgress: (completed, total, phase) => {
              setProgress(total === 0 ? 0 : completed / total);
              const prefix = `${index + 1} / ${selectedFiles.length} · ${selectedFile.name} · `;
              setMessage(prefix + (phase === 'finalizing' ? `${formatBytes(completed)} / ${formatBytes(total)} 서버 조립 중` : `${formatBytes(completed)} / ${formatBytes(total)} 업로드 완료`));
            },
          });
          onCreated(created, selectedFile.name);
          completedCount += 1;
          idempotencyKeysRef.current.delete(itemKey);
          activeItemKey.current = null;
          activeUploadId.current = null;
          clearResumeMetadata(); setResume(null); setProgress(1);
          setFiles(selectedFiles.slice(index + 1));
        }
        if (inputRef.current) inputRef.current.value = '';
      }
      activeUploadId.current = null; activeItemKey.current = null;
      setMessage(completedCount === 1 ? '작업이 대기열에 등록되었습니다.' : `${completedCount}개 작업이 대기열에 등록되었습니다.`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const completed = completedCount > 0 ? `${completedCount}개 작업은 등록 완료되었습니다. ` : '';
      setMessage(completed + (activeUploadId.current ? '현재 파일을 다시 선택하면 서버에 저장된 청크부터 이어서 전송할 수 있습니다.' : '처리되지 않은 항목부터 다시 시도할 수 있습니다.'));
      setError(readableError(caught));
    } finally {
      requestController.current = null; submittingRef.current = false; setSubmitting(false); setBatchPosition(null);
    }
  };

  const cancelUpload = async () => {
    requestController.current?.abort();
    const uploadId = activeUploadId.current; activeUploadId.current = null;
    if (api && uploadId) {
      try {
        await api.abortUpload(uploadId);
        if (activeItemKey.current) idempotencyKeysRef.current.delete(activeItemKey.current);
      } catch (caught) { setError(readableError(caught)); return; }
    }
    activeItemKey.current = null;
    if (sourceMode === 'file') { clearResumeMetadata(); setResume(null); }
    setProgress(0); setMessage(sourceMode === 'file' ? '업로드를 취소했습니다.' : '요청을 취소했습니다.');
  };

  return (
    <Card className="panel upload-panel" elevation={0}>
      <h2>새 전사 작업</h2>
      <form onSubmit={(event) => { void submit(event); }}>
        <ButtonGroup fill className="source-selector" aria-label="입력 방식">
          <Button type="button" active={sourceMode === 'file'} text="파일 업로드" disabled={submitting}
            onClick={() => { setSourceMode('file'); setError(null); setMessage(null); idempotencyKeysRef.current.clear(); }} />
          <Button type="button" active={sourceMode === 'youtube'} text="YouTube 링크" disabled={submitting}
            onClick={() => { setSourceMode('youtube'); setError(null); setMessage(null); idempotencyKeysRef.current.clear(); }} />
        </ButtonGroup>
        {sourceMode === 'file' ? <>
          <FormGroup label="오디오 또는 비디오 파일" labelFor="media-file" helperText="여러 파일을 한 번에 선택할 수 있습니다. 각 파일은 중단되어도 저장된 청크부터 재개됩니다.">
            <input ref={inputRef} id="media-file" className="native-file-input" type="file" multiple accept="audio/*,video/*,.wav,.mp3,.m4a,.flac,.ogg,.mp4,.mov,.mkv,.webm"
              disabled={disabled || submitting} onChange={(event) => chooseFiles(Array.from(event.currentTarget.files ?? []))} />
          </FormGroup>
          {resume && files.length === 0 && <Callout intent="primary" compact className="inline-message">{resume.filename} ({formatBytes(resume.sizeBytes)}) 업로드를 재개하려면 원본 파일을 다시 선택하세요.</Callout>}
          {files.length > 0 && <div className="selected-files" aria-label="선택된 파일 목록">
            <div className="selected-files-summary"><strong>{files.length}개 파일</strong><span className="muted">총 {formatBytes(totalSelectedBytes)}</span><Button minimal small type="button" text="전체 선택 해제" disabled={submitting} onClick={() => chooseFiles([])} /></div>
            <ul>{files.map((file) => <li key={fileKey(file)}><span className="filename" title={file.name}>{file.name}</span><span className="muted">{formatBytes(file.size)}</span></li>)}</ul>
          </div>}
        </> : (
          <FormGroup label="YouTube 영상 링크" labelFor="youtube-url" helperText="한 줄에 하나씩 최대 10개까지 등록할 수 있습니다. 실시간 라이브는 지원하지 않습니다.">
            <TextArea id="youtube-url" fill rows={4} placeholder={'https://www.youtube.com/watch?v=...\nhttps://youtu.be/...'} value={youtubeInput}
              disabled={disabled || submitting} autoComplete="off" inputMode="url"
              onChange={(event) => { setYoutubeInput(event.currentTarget.value); setError(null); idempotencyKeysRef.current.clear(); }} />
            {parsedYoutubeUrls.length > 0 && <div className="input-count">중복 제외 {parsedYoutubeUrls.length}개 링크</div>}
          </FormGroup>
        )}
        <FormGroup label="언어" labelFor="language"><HTMLSelect id="language" fill value={language} disabled={disabled || submitting}
          onChange={(event) => { setLanguage(event.currentTarget.value as Language); setError(null); idempotencyKeysRef.current.clear(); }}>
          <option value="auto">자동 감지</option><option value="ko">한국어</option><option value="ja">일본어</option><option value="en">영어</option>
        </HTMLSelect></FormGroup>
        <fieldset className="format-fieldset" disabled={disabled || submitting}><legend>출력 형식</legend><div className="format-options">
          {formatOptions.map((option) => <Checkbox key={option.value} label={option.label} checked={formats.has(option.value)} onChange={() => toggleFormat(option.value)} />)}
        </div></fieldset>
        {error && <Callout intent="danger" compact className="inline-message">{error}</Callout>}
        {message && <div className="upload-status" role="status">{submitting && <Spinner size={16} />}<span>{message}</span></div>}
        {submitting && sourceMode === 'file' && <ProgressBar value={progress} animate={progress < 1} stripes={progress < 1} aria-label="업로드 진행률" />}
        <Button intent="primary" type="submit" text={submitting ? `${sourceMode === 'file' ? '업로드' : '등록'} 중${batchPosition ? ` (${batchPosition.current}/${batchPosition.total})` : ''}` : '전사 시작'} loading={submitting}
          disabled={disabled || !api || (sourceMode === 'file' ? files.length === 0 : parsedYoutubeUrls.length === 0) || selectedFormats.length === 0 || submitting} fill />
        {submitting && <Button type="button" text={sourceMode === 'file' ? '업로드 취소' : '요청 취소'} minimal intent="danger" fill onClick={() => { void cancelUpload(); }} />}
      </form>
    </Card>
  );
}
