import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../helpers.js';
import { authHeaders, createTestContext, makeWav, multipart } from '../helpers.js';
import { resultRelativePath, resolveInside } from '../../src/shared/storage/paths.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => context.close());

async function upload(extra: Array<{ name: string; value: string }> = [], headers: Record<string, string> = {}) {
  const form = multipart([
    { name: 'file', value: makeWav(), filename: 'sample.wav', contentType: 'audio/wav' },
    ...extra,
  ]);
  return context.app.inject({
    method: 'POST', url: '/api/v1/jobs',
    headers: { ...authHeaders, ...headers, 'content-type': `multipart/form-data; boundary=${form.boundary}` },
    payload: form.body,
  });
}

describe('jobs API', () => {
  it('requires authorization and includes a request ID in errors', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.json().error).toMatchObject({ code: 'UNAUTHORIZED', requestId: response.headers['x-request-id'] });
  });

  it('streams an upload, queues it, and returns job detail', async () => {
    const response = await upload([{ name: 'language', value: 'ko' }, { name: 'formats', value: 'json,txt,srt' }]);
    expect(response.statusCode).toBe(202);
    const created = response.json();
    expect(created).toMatchObject({ status: 'queued', phase: null, queuePosition: 1 });
    const detail = await context.app.inject({ method: 'GET', url: created.links.self, headers: authHeaders });
    expect(detail.json()).toMatchObject({ id: created.id, language: 'ko', formats: ['txt', 'srt', 'json'] });
  });

  it('honors idempotency and rejects mismatches', async () => {
    const first = await upload([], { 'idempotency-key': 'same-key' });
    const second = await upload([], { 'idempotency-key': 'same-key' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const conflict = await upload([{ name: 'language', value: 'ko' }], { 'idempotency-key': 'same-key' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects unsupported media, fields, language, and duplicate formats', async () => {
    const form = multipart([{ name: 'file', value: Buffer.from('x'), filename: 'x.bin', contentType: 'application/octet-stream' }]);
    const unsupported = await context.app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...authHeaders, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.body });
    expect(unsupported.statusCode).toBe(415);
    expect((await upload([{ name: 'prompt', value: 'ignored' }])).statusCode).toBe(422);
    expect((await upload([{ name: 'language', value: 'not-a-language' }])).statusCode).toBe(422);
    expect((await upload([{ name: 'formats', value: 'txt,txt' }])).statusCode).toBe(422);
  });

  it('paginates stably and cancels a queued job', async () => {
    await upload(); await upload(); await upload();
    const first = await context.app.inject({ method: 'GET', url: '/api/v1/jobs?limit=2', headers: authHeaders });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    const next = await context.app.inject({ method: 'GET', url: `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: authHeaders });
    expect(next.json().items).toHaveLength(1);
    const id = first.json().items[0].id;
    const canceled = await context.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${id}`, headers: authHeaders });
    expect(canceled.statusCode).toBe(202);
    expect(canceled.json().status).toBe('canceled');
    expect((await context.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${id}`, headers: authHeaders })).statusCode).toBe(409);
  });

  it('returns result metadata and streams safe attachments only after completion', async () => {
    const created = await upload();
    const id = created.json().id;
    expect((await context.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/results`, headers: authHeaders })).statusCode).toBe(409);
    const claimed = context.repository.claim('test-worker', 60);
    expect(claimed?.id).toBe(id);
    const relative = resultRelativePath(id);
    const resultDir = resolveInside(context.directory, relative);
    fs.mkdirSync(resultDir, { recursive: true });
    for (const format of ['txt', 'srt', 'json']) fs.writeFileSync(path.join(resultDir, `transcript.${format}`), 'result');
    expect(context.repository.complete(id, 'test-worker', relative, { formats: ['txt', 'srt', 'json'] })).toBe(true);
    const results = await context.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/results`, headers: authHeaders });
    expect(results.json().availableFormats).toEqual(['txt', 'srt', 'json']);
    const download = await context.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/results/txt`, headers: authHeaders });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('result');
    expect(download.headers['content-disposition']).toContain('sample.txt');
  });
});

