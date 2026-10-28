import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { normalizeYoutubeUrl } from '../../src/shared/youtube/downloader.js';

describe('YouTube URL validation', () => {
  it.each([
    ['https://youtu.be/abc123xyz00?si=tracking', 'https://www.youtube.com/watch?v=abc123xyz00'],
    ['https://www.youtube.com/watch?v=abc123xyz00&list=PL123', 'https://www.youtube.com/watch?v=abc123xyz00'],
    ['https://youtube.com/shorts/abc123xyz00', 'https://www.youtube.com/watch?v=abc123xyz00'],
    ['https://music.youtube.com/watch?v=abc123xyz00', 'https://www.youtube.com/watch?v=abc123xyz00'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeYoutubeUrl(input)).toBe(expected);
  });

  it.each(['https://example.com/watch?v=abc123xyz00', 'http://youtu.be/abc123xyz00', 'https://youtube.com/playlist?list=PL123'])('rejects %s', (input) => {
    expect(() => normalizeYoutubeUrl(input)).toThrowError(AppError);
  });
});
