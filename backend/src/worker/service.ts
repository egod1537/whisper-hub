import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../shared/config.js';
import { AppError, safeError } from '../shared/errors.js';
import { renderJson } from '../shared/export/json.js';
import { renderSrt } from '../shared/export/srt.js';
import { renderTxt } from '../shared/export/txt.js';
import type { Transcript } from '../shared/export/types.js';
import { renderVtt } from '../shared/export/vtt.js';
import type { TranscriptionProvider } from '../shared/providers/interface.js';
import type { JobRepository } from '../shared/queue/repository.js';
import type { Job, OutputFormat } from '../shared/queue/types.js';
import { ensureStorage, removePath } from '../shared/storage/files.js';
import { resolveInside, resultRelativePath, tempRelativePath } from '../shared/storage/paths.js';
import { convertToWav, probeDuration } from './media.js';

const backoffSeconds = [10, 30, 60];

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function render(format: OutputFormat, transcript: Transcript): string {
  switch (format) {
    case 'txt': return renderTxt(transcript);
    case 'srt': return renderSrt(transcript);
    case 'vtt': return renderVtt(transcript);
    case 'json': return renderJson(transcript);
  }
}

export class WorkerService {
  private readonly active = new Set<Promise<void>>();
  private lastRecovery = 0;

  constructor(private readonly dependencies: {
    config: Config;
    repository: JobRepository;
    provider: TranscriptionProvider;
    workerId: string;
    logger: FastifyBaseLogger;
  }) {}

  async start(signal: AbortSignal): Promise<void> {
    const { config, repository, workerId, logger } = this.dependencies;
    ensureStorage(config.dataDir);
    await this.recover();
    repository.recordWorkerHeartbeat(workerId, null);
    logger.info({ workerId, concurrency: config.workerConcurrency }, 'worker started');
    while (!signal.aborted) {
      if (Date.now() - this.lastRecovery >= 30_000) await this.recover();
      repository.recordWorkerHeartbeat(workerId, null);
      while (!signal.aborted && this.active.size < config.workerConcurrency) {
        const job = repository.claim(workerId, config.jobLeaseSeconds);
        if (!job) break;
        const task = this.process(job, signal)
          .catch((error: unknown) => logger.error({ err: error, jobId: job.id }, 'unexpected worker task failure'))
          .finally(() => this.active.delete(task));
        this.active.add(task);
      }
      if (this.active.size >= config.workerConcurrency) {
        await Promise.race([...this.active, delay(config.workerPollMs, signal)]);
      } else {
        await delay(config.workerPollMs, signal);
      }
    }
    await Promise.allSettled(this.active);
    repository.recordWorkerHeartbeat(workerId, null);
    logger.info({ workerId }, 'worker stopped');
  }

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const { config, repository, workerId } = this.dependencies;
    const job = repository.claim(workerId, config.jobLeaseSeconds);
    if (!job) return false;
    await this.process(job, signal);
    return true;
  }

  private async recover(): Promise<void> {
    const { repository, config, logger } = this.dependencies;
    this.lastRecovery = Date.now();
    const recovered = repository.recoverExpired();
    for (const job of recovered) {
      const tempRoot = resolveInside(config.dataDir, '.tmp');
      const partials = await fs.promises.readdir(tempRoot).catch(() => []);
      for (const partial of partials.filter((name) => name.startsWith(`${job.id}-`))) {
        await removePath(resolveInside(tempRoot, partial));
      }
      await removePath(resolveInside(config.dataDir, resultRelativePath(job.id)));
      logger.warn({ jobId: job.id, status: job.status }, 'recovered expired job lease');
    }
  }

  private async process(job: Job, shutdownSignal: AbortSignal): Promise<void> {
    const { config, repository, provider, workerId, logger } = this.dependencies;
    const controller = new AbortController();
    const cancelFromShutdown = () => controller.abort();
    shutdownSignal.addEventListener('abort', cancelFromShutdown, { once: true });
    const heartbeatMs = Math.min(30_000, Math.max(5_000, Math.floor(config.jobLeaseSeconds * 1_000 / 3)));
    const heartbeat = setInterval(() => {
      const state = repository.heartbeat(job.id, workerId, config.jobLeaseSeconds);
      repository.recordWorkerHeartbeat(workerId, job.id);
      if (!state.renewed || state.cancelRequested) controller.abort();
    }, heartbeatMs);
    heartbeat.unref();
    const workRelative = tempRelativePath(job.id, 'work');
    const workDir = resolveInside(config.dataDir, workRelative);
    const wavPath = path.join(workDir, 'normalized.wav');
    try {
      repository.recordWorkerHeartbeat(workerId, job.id);
      await removePath(workDir);
      await fs.promises.mkdir(workDir, { recursive: true, mode: 0o700 });
      this.throwIfCanceled(job.id, controller.signal);
      const inputPath = resolveInside(config.dataDir, job.sourcePath);
      const duration = await probeDuration(inputPath, controller.signal);
      if (duration > config.maxDurationSeconds) {
        throw new AppError('DURATION_LIMIT_EXCEEDED', 'Media duration exceeds the configured limit.', 422);
      }
      repository.setDuration(job.id, workerId, duration);
      this.setPhase(job.id, 'converting');
      await convertToWav(inputPath, wavPath, {
        signal: controller.signal,
        timeoutMs: config.maxConversionSeconds * 1_000,
        maxOutputBytes: config.maxWavBytes,
      });
      this.throwIfCanceled(job.id, controller.signal);
      this.setPhase(job.id, 'transcribing');
      const transcript = await provider.transcribe({ wavPath, language: job.language, signal: controller.signal });
      if (transcript.text.length > 0 && transcript.segments.length === 0 && job.requestedOutputFormats.some((format) => format === 'srt' || format === 'vtt')) {
        throw new AppError('FORMAT_UNSUPPORTED', 'Provider did not return timestamps required for subtitle output.', 422);
      }
      this.throwIfCanceled(job.id, controller.signal);
      this.setPhase(job.id, 'exporting');
      const published = await this.publish(job, transcript);
      const completed = repository.complete(job.id, workerId, published.relativePath, {
        formats: job.requestedOutputFormats,
        languageDetected: transcript.languageDetected ?? null,
        provider: provider.name,
      });
      if (!completed) {
        const current = repository.get(job.id);
        if (current?.status !== 'completed') await removePath(published.absolutePath);
        if (current?.cancelRequested) repository.markCanceled(job.id, workerId);
        throw new AppError('CANCELED', 'Job cancellation requested.', 409);
      }
      logger.info({ jobId: job.id, status: 'completed', attempt: job.attempts }, 'job completed');
    } catch (error) {
      const current = repository.get(job.id);
      const normalized = current?.cancelRequested
        ? new AppError('CANCELED', 'Job cancellation requested.', 409)
        : shutdownSignal.aborted
          ? new AppError('PROVIDER_UNAVAILABLE', 'Worker shut down before the job finished.', 503, true)
          : controller.signal.aborted
            ? new AppError('PROVIDER_UNAVAILABLE', 'Worker lease could not be renewed.', 503, true)
            : safeError(error);
      const delaySeconds = backoffSeconds[Math.min(Math.max(job.attempts - 1, 0), backoffSeconds.length - 1)]!;
      const updated = repository.failOrRetry(job.id, workerId, normalized.code, normalized.message, normalized.retryable, delaySeconds);
      const level = updated.status === 'queued' ? 'warn' : 'error';
      logger[level]({ jobId: job.id, status: updated.status, attempt: job.attempts, errorCode: normalized.code }, 'job processing ended');
    } finally {
      clearInterval(heartbeat);
      shutdownSignal.removeEventListener('abort', cancelFromShutdown);
      await removePath(workDir);
      repository.recordWorkerHeartbeat(workerId, null);
    }
  }

  private throwIfCanceled(jobId: string, signal: AbortSignal): void {
    const job = this.dependencies.repository.getRequired(jobId);
    if (signal.aborted || job.cancelRequested || job.status !== 'processing') {
      throw new AppError('CANCELED', 'Job cancellation requested.', 409);
    }
  }

  private setPhase(jobId: string, phase: Job['phase'] & string): void {
    if (!this.dependencies.repository.updatePhase(jobId, this.dependencies.workerId, phase)) {
      throw new AppError('CANCELED', 'Job is no longer owned by this worker.', 409);
    }
    this.dependencies.logger.info({ jobId, status: 'processing', phase }, 'job phase changed');
  }

  private async publish(job: Job, transcript: Transcript): Promise<{ relativePath: string; absolutePath: string }> {
    const { config, repository } = this.dependencies;
    const stagingRelative = tempRelativePath(job.id, `result-${randomUUID()}`);
    const staging = resolveInside(config.dataDir, stagingRelative);
    const relativePath = resultRelativePath(job.id);
    const target = resolveInside(config.dataDir, relativePath);
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const format of job.requestedOutputFormats) {
        const file = path.join(staging, `transcript.${format}`);
        await fs.promises.writeFile(file, render(format, transcript), { mode: 0o600, flag: 'wx' });
      }
      this.throwIfCanceled(job.id, new AbortController().signal);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (fs.existsSync(target) && repository.getRequired(job.id).status !== 'completed') await removePath(target);
      await fs.promises.rename(staging, target);
      return { relativePath, absolutePath: target };
    } catch (error) {
      await removePath(staging);
      throw error;
    }
  }
}

