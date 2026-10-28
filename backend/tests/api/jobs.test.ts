import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../helpers.js';
import { authHeaders, createTestContext, makeWav, multipart, webHeaders } from '../helpers.js';
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
    expect(detail.json()).toMatchObject({ id: created.id, origin: 'api', language: 'ko', formats: ['txt', 'srt', 'json'] });
  });

  it('honors idempotency and rejects mismatches', async () => {
    const first = await upload([], { ...webHeaders, 'idempotency-key': 'same-key' });
    const second = await upload([], { 'idempotency-key': 'same-key' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().origin).toBe('web');
    const conflict = await upload([{ name: 'language', value: 'ko' }], { 'idempotency-key': 'same-key' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('queues canonical single-video YouTube links without downloading in the request', async () => {
    const first = await context.app.inject({
      method: 'POST', url: '/api/v1/jobs/youtube', headers: { ...webHeaders, 'idempotency-key': 'youtube-key' },
      payload: { url: 'https://youtu.be/abc123xyz00?si=tracking', language: 'ko', formats: ['json', 'txt'] },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ origin: 'web', status: 'queued', phase: null });
    const stored = context.repository.getRequired(first.json().id);
    expect(stored).toMatchObject({
      sourceType: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc123xyz00', fileSizeBytes: 0,
      language: 'ko', requestedOutputFormats: ['txt', 'json'],
    });
    expect(fs.existsSync(resolveInside(context.directory, stored.sourcePath))).toBe(false);

    const repeated = await context.app.inject({
      method: 'POST', url: '/api/v1/jobs/youtube', headers: { ...authHeaders, 'idempotency-key': 'youtube-key' },
      payload: { url: 'https://www.youtube.com/watch?v=abc123xyz00', language: 'ko', formats: ['txt', 'json'] },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().id).toBe(first.json().id);
    expect(repeated.json().origin).toBe('web');
  });

  it('rejects non-YouTube, playlist-only, and insecure YouTube URLs', async () => {
    for (const url of ['https://example.com/watch?v=abc123xyz00', 'https://www.youtube.com/playlist?list=PL123', 'http://youtu.be/abc123xyz00']) {
      const response = await context.app.inject({ method: 'POST', url: '/api/v1/jobs/youtube', headers: authHeaders, payload: { url, language: 'auto', formats: ['txt'] } });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('YOUTUBE_INVALID_URL');
    }
  });

  it('rejects unsupported media, fields, language, and duplicate formats', async () => {
    const form = multipart([{ name: 'file', value: Buffer.from('x'), filename: 'x.bin', contentType: 'application/octet-stream' }]);
    const unsupported = await context.app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...authHeaders, 'content-type': `multipart/form-data; boundary=${form.boundary}` }, payload: form.body });
    expect(unsupported.statusCode).toBe(415);
    expect((await upload([{ name: 'prompt', value: 'ignored' }])).statusCode).toBe(422);
    expect((await upload([{ name: 'origin', value: 'web' }])).statusCode).toBe(400);
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
    expect((await context.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${id}`, headers: authHeaders })).statusCode).toBe(202);
  });

  it('derives origin from the trusted proxy token and filters without allowing spoofing', async () => {
    const direct = await upload();
    const forged = await upload([], { 'x-whisper-hub-origin': 'web', 'x-whisper-hub-web-token': 'wrong-token-that-is-long-enough-to-look-real' });
    const web = await upload([], webHeaders);
    const secondWeb = await upload([], webHeaders);
    expect(direct.json().origin).toBe('api');
    expect(forged.json().origin).toBe('api');
    expect(web.json().origin).toBe('web');

    const webList = await context.app.inject({ method: 'GET', url: '/api/v1/jobs?origin=web&limit=1', headers: authHeaders });
    expect(webList.json().items).toHaveLength(1);
    expect(webList.json().nextCursor).toEqual(expect.any(String));
    const webNext = await context.app.inject({
      method: 'GET', url: `/api/v1/jobs?origin=web&limit=1&cursor=${encodeURIComponent(webList.json().nextCursor)}`, headers: authHeaders,
    });
    expect([webList.json().items[0].id, webNext.json().items[0].id].sort()).toEqual([web.json().id, secondWeb.json().id].sort());
    expect(webNext.json().nextCursor).toBeNull();
    const apiList = await context.app.inject({ method: 'GET', url: '/api/v1/jobs?origin=api', headers: authHeaders });
    const apiItems = apiList.json<{ items: Array<{ origin: string }> }>().items;
    expect(apiItems).toHaveLength(2);
    expect(apiItems.every((job) => job.origin === 'api')).toBe(true);

    const status = await context.app.inject({ method: 'GET', url: '/api/v1/system/status', headers: authHeaders });
    expect(status.json().jobs.origins).toEqual({ web: 2, api: 2, unknown: 0 });
    expect((await context.app.inject({ method: 'POST', url: '/web-api/v1/jobs', headers: webHeaders })).statusCode).toBe(404);
  });

  it('pauses, resumes at a new queue position, and permanently cancels', async () => {
    const first = await upload();
    const second = await upload();
    const paused = await context.app.inject({ method: 'POST', url: `/api/v1/jobs/${first.json().id}/pause`, headers: authHeaders });
    expect(paused.statusCode).toBe(202);
    expect(paused.json()).toMatchObject({ status: 'paused', queuePosition: null });
    expect(context.repository.claim('worker', 60)?.id).toBe(second.json().id);

    const resumed = await context.app.inject({ method: 'POST', url: `/api/v1/jobs/${first.json().id}/resume`, headers: authHeaders });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({ status: 'queued', queuePosition: 1 });
    const canceled = await context.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${first.json().id}`, headers: authHeaders });
    expect(canceled.json().status).toBe('canceled');
    expect((await context.app.inject({ method: 'POST', url: `/api/v1/jobs/${first.json().id}/resume`, headers: authHeaders })).statusCode).toBe(409);
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
    expect(context.repository.complete(id, claimed!.leaseOwner!, relative, { formats: ['txt', 'srt', 'json'] })).toBe(true);
    const results = await context.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/results`, headers: authHeaders });
    expect(results.json().availableFormats).toEqual(['txt', 'srt', 'json']);
    const download = await context.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/results/txt`, headers: authHeaders });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('result');
    expect(download.headers['content-disposition']).toContain('sample.txt');
  });
});

