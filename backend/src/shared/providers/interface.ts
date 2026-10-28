import type { Transcript } from '../export/types.js';

export interface TranscribeInput {
  wavPath: string;
  language: string;
  signal: AbortSignal;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<Transcript>;
  health(signal?: AbortSignal): Promise<boolean>;
}

