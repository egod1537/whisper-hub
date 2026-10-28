import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { ContractError } from '../api/types';

const summary = {
  id: 'job-1', origin: 'api', status: 'processing', phase: 'converting', progress: { current: 30, total: 120, unit: 'seconds', percent: 25 }, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z',
  originalFilename: 'sample.wav', attempts: 0, queuePosition: null, error: null,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('ApiClient', () => {
  it('uses the trusted same-origin web route by default', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    await new ApiClient('', undefined, fetcher).listJobs({ origin: 'web' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/web-api/v1/jobs?limit=25&origin=web');
  });

  it('lets the same-origin proxy provide authorization', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [], nextCursor: null }));
    const client = new ApiClient('', '/api/v1', fetcher);
    await client.listJobs();

    const [, init] = fetcher.mock.calls[0]!;
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('sends bearer auth and parses the jobs contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [summary], nextCursor: null }));
    const client = new ApiClient('secret-key', '/api/v1', fetcher);
    const page = await client.listJobs({ limit: 25 });

    expect(page.items[0]?.originalFilename).toBe('sample.wav');
    expect(page.items[0]?.progress).toEqual({ current: 30, total: 120, unit: 'seconds', percent: 25 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/jobs?limit=25');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-key');
  });

  it('serializes upload fields and an idempotency key exactly once', async () => {
    let request: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      request = init;
      return json({
        id: 'new-job', origin: 'web', status: 'queued', phase: null, createdAt: '2026-10-28T10:00:00Z', queuePosition: 1,
        links: { self: '/api/v1/jobs/new-job', results: '/api/v1/jobs/new-job/results' },
      }, 202);
    });
    const client = new ApiClient('secret-key', '/api/v1', fetcher);
    await client.createJob({
      file: new File(['audio'], 'speech.wav', { type: 'audio/wav' }),
      language: 'ko', formats: ['txt', 'srt'], idempotencyKey: 'upload-key',
    });

    expect(new Headers(request?.headers).get('idempotency-key')).toBe('upload-key');
    const body = request?.body as FormData;
    expect(body.get('language')).toBe('ko');
    expect(body.get('formats')).toBe('txt,srt');
    expect((body.get('file') as File).name).toBe('speech.wav');
  });

  it('queues a YouTube URL as JSON with an idempotency key', async () => {
    let request: RequestInit | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      request = init;
      return json({
        id: 'youtube-job', origin: 'web', status: 'queued', phase: null, createdAt: '2026-10-28T10:00:00Z', queuePosition: 1,
        links: { self: '/api/v1/jobs/youtube-job', results: '/api/v1/jobs/youtube-job/results' },
      }, 202);
    });
    const client = new ApiClient('', '/web-api/v1', fetcher);
    await client.createYoutubeJob({
      url: 'https://youtu.be/abc123xyz00', language: 'auto', formats: ['txt', 'srt'], idempotencyKey: 'youtube-key',
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe('/web-api/v1/jobs/youtube');
    expect(new Headers(request?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('youtube-key');
    expect(JSON.parse(String(request?.body))).toEqual({ url: 'https://youtu.be/abc123xyz00', language: 'auto', formats: ['txt', 'srt'] });
  });

  it('maps API errors without exposing raw server text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      error: { code: 'UNAUTHORIZED', message: 'internal detail', requestId: 'req-test' },
    }, 401));
    const client = new ApiClient('wrong-key', '/api/v1', fetcher);

    await expect(client.listJobs()).rejects.toMatchObject({
      status: 401, code: 'UNAUTHORIZED', message: 'API 키가 올바르지 않습니다.', requestId: 'req-test',
    });
  });

  it('passes abort signals and rejects malformed JSON contracts', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      receivedSignal = init?.signal;
      return json({ items: [{ bad: true }], nextCursor: null });
    });
    const controller = new AbortController();
    const client = new ApiClient('secret-key', '/api/v1', fetcher);

    await expect(client.listJobs({ signal: controller.signal })).rejects.toBeInstanceOf(ContractError);
    expect(receivedSignal).toBe(controller.signal);
  });

  it('downloads an authenticated result with a safe filename', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('전사 결과', {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="result.txt"' },
    }));
    const client = new ApiClient('secret-key', '/api/v1', fetcher);
    const result = await client.downloadResult('opaque/id', 'txt', 'speech.wav');

    expect(result.filename).toBe('result.txt');
    expect(result.blob.size).toBeGreaterThan(0);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/jobs/opaque%2Fid/results/txt');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-key');
  });

  it('calls pause and resume mutation routes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(summary, 202));
    const client = new ApiClient('', '/api/v1', fetcher);
    await client.pauseJob('job-1');
    await client.resumeJob('job-1');
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/v1/jobs/job-1/pause', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/v1/jobs/job-1/resume', expect.objectContaining({ method: 'POST' }));
  });
});
