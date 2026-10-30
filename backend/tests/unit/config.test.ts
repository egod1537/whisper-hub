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
    const config = loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test' });
    expect(config.testMode).toBe(true);
    expect(config.chatGptPolishEnabled).toBe(false);
    expect(config.chatGptPolishModel).toBe('gpt-5.6-sol');
  });

  it('loads ChatGPT polishing configuration explicitly', () => {
    const config = loadConfig({
      TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', CHATGPT_POLISH_ENABLED: 'true',
      CHATGPT_PLAN_CREDENTIALS_PATH: '/tmp/chatgpt-plan.json', CHATGPT_POLISH_MODEL: 'gpt-test',
      CHATGPT_POLISH_TIMEOUT_MS: '12345', CHATGPT_POLISH_CHUNK_CHARS: '5000',
    });
    expect(config).toMatchObject({
      chatGptPolishEnabled: true,
      chatGptPlanCredentialsPath: '/tmp/chatgpt-plan.json',
      chatGptPolishModel: 'gpt-test',
      chatGptPolishTimeoutMs: 12_345,
      chatGptPolishChunkChars: 5_000,
    });
  });

  it('validates resumable chunk and aggregate limits', () => {
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', UPLOAD_CHUNK_SIZE_BYTES: '20971521' })).toThrow(/UPLOAD_CHUNK_SIZE_BYTES/);
    expect(() => loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', MAX_RESUMABLE_UPLOAD_BYTES: '2147483649' })).toThrow(/MAX_RESUMABLE_UPLOAD_BYTES/);
  });
});

