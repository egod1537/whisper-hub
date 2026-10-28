import type { Transcript } from './types.js';

export function renderTxt(transcript: Transcript): string {
  return transcript.text.endsWith('\n') || transcript.text.length === 0 ? transcript.text : `${transcript.text}\n`;
}

