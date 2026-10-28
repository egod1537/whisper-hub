import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, uploadResumableFile } from './upload-resumable.mjs';

test('parses safe CLI options without putting the API key in arguments', () => {
  const parsed = parseArguments(['/tmp/input.wav', '--language', 'ko', '--formats', 'txt,srt', '--concurrency', '2'], {
    WHISPER_HUB_URL: 'https://api.example.test/', WHISPER_HUB_API_KEY: 'secret',
  });
  assert.equal(parsed.baseUrl, 'https://api.example.test');
  assert.equal(parsed.apiKey, 'secret');
  assert.equal(parsed.language, 'ko');
  assert.deepEqual(parsed.formats, ['txt', 'srt']);
  assert.equal(parsed.concurrency, 2);
});

test('uploads missing chunks, completes assembly, and returns the queued job', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-upload-client-'));
  const filePath = path.join(directory, 'sample.wav');
  fs.writeFileSync(filePath, '0123456789');
  const received = new Set([1]);
  const progress = [];
  let finalized = false;
  let active = 0;
  let peak = 0;
  const fetchFn = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    assert.equal(init.headers.authorization, 'Bearer secret');
    if (pathname === '/api/v1/uploads' && init.method === 'POST') {
      assert.equal(init.headers['idempotency-key'].startsWith('cli-'), true);
      return Response.json({ uploadId: 'upload-1', chunkSizeBytes: 4, totalChunks: 3, expiresAt: new Date().toISOString(), status: 'uploading' }, { status: 201 });
    }
    if (pathname === '/api/v1/uploads/upload-1' && !init.method) {
      return Response.json({
        uploadId: 'upload-1', status: finalized ? 'completed' : 'uploading', sizeBytes: 10, chunkSizeBytes: 4, totalChunks: 3,
        receivedParts: [...received], receivedBytes: [...received].reduce((sum, index) => sum + (index === 2 ? 2 : 4), 0),
        assembledBytes: finalized ? 10 : 0, expiresAt: new Date().toISOString(), jobId: finalized ? 'job-1' : null, error: null,
      });
    }
    if (/\/parts\/\d$/.test(pathname) && init.method === 'PUT') {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const index = Number(pathname.at(-1));
      const body = Buffer.from(init.body);
      assert.equal(body.length, Number(init.headers['content-length']));
      const digest = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
      assert.equal(init.headers['x-chunk-sha256'], digest);
      received.add(index);
      active -= 1;
      return Response.json({ index, status: 'stored' }, { status: 201 });
    }
    if (pathname.endsWith('/complete') && init.method === 'POST') {
      finalized = true;
      return Response.json({ uploadId: 'upload-1', status: 'finalizing', jobId: null, jobUrl: null }, { status: 202 });
    }
    if (pathname === '/api/v1/jobs/job-1') {
      return Response.json({ id: 'job-1', status: 'queued', queuePosition: 1 });
    }
    throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${pathname}`);
  };
  try {
    const result = await uploadResumableFile({
      filePath, language: 'auto', formats: ['txt'], concurrency: 3, apiKey: 'secret', baseUrl: 'https://api.example.test',
    }, { fetchFn, onProgress: (value) => progress.push(value) });
    assert.deepEqual([...received].sort(), [0, 1, 2]);
    assert.equal(peak, 2);
    assert.equal(result.job.id, 'job-1');
    assert.equal(progress.at(-1).completedBytes, 10);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
