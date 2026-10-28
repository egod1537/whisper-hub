import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../helpers.js';
import { createTestContext } from '../helpers.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => context.close());

describe('OpenAPI contract', () => {
  it('serves public API discovery at the root', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: 'Whisper Hub API',
      status: 'ok',
      version: '1.0.0',
      health: { live: '/health/live', ready: '/health/ready' },
      api: { jobs: '/api/v1/jobs', uploads: '/api/v1/uploads' },
      documentation: '/docs',
      authentication: 'Bearer token required for /api/v1 and /docs',
    });
  });

  it('matches the generated repository document and includes required routes', () => {
    const generated = context.app.swagger();
    const checkedIn = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../openapi.json'), 'utf8')) as unknown;
    expect(generated).toEqual(checkedIn);
    expect(Object.keys(generated.paths ?? {})).toEqual(expect.arrayContaining([
      '/', '/api/v1/jobs', '/api/v1/jobs/youtube', '/api/v1/jobs/{id}', '/api/v1/jobs/{id}/results', '/api/v1/jobs/{id}/results/{format}',
      '/api/v1/jobs/{id}/pause', '/api/v1/jobs/{id}/resume',
      '/api/v1/uploads', '/api/v1/uploads/{uploadId}', '/api/v1/uploads/{uploadId}/parts/{index}', '/api/v1/uploads/{uploadId}/complete',
    ]));
  });
});

