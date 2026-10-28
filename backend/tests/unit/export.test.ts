import { describe, expect, it } from 'vitest';
import { renderSrt, formatSrtTimestamp } from '../../src/shared/export/srt.js';
import { renderVtt } from '../../src/shared/export/vtt.js';
import { renderTxt } from '../../src/shared/export/txt.js';

describe('transcript exports', () => {
  it('formats timestamps and Unicode in SRT/VTT', () => {
    const transcript = { text: '안녕하세요 日本語', segments: [{ startMs: 3_723_004, endMs: 3_724_125, text: '안녕하세요 日本語' }] };
    expect(formatSrtTimestamp(3_723_004)).toBe('01:02:03,004');
    expect(renderSrt(transcript)).toContain('01:02:03,004 --> 01:02:04,125\n안녕하세요 日本語');
    expect(renderVtt(transcript)).toContain('01:02:03.004 --> 01:02:04.125\n안녕하세요 日本語');
  });

  it('handles an empty transcript', () => {
    const transcript = { text: '', segments: [] };
    expect(renderTxt(transcript)).toBe('');
    expect(renderSrt(transcript)).toBe('');
    expect(renderVtt(transcript)).toBe('WEBVTT\n\n');
  });
});

