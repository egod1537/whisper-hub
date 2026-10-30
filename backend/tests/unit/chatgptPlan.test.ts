import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptPlanTranscriptPolisher } from '../../src/shared/postprocess/chatgptPlan.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function credentialsFile(now: number, expired = false): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-hub-chatgpt-'));
  directories.push(directory);
  const file = path.join(directory, 'chatgpt-plan.json');
  fs.writeFileSync(file, JSON.stringify({
    email: 'test@example.com',
    client_id: 'client-id',
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    expires_in: 3_600,
    earliest_refresh_at: Math.floor((now - 1_000) / 1_000),
    scopes: ['chatgpt.tokens.use.direct'],
    saved_at: new Date(expired ? now - 3_700_000 : now).toISOString(),
  }), { mode: 0o600 });
  return file;
}

function sse(value: unknown): Response {
  const output = JSON.stringify(value);
  const events = [
    { type: 'response.output_text.delta', delta: output },
    { type: 'response.completed', response: { output: [] } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function polisher(file: string, fetchFn: typeof fetch, now: number) {
  return new ChatGptPlanTranscriptPolisher({
    credentialsPath: file,
    model: 'gpt-test',
    timeoutMs: 10_000,
    chunkChars: 20_000,
    fetchFn,
    now: () => now,
  });
}

describe('ChatGPT plan transcript polishing', () => {
  it('polishes text while preserving timestamps and transcript metadata', async () => {
    const now = Date.now();
    const file = credentialsFile(now);
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(init?.body as string);
      expect(request.store).toBe(false);
      expect(request.stream).toBe(true);
      expect(request.text.format.type).toBe('json_schema');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer access-old' });
      return sse({ segments: [{ index: 0, text: '안녕하세요.' }, { index: 1, text: '월드!' }] });
    });

    const result = await polisher(file, fetchFn, now).polish({
      language: 'ko',
      signal: new AbortController().signal,
      transcript: {
        text: '안녕하세요 world',
        languageDetected: 'ko',
        providerMetadata: { duration: 1 },
        segments: [
          { startMs: 0, endMs: 500, text: '안녕하세요' },
          { startMs: 500, endMs: 1_000, text: 'world' },
        ],
      },
    });

    expect(result.model).toBe('gpt-test');
    expect(result.transcript).toMatchObject({
      text: '안녕하세요. 월드!',
      languageDetected: 'ko',
      providerMetadata: { duration: 1 },
      segments: [
        { startMs: 0, endMs: 500, text: '안녕하세요.' },
        { startMs: 500, endMs: 1_000, text: '월드!' },
      ],
      postProcessingMetadata: { provider: 'chatgpt_plan', model: 'gpt-test', rawFilesPreserved: true },
    });
  });

  it('rotates expired credentials without sending scope and persists the replacement refresh token', async () => {
    const now = Date.now();
    const file = credentialsFile(now, true);
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes('/oauth/token')) {
        const form = new URLSearchParams(init?.body as string);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('refresh-old');
        expect(form.has('scope')).toBe(false);
        return Response.json({
          access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3_600, scope: 'chatgpt.tokens.use.direct',
        });
      }
      expect(init?.headers).toMatchObject({ authorization: 'Bearer access-new' });
      return sse({ segments: [{ index: 0, text: '교정됨.' }] });
    });

    await polisher(file, fetchFn, now).polish({
      language: 'ko', signal: new AbortController().signal,
      transcript: { text: '교정됨', segments: [{ startMs: 0, endMs: 100, text: '교정됨' }] },
    });

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ access_token: 'access-new', refresh_token: 'refresh-new', scopes: ['chatgpt.tokens.use.direct'] });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('rejects a response that drops transcript segments', async () => {
    const now = Date.now();
    const file = credentialsFile(now);
    const fetchFn = vi.fn<typeof fetch>(async () => sse({ segments: [] }));
    await expect(polisher(file, fetchFn, now).polish({
      language: 'ko', signal: new AbortController().signal,
      transcript: { text: '원문', segments: [{ startMs: 0, endMs: 100, text: '원문' }] },
    })).rejects.toMatchObject({ code: 'GPT_INVALID_RESPONSE', retryable: true });
  });
});
