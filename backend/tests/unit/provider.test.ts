import { describe, expect, it } from 'vitest';
import { whisperHttpInternals } from '../../src/shared/providers/whisperHttp.js';

describe('whisper.cpp response normalization', () => {
  it('normalizes v1.9.5 verbose_json seconds to milliseconds', () => {
    const result = whisperHttpInternals.normalizeResponse(JSON.stringify({
      task: 'transcribe', language: 'Korean', duration: 1.2, text: ' 안녕 ',
      segments: [{ id: 0, start: 0.1, end: 1.2, text: ' 안녕' }],
    }));
    expect(result.text).toBe('안녕');
    expect(result.segments).toEqual([{ startMs: 100, endMs: 1_200, text: ' 안녕' }]);
  });

  it('rejects missing, corrupt, or unordered timestamps', () => {
    expect(() => whisperHttpInternals.normalizeResponse('{')).toThrow(/invalid JSON/);
    expect(() => whisperHttpInternals.normalizeResponse(JSON.stringify({ text: 'x', segments: [{ text: 'x' }] }))).toThrow(/timestamps/);
    expect(() => whisperHttpInternals.normalizeResponse(JSON.stringify({
      text: 'x', segments: [{ start: 1, end: 2, text: 'x' }, { start: 1.5, end: 3, text: 'y' }],
    }))).toThrow(/invalid/);
  });
});

