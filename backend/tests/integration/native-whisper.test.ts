import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WhisperHttpProvider } from '../../src/shared/providers/whisperHttp.js';

const enabled = process.env.RUN_NATIVE_WHISPER_E2E === '1';
describe.skipIf(!enabled)('native macOS whisper.cpp integration', () => {
  it('transcribes the configured real Korean fixture with timestamps', async () => {
    const fixture = process.env.NATIVE_WHISPER_FIXTURE;
    if (!fixture || !fs.existsSync(fixture)) throw new Error('NATIVE_WHISPER_FIXTURE must point to a real 16 kHz WAV file');
    const provider = new WhisperHttpProvider(process.env.WHISPER_BASE_URL ?? 'http://127.0.0.1:8080', 120_000);
    const result = await provider.transcribe({ wavPath: fixture, language: 'ko', signal: new AbortController().signal });
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThan(0);
  }, 130_000);
});

