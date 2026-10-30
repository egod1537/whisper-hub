import type { Transcript } from '../export/types.js';

export interface TranscriptPolishInput {
  transcript: Transcript;
  language: string;
  signal: AbortSignal;
}

export interface TranscriptPolishResult {
  transcript: Transcript;
  model: string;
}

export interface TranscriptPolisher {
  readonly name: string;
  polish(input: TranscriptPolishInput): Promise<TranscriptPolishResult>;
}
