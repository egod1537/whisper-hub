import fs from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../shared/config.js';
import type { TranscriptionProvider } from '../shared/providers/interface.js';
import type { JobRepository } from '../shared/queue/repository.js';

interface DiskStats {
  bsize: number;
  bavail: number;
  blocks: number;
}

interface MonitorIssue {
  key: string;
  message: string;
  details: Record<string, unknown>;
  immediate?: boolean;
}

interface IssueState {
  consecutive: number;
  active: boolean;
  lastAlertAt: number | null;
}

type MonitorConfig = Pick<Config,
  | 'dataDir'
  | 'monitorAlertRepeatMinutes'
  | 'monitorAlertWebhookUrl'
  | 'monitorDiskWarnPercent'
  | 'monitorFailureThreshold'
  | 'monitorHealthUrls'
  | 'monitorIntervalSeconds'
  | 'monitorMinFreeBytes'
  | 'monitorQueueWarnCount'
  | 'monitorWebhookTimeoutMs'
>;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class ProductionMonitor {
  private readonly states = new Map<string, IssueState>();
  private readonly seenFailedJobs = new Set<string>();
  private readonly fetchFn: typeof fetch;
  private readonly statfsFn: (path: string) => Promise<DiskStats>;
  private readonly now: () => Date;
  private lastCheckAt: Date | null = null;

  constructor(private readonly dependencies: {
    config: MonitorConfig;
    repository: JobRepository;
    provider: Pick<TranscriptionProvider, 'health'>;
    logger: FastifyBaseLogger;
    fetchFn?: typeof fetch;
    statfsFn?: (path: string) => Promise<DiskStats>;
    now?: () => Date;
    heartbeatPath?: string;
  }) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.statfsFn = dependencies.statfsFn ?? (async (target) => fs.promises.statfs(target));
    this.now = dependencies.now ?? (() => new Date());
  }

  async start(signal: AbortSignal): Promise<void> {
    const { config, logger } = this.dependencies;
    logger.info({ intervalSeconds: config.monitorIntervalSeconds }, 'production monitor started');
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        logger.error({ err: error }, 'production monitor check failed');
      }
      if (!signal.aborted) await delay(config.monitorIntervalSeconds * 1_000, signal);
    }
    logger.info('production monitor stopped');
  }

  async runOnce(): Promise<MonitorIssue[]> {
    const checkedAt = this.now();
    const since = this.lastCheckAt ?? new Date(checkedAt.getTime() - this.dependencies.config.monitorIntervalSeconds * 1_000);
    const issues = await this.collectIssues(since);
    this.lastCheckAt = checkedAt;
    await this.processIssues(issues, checkedAt);
    const heartbeatPath = this.dependencies.heartbeatPath;
    if (heartbeatPath) await fs.promises.writeFile(heartbeatPath, `${checkedAt.toISOString()}\n`, { mode: 0o600 });
    return issues;
  }

  private async collectIssues(since: Date): Promise<MonitorIssue[]> {
    const { config, repository, provider } = this.dependencies;
    const issues: MonitorIssue[] = [];
    const [providerReachable, disk] = await Promise.all([
      provider.health(AbortSignal.timeout(5_000)),
      this.statfsFn(config.dataDir),
    ]);

    if (!providerReachable) {
      issues.push({ key: 'whisper_provider', message: 'Whisper provider is unreachable.', details: {} });
    }
    const worker = repository.getWorkerFreshness();
    if (!worker.fresh) {
      issues.push({ key: 'worker_heartbeat', message: 'Worker heartbeat is stale.', details: { lastHeartbeatAt: worker.lastHeartbeatAt } });
    }

    const freeBytes = disk.bavail * disk.bsize;
    const totalBytes = disk.blocks * disk.bsize;
    const usedPercent = totalBytes > 0 ? (1 - freeBytes / totalBytes) * 100 : 100;
    if (usedPercent >= config.monitorDiskWarnPercent || freeBytes <= config.monitorMinFreeBytes) {
      issues.push({
        key: 'disk_pressure',
        message: 'Data filesystem is approaching its capacity limit.',
        details: { freeBytes, usedPercent: Number(usedPercent.toFixed(1)) },
      });
    }

    const counts = repository.counts();
    if (counts.queued >= config.monitorQueueWarnCount) {
      issues.push({
        key: 'queue_backlog',
        message: 'Transcription queue backlog exceeded the warning threshold.',
        details: { queued: counts.queued, threshold: config.monitorQueueWarnCount },
      });
    }

    const failedJobs = repository.list({ status: 'failed', limit: 50 })
      .filter((job) => Date.parse(job.updatedAt) >= since.getTime() && !this.seenFailedJobs.has(job.id));
    for (const job of failedJobs) {
      this.seenFailedJobs.add(job.id);
      issues.push({
        key: `failed_job:${job.id}`,
        message: 'A transcription job failed permanently.',
        details: { jobId: job.id, errorCode: job.errorCode },
        immediate: true,
      });
    }

    const healthResults = await Promise.all(config.monitorHealthUrls.map(async (url) => {
      try {
        const response = await this.fetchFn(url, { signal: AbortSignal.timeout(5_000) });
        return { url, ok: response.ok, status: response.status };
      } catch {
        return { url, ok: false, status: null };
      }
    }));
    for (const result of healthResults.filter((item) => !item.ok)) {
      issues.push({
        key: `health_url:${result.url}`,
        message: 'Configured public health endpoint is unavailable.',
        details: { url: result.url, status: result.status },
      });
    }
    return issues;
  }

  private async processIssues(issues: MonitorIssue[], checkedAt: Date): Promise<void> {
    const continuous = issues.filter((issue) => !issue.immediate);
    const currentKeys = new Set(continuous.map((issue) => issue.key));

    for (const issue of issues.filter((item) => item.immediate)) await this.emit('firing', issue, checkedAt);
    for (const issue of continuous) {
      const state = this.states.get(issue.key) ?? { consecutive: 0, active: false, lastAlertAt: null };
      state.consecutive += 1;
      const thresholdReached = state.consecutive >= this.dependencies.config.monitorFailureThreshold;
      const repeatMs = this.dependencies.config.monitorAlertRepeatMinutes * 60_000;
      const repeatDue = state.lastAlertAt === null || checkedAt.getTime() - state.lastAlertAt >= repeatMs;
      if (thresholdReached && (!state.active || repeatDue)) {
        await this.emit('firing', issue, checkedAt);
        state.active = true;
        state.lastAlertAt = checkedAt.getTime();
      }
      this.states.set(issue.key, state);
    }

    for (const [key, state] of this.states) {
      if (currentKeys.has(key)) continue;
      if (state.active) {
        await this.emit('resolved', { key, message: 'Production monitor condition recovered.', details: {} }, checkedAt);
      }
      this.states.delete(key);
    }
  }

  private async emit(status: 'firing' | 'resolved', issue: MonitorIssue, checkedAt: Date): Promise<void> {
    const { config, logger } = this.dependencies;
    const payload = {
      service: 'whisper-hub',
      status,
      key: issue.key,
      message: issue.message,
      details: issue.details,
      timestamp: checkedAt.toISOString(),
    };
    if (status === 'firing') logger.error({ alert: payload }, issue.message);
    else logger.info({ alert: payload }, issue.message);
    if (!config.monitorAlertWebhookUrl) return;
    try {
      const response = await this.fetchFn(config.monitorAlertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.monitorWebhookTimeoutMs),
      });
      if (!response.ok) logger.warn({ statusCode: response.status, alertKey: issue.key }, 'monitor alert webhook rejected delivery');
    } catch (error) {
      logger.warn({ err: error, alertKey: issue.key }, 'monitor alert webhook delivery failed');
    }
  }
}
