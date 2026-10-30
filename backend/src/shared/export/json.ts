import type { Transcript } from './types.js';

export function renderJson(transcript: Transcript): string {
  return `${JSON.stringify({
    text: transcript.text,
    languageDetected: transcript.languageDetected ?? null,
    segments: transcript.segments,
    providerMetadata: transcript.providerMetadata ?? null,
    postProcessingMetadata: transcript.postProcessingMetadata ?? null,
  }, null, 2)}\n`;
}

