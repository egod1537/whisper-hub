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
    expect(config.defaultModel).toBe('large-v3');
    expect(config.chatGptPolishEnabled).toBe(false);
    expect(config.chatGptPolishModel).toBe('gpt-5.6-sol');
    expect(config.monitorIntervalSeconds).toBe(60);
    expect(config.monitorHealthUrls).toEqual(['http://api:3000/health/ready', 'http://frontend:8080/healthz']);
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

  it('loads monitoring thresholds and requires HTTPS for alert delivery', () => {
    const config = loadConfig({
      TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test',
      MONITOR_INTERVAL_SECONDS: '30', MONITOR_FAILURE_THRESHOLD: '2', MONITOR_ALERT_REPEAT_MINUTES: '15',
      MONITOR_DISK_WARN_PERCENT: '85', MONITOR_MIN_FREE_BYTES: '1024', MONITOR_QUEUE_WARN_COUNT: '5',
      MONITOR_HEALTH_URLS: 'https://example.com/health', MONITOR_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert',
      MONITOR_WEBHOOK_TIMEOUT_MS: '3000',
    });
    expect(config).toMatchObject({
      monitorIntervalSeconds: 30,
      monitorFailureThreshold: 2,
      monitorAlertRepeatMinutes: 15,
      monitorDiskWarnPercent: 85,
      monitorMinFreeBytes: 1_024,
      monitorQueueWarnCount: 5,
      monitorHealthUrls: ['https://example.com/health'],
      monitorAlertWebhookUrl: 'https://hooks.example.com/alert',
      monitorWebhookTimeoutMs: 3_000,
    });
    expect(() => loadConfig({
      TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test', MONITOR_ALERT_WEBHOOK_URL: 'http://example.com/alert',
    })).toThrow(/HTTPS/);
  });
});

