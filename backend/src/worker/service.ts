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
import { ensureStorage, moveUploadIntoPlace, removePath } from '../shared/storage/files.js';
import { resolveInside, resultRelativePath, tempRelativePath } from '../shared/storage/paths.js';
import type { YoutubeDownloader } from '../shared/youtube/downloader.js';
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
    youtubeDownloader: YoutubeDownloader;
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
    for (const { job, expiredLeaseOwner } of recovered) {
      if (expiredLeaseOwner) {
        const tempRoot = resolveInside(config.dataDir, '.tmp');
        const partials = await fs.promises.readdir(tempRoot).catch(() => []);
        for (const partial of partials.filter((name) => name.startsWith(`${job.id}-${expiredLeaseOwner}-`))) {
          await removePath(resolveInside(tempRoot, partial));
        }
        await removePath(resolveInside(config.dataDir, resultRelativePath(job.id, expiredLeaseOwner)));
      }
      logger.warn({ jobId: job.id, status: job.status }, 'recovered expired job lease');
    }
  }

  private async process(job: Job, shutdownSignal: AbortSignal): Promise<void> {
    const { config, repository, provider, youtubeDownloader, workerId, logger } = this.dependencies;
    const leaseOwner = job.leaseOwner;
    if (!leaseOwner) throw new AppError('WORKER_LEASE_LOST', 'Claimed job has no lease owner.', 503, true);
    const controller = new AbortController();
    const cancelFromShutdown = () => controller.abort();
    shutdownSignal.addEventListener('abort', cancelFromShutdown, { once: true });
    const heartbeatMs = Math.max(250, Math.min(1_000, Math.floor(config.jobLeaseSeconds * 1_000 / 3)));
    const heartbeat = setInterval(() => {
      const state = repository.heartbeat(job.id, leaseOwner, config.jobLeaseSeconds);
      repository.recordWorkerHeartbeat(workerId, job.id);
      if (!state.renewed || state.cancelRequested || state.pauseRequested) controller.abort();
    }, heartbeatMs);
    heartbeat.unref();
    const workRelative = tempRelativePath(job.id, `${leaseOwner}-work`);
    const workDir = resolveInside(config.dataDir, workRelative);
    const wavPath = path.join(workDir, 'normalized.wav');
    try {
      repository.recordWorkerHeartbeat(workerId, job.id);
      await removePath(workDir);
      await fs.promises.mkdir(workDir, { recursive: true, mode: 0o700 });
      this.throwIfInterrupted(job.id, leaseOwner, controller.signal);
      let currentJob = job;
      const inputPath = resolveInside(config.dataDir, job.sourcePath);
      if (job.sourceType === 'youtube' && job.fileSizeBytes === 0) {
        if (!job.sourceUrl) throw new AppError('YOUTUBE_INVALID_URL', 'YouTube source URL is missing.', 422);
        this.setPhase(job.id, leaseOwner, 'fetching');
        const downloadedPath = path.join(workDir, 'youtube-source');
        const downloaded = await youtubeDownloader.download(job.sourceUrl, downloadedPath, controller.signal, (current, total) => {
          repository.updateProgress(job.id, leaseOwner, 'fetching', current, total, 'bytes');
        });
        this.throwIfInterrupted(job.id, leaseOwner, controller.signal);
        await moveUploadIntoPlace(config.dataDir, downloadedPath, job.sourcePath);
        if (!repository.updateSourceMetadata(job.id, leaseOwner, downloaded)) {
          this.throwIfInterrupted(job.id, leaseOwner, controller.signal);
          throw new AppError('WORKER_LEASE_LOST', 'Job is no longer owned by this worker.', 503, true);
        }
        currentJob = repository.getRequired(job.id);
      }
      this.setPhase(job.id, leaseOwner, 'validating');
      const duration = await probeDuration(inputPath, controller.signal);
      if (duration > config.maxDurationSeconds) {
        throw new AppError('DURATION_LIMIT_EXCEEDED', 'Media duration exceeds the configured limit.', 422);
      }
      repository.setDuration(job.id, leaseOwner, duration);
      this.setPhase(job.id, leaseOwner, 'converting');
      repository.updateProgress(job.id, leaseOwner, 'converting', 0, duration, 'seconds');
      await convertToWav(inputPath, wavPath, {
        signal: controller.signal,
        timeoutMs: config.maxConversionSeconds * 1_000,
        maxOutputBytes: config.maxWavBytes,
        durationSeconds: duration,
        onProgress: (current, total) => {
          repository.updateProgress(job.id, leaseOwner, 'converting', current, total, 'seconds');
        },
      });
      this.throwIfInterrupted(job.id, leaseOwner, controller.signal);
      this.setPhase(job.id, leaseOwner, 'transcribing');
      const transcript = await provider.transcribe({ wavPath, language: currentJob.language, signal: controller.signal });
      if (transcript.text.length > 0 && transcript.segments.length === 0 && currentJob.requestedOutputFormats.some((format) => format === 'srt' || format === 'vtt')) {
        throw new AppError('FORMAT_UNSUPPORTED', 'Provider did not return timestamps required for subtitle output.', 422);
      }
      this.throwIfInterrupted(job.id, leaseOwner, controller.signal);
      this.setPhase(job.id, leaseOwner, 'exporting');
      const published = await this.publish(currentJob, leaseOwner, transcript);
      const completed = repository.complete(job.id, leaseOwner, published.relativePath, {
        formats: currentJob.requestedOutputFormats,
        languageDetected: transcript.languageDetected ?? null,
        provider: provider.name,
      });
      if (!completed) {
        const current = repository.get(job.id);
        if (current?.status !== 'completed') await removePath(published.absolutePath);
        if (current?.cancelRequested) repository.markCanceled(job.id, leaseOwner);
        else if (current?.pauseRequested || current?.status === 'pausing') repository.markPaused(job.id, leaseOwner);
        throw new AppError('WORKER_LEASE_LOST', 'Job is no longer owned by this worker.', 409);
      }
      logger.info({ jobId: job.id, status: 'completed', attempt: job.attempts }, 'job completed');
    } catch (error) {
      const current = repository.get(job.id);
      const normalized = current?.cancelRequested || current?.status === 'canceled'
        ? new AppError('CANCELED', 'Job cancellation requested.', 409)
        : current?.pauseRequested || current?.status === 'pausing' || current?.status === 'paused'
          ? new AppError('PAUSE_REQUESTED', 'Job pause requested.', 409)
        : shutdownSignal.aborted
          ? new AppError('PROVIDER_UNAVAILABLE', 'Worker shut down before the job finished.', 503, true)
          : controller.signal.aborted
            ? new AppError('PROVIDER_UNAVAILABLE', 'Worker lease could not be renewed.', 503, true)
            : safeError(error);
      const delaySeconds = backoffSeconds[Math.min(Math.max(job.attempts - 1, 0), backoffSeconds.length - 1)]!;
      const updated = repository.failOrRetry(job.id, leaseOwner, normalized.code, normalized.message, normalized.retryable, delaySeconds);
      const level = updated.status === 'queued' || updated.status === 'paused' ? 'warn' : 'error';
      logger[level]({ jobId: job.id, status: updated.status, attempt: job.attempts, errorCode: normalized.code }, 'job processing ended');
    } finally {
      clearInterval(heartbeat);
      shutdownSignal.removeEventListener('abort', cancelFromShutdown);
      await removePath(workDir);
      repository.recordWorkerHeartbeat(workerId, null);
    }
  }

  private throwIfInterrupted(jobId: string, leaseOwner: string, signal: AbortSignal): void {
    const job = this.dependencies.repository.getRequired(jobId);
    if (job.cancelRequested || job.status === 'canceled') {
      throw new AppError('CANCELED', 'Job cancellation requested.', 409);
    }
    if (job.pauseRequested || job.status === 'pausing' || job.status === 'paused') {
      throw new AppError('PAUSE_REQUESTED', 'Job pause requested.', 409);
    }
    if (signal.aborted || job.status !== 'processing' || job.leaseOwner !== leaseOwner) {
      throw new AppError('WORKER_LEASE_LOST', 'Job is no longer owned by this worker.', 503, true);
    }
  }

  private setPhase(jobId: string, leaseOwner: string, phase: Job['phase'] & string): void {
    if (!this.dependencies.repository.updatePhase(jobId, leaseOwner, phase)) {
      this.throwIfInterrupted(jobId, leaseOwner, new AbortController().signal);
      throw new AppError('WORKER_LEASE_LOST', 'Job is no longer owned by this worker.', 503, true);
    }
    this.dependencies.logger.info({ jobId, status: 'processing', phase }, 'job phase changed');
  }

  private async publish(job: Job, leaseOwner: string, transcript: Transcript): Promise<{ relativePath: string; absolutePath: string }> {
    const { config } = this.dependencies;
    const stagingRelative = tempRelativePath(job.id, `${leaseOwner}-result-${randomUUID()}`);
    const staging = resolveInside(config.dataDir, stagingRelative);
    // Each lease publishes into its own directory. A stale worker can therefore
    // only remove its own output if the fenced DB completion loses a race.
    const relativePath = resultRelativePath(job.id, leaseOwner);
    const target = resolveInside(config.dataDir, relativePath);
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const format of job.requestedOutputFormats) {
        const file = path.join(staging, `transcript.${format}`);
        await fs.promises.writeFile(file, render(format, transcript), { mode: 0o600, flag: 'wx' });
      }
      this.throwIfInterrupted(job.id, leaseOwner, new AbortController().signal);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.promises.rename(staging, target);
      return { relativePath, absolutePath: target };
    } catch (error) {
      await removePath(staging);
      throw error;
    }
  }
}

