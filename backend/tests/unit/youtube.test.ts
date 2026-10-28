import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';
import { AppError } from '../../src/shared/errors.js';
import { normalizeYoutubeUrl, YtDlpYoutubeDownloader } from '../../src/shared/youtube/downloader.js';

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

  it('reports exact or estimated byte progress emitted by yt-dlp', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-youtube-'));
    const executable = path.join(directory, 'fake-yt-dlp.cjs');
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({ id: 'abc123xyz00', title: 'Progress test', duration: 10 }));
} else {
  const template = args[args.indexOf('--output') + 1];
  const output = template.replace('%(ext)s', 'webm');
  fs.writeFileSync(output, 'audio');
  console.log('progress:25:NA:100');
  console.log('progress:100:100:NA');
  console.log(output);
}
`, { mode: 0o700 });
    const config = loadConfig({ NODE_ENV: 'test', TEST_MODE: 'true', DATA_DIR: directory, YT_DLP_PATH: executable });
    const progress: Array<[number, number]> = [];
    try {
      const result = await new YtDlpYoutubeDownloader(config).download(
        'https://youtu.be/abc123xyz00', path.join(directory, 'download'), new AbortController().signal,
        (current, total) => progress.push([current, total]),
      );
      expect(progress).toEqual([[25, 100], [100, 100]]);
      expect(result).toMatchObject({ originalFilename: 'Progress test.webm', mediaType: 'audio/webm', fileSizeBytes: 5 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
