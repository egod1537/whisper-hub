import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { WorkerService } from '../../src/worker/service.js';
import { resolveInside, sourceRelativePath } from '../../src/shared/storage/paths.js';
import type { TestContext } from '../helpers.js';
import { createTestContext, makeWav } from '../helpers.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => context.close());

function createJob(id: string, data = makeWav(), maxAttempts = 3) {
  const relative = sourceRelativePath(id);
  const source = resolveInside(context.directory, relative);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, data);
  return context.repository.create({
    id, originalFilename: `${id}.wav`, mediaType: 'audio/wav', fileSizeBytes: data.length,
    sourcePath: relative, language: 'auto', requestedOutputFormats: ['txt', 'srt', 'vtt', 'json'],
    maxAttempts, model: 'base',
  });
}

function worker() {
  return new WorkerService({
    config: context.config, repository: context.repository, provider: context.provider,
    workerId: 'test-worker', logger: pino({ level: 'silent' }),
  });
}

describe('worker', () => {
  it('validates, converts, transcribes, and atomically publishes all outputs', async () => {
    createJob('job-complete');
    expect(await worker().runOnce()).toBe(true);
    const completed = context.repository.getRequired('job-complete');
    expect(completed.status).toBe('completed');
    expect(completed.durationSeconds).toBeGreaterThan(0);
    for (const format of completed.requestedOutputFormats) {
      expect(fs.existsSync(resolveInside(context.directory, `${completed.resultBasePath}/transcript.${format}`))).toBe(true);
    }
  });

  it('fails invalid media without retrying', async () => {
    createJob('job-invalid', Buffer.from('not-media'));
    await worker().runOnce();
    expect(context.repository.getRequired('job-invalid')).toMatchObject({ status: 'failed', errorCode: 'MEDIA_INVALID' });
  });

  it('backs off retryable provider errors and does not publish partial results', async () => {
    createJob('job-retry');
    context.provider.error = new AppError('PROVIDER_UNAVAILABLE', 'Provider unavailable.', 503, true);
    await worker().runOnce();
    const retried = context.repository.getRequired('job-retry');
    expect(retried.status).toBe('queued');
    expect(retried.nextAttemptAt).not.toBeNull();
    expect(retried.resultBasePath).toBeNull();
  });

  it('does not complete when cancellation is requested while provider runs', async () => {
    createJob('job-cancel');
    context.provider.transcribe = async () => {
      context.repository.requestCancellation('job-cancel');
      return context.provider.result;
    };
    await worker().runOnce();
    expect(context.repository.getRequired('job-cancel').status).toBe('canceled');
  });
});

