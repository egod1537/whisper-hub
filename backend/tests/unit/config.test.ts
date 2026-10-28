import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

describe('configuration', () => {
  it('fails fast without an API key', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/whisper-hub-config-test' })).toThrow(/API_KEY/);
  });

  it('allows an explicit test mode without a key', () => {
    expect(loadConfig({ TEST_MODE: 'true', DATA_DIR: '/tmp/whisper-hub-config-test' }).testMode).toBe(true);
  });
});

