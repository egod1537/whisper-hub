import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

describe('configuration', () => {
  it('fails fast without an API key', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/whisper-hub-config-test' })).toThrow(/API_KEY/);
    expect(() => loadConfig({ DATA_DIR: '/tmp/whisper-hub-config-test', API_KEY: 'a'.repeat(32) })).toThrow(/WEB_PROXY_TOKEN/);
  });

  it('requires independent production API and web proxy secrets', () => {
    const config = loadConfig({
      DATA_DIR: '/tmp/whisper-hub-config-test', API_KEY: 'a'.repeat(32), WEB_PROXY_TOKEN: 'b'.repeat(32),
    });
    expect(config.apiKey).not.toBe(config.webProxyToken);
  });

  it('allows an explicit test mode without a key', () => {
    expect(loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test' }).testMode).toBe(true);
  });

  it('validates resumable chunk and aggregate limits', () => {
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', UPLOAD_CHUNK_SIZE_BYTES: '20971521' })).toThrow(/UPLOAD_CHUNK_SIZE_BYTES/);
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', MAX_RESUMABLE_UPLOAD_BYTES: '2147483649' })).toThrow(/MAX_RESUMABLE_UPLOAD_BYTES/);
  });
});

