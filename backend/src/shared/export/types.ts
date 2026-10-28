export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  languageDetected?: string;
  providerMetadata?: Record<string, unknown>;
}

