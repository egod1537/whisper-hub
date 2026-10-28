import type { Language, OutputFormat } from './types';

const storageKey = 'whisper-hub-resumable-upload-v1';

export interface ResumeMetadata {
  uploadId: string;
  filename: string;
  sizeBytes: number;
  lastModified: number;
  language: Language;
  formats: OutputFormat[];
}

export function loadResumeMetadata(): ResumeMetadata | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<ResumeMetadata> | null;
    if (!parsed || typeof parsed.uploadId !== 'string' || typeof parsed.filename !== 'string' || typeof parsed.sizeBytes !== 'number' ||
      typeof parsed.lastModified !== 'number' || !['auto', 'ko', 'ja', 'en'].includes(parsed.language ?? '') ||
      !Array.isArray(parsed.formats) || parsed.formats.some((format) => !['txt', 'srt', 'vtt', 'json'].includes(format))) return null;
    return parsed as ResumeMetadata;
  } catch { return null; }
}

export function saveResumeMetadata(value: ResumeMetadata): void {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

export function clearResumeMetadata(): void {
  localStorage.removeItem(storageKey);
}
