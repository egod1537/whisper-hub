import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionMonitor } from '../../src/monitor/service.js';
import type { TestContext } from '../helpers.js';
import { createTestContext } from '../helpers.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => context.close());

describe('production monitor', () => {
  it('debounces persistent failures, sends a webhook, and reports recovery', async () => {
    context.repository.recordWorkerHeartbeat('worker-test', null);
    let providerHealthy = false;
    const alerts: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://hooks.example.com/alert') {
        alerts.push(JSON.parse(init?.body as string));
        return new Response(null, { status: 204 });
      }
      return new Response('ok', { status: 200 });
    });
    const monitor = new ProductionMonitor({
      config: {
        ...context.config,
        monitorAlertWebhookUrl: 'https://hooks.example.com/alert',
        monitorFailureThreshold: 3,
        monitorHealthUrls: ['https://whisper.example.com/healthz'],
        monitorMinFreeBytes: 0,
      },
      repository: context.repository,
      provider: { async health() { return providerHealthy; } },
      logger: pino({ level: 'silent' }),
      fetchFn,
      statfsFn: async () => ({ bsize: 1, bavail: 50, blocks: 100 }),
    });

    await monitor.runOnce();
    await monitor.runOnce();
    expect(alerts).toHaveLength(0);
    await monitor.runOnce();
    expect(alerts).toMatchObject([{ status: 'firing', key: 'whisper_provider' }]);

    providerHealthy = true;
    await monitor.runOnce();
    expect(alerts).toMatchObject([
      { status: 'firing', key: 'whisper_provider' },
      { status: 'resolved', key: 'whisper_provider' },
    ]);
  });
});
