import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { WorkerService } from '../../src/worker/service.js';
import { resolveInside, sourceRelativePath } from '../../src/shared/storage/paths.js';
import type { YoutubeDownloader } from '../../src/shared/youtube/downloader.js';
import type { TranscriptPolisher } from '../../src/shared/postprocess/interface.js';
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
    maxAttempts, model: 'base', origin: 'api',
  });
}

function worker(
  youtubeDownloader: YoutubeDownloader = { async download() { throw new Error('unexpected YouTube download'); } },
  polisher?: TranscriptPolisher,
) {
  return new WorkerService({
    config: context.config, repository: context.repository, provider: context.provider,
    ...(polisher ? { polisher } : {}), youtubeDownloader, workerId: 'test-worker', logger: pino({ level: 'silent' }),
  });
}

describe('worker', () => {
  it('validates, converts, transcribes, and atomically publishes all outputs', async () => {
    createJob('job-complete');
    const updateProgress = vi.spyOn(context.repository, 'updateProgress');
    expect(await worker().runOnce()).toBe(true);
    const completed = context.repository.getRequired('job-complete');
    expect(completed.status).toBe('completed');
    expect(completed.durationSeconds).toBeGreaterThan(0);
    for (const format of completed.requestedOutputFormats) {
      expect(fs.existsSync(resolveInside(context.directory, `${completed.resultBasePath}/transcript.${format}`))).toBe(true);
    }
    expect(updateProgress).toHaveBeenCalledWith('job-complete', expect.any(String), 'converting', 0, expect.any(Number), 'seconds');
    expect(updateProgress).toHaveBeenCalledWith('job-complete', expect.any(String), 'converting', expect.any(Number), expect.any(Number), 'seconds');
  });

  it('fails invalid media without retrying', async () => {
    createJob('job-invalid', Buffer.from('not-media'));
    await worker().runOnce();
    expect(context.repository.getRequired('job-invalid')).toMatchObject({ status: 'failed', errorCode: 'MEDIA_INVALID' });
  });

  it('downloads a queued YouTube source before the normal media pipeline', async () => {
    const id = 'job-youtube';
    context.repository.create({
      id, originalFilename: 'YouTube abc123xyz00', mediaType: 'application/x-youtube-url', fileSizeBytes: 0,
      sourcePath: sourceRelativePath(id), sourceType: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc123xyz00',
      language: 'auto', requestedOutputFormats: ['txt'], maxAttempts: 3, model: 'base', origin: 'web',
    });
    const downloader: YoutubeDownloader = {
      async download(_url, destinationPath, _signal, onProgress) {
        onProgress?.(25, 100);
        const data = makeWav();
        fs.writeFileSync(destinationPath, data);
        return { originalFilename: '테스트 영상.webm', mediaType: 'audio/webm', fileSizeBytes: data.length };
      },
    };

    const updateProgress = vi.spyOn(context.repository, 'updateProgress');
    let sourceTitle = '';
    const polisher: TranscriptPolisher = {
      name: 'fake-gpt',
      async polish(input) {
        sourceTitle = input.sourceTitle;
        return { model: 'gpt-test', transcript: input.transcript };
      },
    };
    expect(await worker(downloader, polisher).runOnce()).toBe(true);
    expect(updateProgress).toHaveBeenCalledWith(id, expect.any(String), 'fetching', 25, 100, 'bytes');
    expect(sourceTitle).toBe('테스트 영상.webm');
    expect(context.repository.getRequired(id)).toMatchObject({
      status: 'completed', originalFilename: '테스트 영상.webm', mediaType: 'audio/webm', sourceType: 'youtube',
    });
    expect(fs.existsSync(resolveInside(context.directory, sourceRelativePath(id)))).toBe(true);
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

  it('publishes GPT-polished outputs and preserves the raw Whisper outputs', async () => {
    createJob('job-polished');
    const polisher: TranscriptPolisher = {
      name: 'fake-gpt',
      async polish(input) {
        expect(input.sourceTitle).toBe('job-polished.wav');
        return {
          model: 'gpt-test',
          transcript: {
            ...input.transcript,
            text: '안녕하세요. World!',
            segments: input.transcript.segments.map((segment, index) => ({
              ...segment,
              text: index === 0 ? '안녕하세요.' : 'World!',
            })),
            postProcessingMetadata: { provider: 'fake-gpt', model: 'gpt-test', rawFilesPreserved: true },
          },
        };
      },
    };

    await worker(undefined, polisher).runOnce();
    const completed = context.repository.getRequired('job-polished');
    const resultDirectory = resolveInside(context.directory, completed.resultBasePath!);
    expect(fs.readFileSync(path.join(resultDirectory, 'transcript.txt'), 'utf8')).toBe('안녕하세요. World!\n');
    expect(fs.readFileSync(path.join(resultDirectory, 'transcript.raw.txt'), 'utf8')).toBe('안녕하세요 world\n');
    expect(JSON.parse(fs.readFileSync(path.join(resultDirectory, 'transcript.json'), 'utf8'))).toMatchObject({
      postProcessingMetadata: { provider: 'fake-gpt', model: 'gpt-test', rawFilesPreserved: true },
    });
    expect(completed.resultMetadata).toMatchObject({
      postProcessing: { status: 'completed', provider: 'fake-gpt', model: 'gpt-test', rawFilesPreserved: true },
    });
    for (const format of completed.requestedOutputFormats) {
      expect(fs.existsSync(path.join(resultDirectory, `transcript.raw.${format}`))).toBe(true);
    }
  });

  it('retries a transient GPT failure without publishing raw output as final', async () => {
    createJob('job-polish-retry');
    const polisher: TranscriptPolisher = {
      name: 'fake-gpt',
      async polish() { throw new AppError('GPT_UNAVAILABLE', 'GPT unavailable.', 503, true); },
    };
    await worker(undefined, polisher).runOnce();
    expect(context.repository.getRequired('job-polish-retry')).toMatchObject({
      status: 'queued', errorCode: 'GPT_UNAVAILABLE', resultBasePath: null,
    });
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

  it('cooperatively pauses active provider work and resumes from the beginning without spending an attempt', async () => {
    createJob('job-pause');
    context.provider.transcribe = async () => {
      context.repository.requestPause('job-pause');
      return context.provider.result;
    };
    await worker().runOnce();
    expect(context.repository.getRequired('job-pause')).toMatchObject({ status: 'paused', attempts: 0, resultBasePath: null });
    expect(context.repository.resumePaused('job-pause').status).toBe('queued');
    context.provider.transcribe = async () => context.provider.result;
    await worker().runOnce();
    expect(context.repository.getRequired('job-pause')).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('propagates an active pause to the provider abort signal', async () => {
    createJob('job-abort-pause');
    let providerAborted = false;
    context.provider.transcribe = async (input) => {
      context.repository.requestPause('job-abort-pause');
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      providerAborted = input.signal.aborted;
      throw new AppError('CANCELED', 'aborted');
    };
    await worker().runOnce();
    expect(providerAborted).toBe(true);
    expect(context.repository.getRequired('job-abort-pause')).toMatchObject({ status: 'paused', attempts: 0 });
  });
});

