import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

describe('configuration', () => {
  it('fails fast without an API key', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/whisper-hub-config-test' })).toThrow(/API_KEY/);
  });

  it('allows an explicit test mode without a key', () => {
    expect(loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test' }).testMode).toBe(true);
  });

  it('validates resumable chunk and aggregate limits', () => {
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', UPLOAD_CHUNK_SIZE_BYTES: '20971521' })).toThrow(/UPLOAD_CHUNK_SIZE_BYTES/);
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', MAX_RESUMABLE_UPLOAD_BYTES: '2147483649' })).toThrow(/MAX_RESUMABLE_UPLOAD_BYTES/);
  });
});

