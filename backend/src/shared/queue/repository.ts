import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/connection.js';
import { AppError } from '../errors.js';
import type { CreateJobInput, Job, JobPhase, JobStatus, ListJobsInput } from './types.js';

type Row = Record<string, string | number | bigint | Buffer | null>;

export interface RecoveredJob {
  job: Job;
  expiredLeaseOwner: string | null;
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function rowToJob(row: Row): Job {
  return {
    id: String(row.id),
    status: row.status as JobStatus,
    phase: (row.phase as JobPhase | null) ?? null,
    origin: row.origin as Job['origin'],
    createdAt: String(row.created_at),
    queueEnteredAt: String(row.queue_entered_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    originalFilename: String(row.original_filename),
    mediaType: String(row.media_type),
    fileSizeBytes: Number(row.file_size_bytes),
    sourcePath: String(row.source_path),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    language: String(row.language),
    requestedOutputFormats: parseJson<Job['requestedOutputFormats']>(row.requested_output_formats),
    provider: String(row.provider),
    model: row.model === null ? null : String(row.model),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    cancelRequested: Number(row.cancel_requested) === 1,
    pauseRequested: Number(row.pause_requested) === 1,
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    resultBasePath: row.result_base_path === null ? null : String(row.result_base_path),
    resultMetadata: row.result_metadata_json === null ? null : parseJson<Record<string, unknown>>(row.result_metadata_json),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    requestHash: row.request_hash === null ? null : String(row.request_hash),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    manualRetryCount: Number(row.manual_retry_count),
  };
}

export class JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateJobInput, now = new Date()): Job {
    const timestamp = nowIso(now);
    this.db.prepare(`
      INSERT INTO jobs (
        id, status, phase, origin, created_at, queue_entered_at, updated_at, original_filename, media_type,
        file_size_bytes, source_path, language, requested_output_formats, provider,
        model, max_attempts, idempotency_key, request_hash
      ) VALUES (?, 'queued', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whisper_cpp', ?, ?, ?, ?)
    `).run(
      input.id,
      input.origin,
      timestamp,
      timestamp,
      timestamp,
      input.originalFilename,
      input.mediaType,
      input.fileSizeBytes,
      input.sourcePath,
      input.language,
      JSON.stringify(input.requestedOutputFormats),
      input.model,
      input.maxAttempts,
      input.idempotencyKey ?? null,
      input.requestHash ?? null,
    );
    return this.getRequired(input.id);
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  getRequired(id: string): Job {
    const job = this.get(id);
    if (!job) throw new AppError('NOT_FOUND', 'Job not found.', 404);
    return job;
  }

  findByIdempotencyKey(key: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  list(input: ListJobsInput): Job[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.origin) {
      clauses.push('origin = ?');
      params.push(input.origin);
    }
    if (input.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, input.limit) as Row[];
    return rows.map(rowToJob);
  }

  queuePosition(id: string, now = new Date()): number | null {
    const job = this.get(id);
    const timestamp = nowIso(now);
    if (!job || job.status !== 'queued' || (job.nextAttemptAt !== null && job.nextAttemptAt > timestamp)) return null;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS ahead FROM jobs
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (queue_entered_at < ? OR (queue_entered_at = ? AND id < ?))
    `).get(timestamp, job.queueEnteredAt, job.queueEnteredAt, job.id) as { ahead: number };
    return Number(row.ahead) + 1;
  }

  claim(workerId: string, leaseSeconds: number, now = new Date()): Job | null {
    const claimOne = this.db.transaction(() => {
      const timestamp = nowIso(now);
      const leaseOwner = randomUUID();
      const row = this.db.prepare(`
        SELECT id FROM jobs
        WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY queue_entered_at ASC, id ASC LIMIT 1
      `).get(timestamp) as { id: string } | undefined;
      if (!row) return null;
      const leaseExpiresAt = nowIso(new Date(now.getTime() + leaseSeconds * 1_000));
      const changed = this.db.prepare(`
        UPDATE jobs SET status = 'processing', phase = 'validating', attempts = attempts + 1,
          started_at = COALESCE(started_at, ?), updated_at = ?, lease_owner = ?, lease_expires_at = ?,
          cancel_requested = 0, pause_requested = 0, next_attempt_at = NULL
        WHERE id = ? AND status = 'queued'
      `).run(timestamp, timestamp, leaseOwner, leaseExpiresAt, row.id);
      if (changed.changes !== 1) return null;
      const claimed = this.getRequired(row.id);
      this.db.prepare(`
        INSERT INTO job_attempts(job_id, attempt, started_at, worker_id) VALUES (?, ?, ?, ?)
      `).run(claimed.id, claimed.attempts, timestamp, workerId);
      return claimed;
    });
    return claimOne.immediate();
  }

  updatePhase(id: string, workerId: string, phase: JobPhase, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE jobs SET phase = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ? AND cancel_requested = 0 AND pause_requested = 0
    `).run(phase, nowIso(now), id, workerId).changes === 1;
  }

  setDuration(id: string, workerId: string, durationSeconds: number, now = new Date()): boolean {
    return this.db.prepare(`
      UPDATE jobs SET duration_seconds = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ? AND cancel_requested = 0 AND pause_requested = 0
    `).run(durationSeconds, nowIso(now), id, workerId).changes === 1;
  }

  heartbeat(id: string, leaseOwner: string, leaseSeconds: number, now = new Date()): { renewed: boolean; cancelRequested: boolean; pauseRequested: boolean } {
    const timestamp = nowIso(now);
    const expires = nowIso(new Date(now.getTime() + leaseSeconds * 1_000));
    const result = this.db.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('processing', 'pausing') AND lease_owner = ?
    `).run(expires, timestamp, id, leaseOwner);
    const row = this.db.prepare('SELECT cancel_requested,pause_requested FROM jobs WHERE id = ?').get(id) as { cancel_requested: number; pause_requested: number } | undefined;
    return { renewed: result.changes === 1, cancelRequested: row?.cancel_requested === 1, pauseRequested: row?.pause_requested === 1 };
  }

  recordWorkerHeartbeat(workerId: string, currentJobId: string | null, now = new Date()): void {
    this.db.prepare(`
      INSERT INTO worker_heartbeats(worker_id, updated_at, current_job_id) VALUES (?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET updated_at = excluded.updated_at, current_job_id = excluded.current_job_id
    `).run(workerId, nowIso(now), currentJobId);
  }

  getWorkerFreshness(now = new Date()): { lastHeartbeatAt: string | null; fresh: boolean } {
    const row = this.db.prepare('SELECT MAX(updated_at) AS updated_at FROM worker_heartbeats').get() as { updated_at: string | null };
    const lastHeartbeatAt = row.updated_at;
    return { lastHeartbeatAt, fresh: lastHeartbeatAt !== null && now.getTime() - Date.parse(lastHeartbeatAt) <= 60_000 };
  }

  requestCancellation(id: string, now = new Date()): Job {
    return this.db.transaction(() => {
      const job = this.getRequired(id);
      const timestamp = nowIso(now);
      if (job.status === 'canceled') return job;
      if (job.status === 'queued' || job.status === 'paused') {
        this.db.prepare(`
          UPDATE jobs SET status = 'canceled', phase = NULL, cancel_requested = 1, pause_requested = 0,
            completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL
          WHERE id = ? AND status IN ('queued', 'paused')
        `).run(timestamp, timestamp, id);
      } else if (job.status === 'processing' || job.status === 'pausing') {
        this.db.prepare(`UPDATE jobs SET cancel_requested = 1, pause_requested = 0, updated_at = ? WHERE id = ? AND status IN ('processing', 'pausing')`).run(timestamp, id);
      } else {
        throw new AppError('JOB_NOT_CANCELABLE', 'This job cannot be canceled.', 409);
      }
      return this.getRequired(id);
    }).immediate();
  }

  requestPause(id: string, now = new Date()): Job {
    return this.db.transaction(() => {
      const job = this.getRequired(id);
      const timestamp = nowIso(now);
      if (job.status === 'paused' || job.status === 'pausing') return job;
      if (job.status === 'queued') {
        const changed = this.db.prepare(`UPDATE jobs SET status='paused',phase=NULL,pause_requested=0,updated_at=?,next_attempt_at=NULL
          WHERE id=? AND status='queued'`).run(timestamp, id);
        if (changed.changes !== 1) throw new AppError('JOB_NOT_PAUSABLE', 'This job cannot be paused.', 409);
      } else if (job.status === 'processing') {
        const changed = this.db.prepare(`UPDATE jobs SET status='pausing',pause_requested=1,updated_at=?
          WHERE id=? AND status='processing' AND cancel_requested=0`).run(timestamp, id);
        if (changed.changes !== 1) throw new AppError('JOB_NOT_PAUSABLE', 'This job cannot be paused.', 409);
      } else {
        throw new AppError('JOB_NOT_PAUSABLE', 'This job cannot be paused.', 409);
      }
      return this.getRequired(id);
    }).immediate();
  }

  resumePaused(id: string, now = new Date()): Job {
    return this.db.transaction(() => {
      const job = this.getRequired(id);
      if (job.status !== 'paused') throw new AppError('JOB_NOT_RESUMABLE', 'This job cannot be resumed.', 409);
      const timestamp = nowIso(now);
      const changed = this.db.prepare(`UPDATE jobs SET status='queued',phase=NULL,queue_entered_at=?,updated_at=?,
        cancel_requested=0,pause_requested=0,error_code=NULL,error_message=NULL,next_attempt_at=NULL
        WHERE id=? AND status='paused'`).run(timestamp, timestamp, id);
      if (changed.changes !== 1) throw new AppError('JOB_NOT_RESUMABLE', 'This job cannot be resumed.', 409);
      return this.getRequired(id);
    }).immediate();
  }

  markCanceled(id: string, leaseOwner: string, now = new Date()): boolean {
    const timestamp = nowIso(now);
    const changed = this.db.prepare(`
      UPDATE jobs SET status = 'canceled', phase = NULL, completed_at = ?, updated_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, pause_requested = 0, error_code = NULL, error_message = NULL
      WHERE id = ? AND status IN ('processing', 'pausing') AND lease_owner = ?
    `).run(timestamp, timestamp, id, leaseOwner);
    if (changed.changes === 1) this.finishAttempt(id, 'canceled', null, null, timestamp);
    return changed.changes === 1;
  }

  markPaused(id: string, leaseOwner: string, now = new Date()): boolean {
    const timestamp = nowIso(now);
    const changed = this.db.prepare(`
      UPDATE jobs SET status='paused',phase=NULL,updated_at=?,lease_owner=NULL,lease_expires_at=NULL,
        pause_requested=0,cancel_requested=0,error_code=NULL,error_message=NULL,next_attempt_at=NULL,
        attempts=MAX(attempts - 1, 0)
      WHERE id=? AND status='pausing' AND lease_owner=? AND cancel_requested=0
    `).run(timestamp, id, leaseOwner);
    if (changed.changes === 1) this.finishAttempt(id, 'paused', null, null, timestamp);
    return changed.changes === 1;
  }

  complete(id: string, leaseOwner: string, resultBasePath: string, metadata: Record<string, unknown>, now = new Date()): boolean {
    const timestamp = nowIso(now);
    const changed = this.db.prepare(`
      UPDATE jobs SET status = 'completed', phase = NULL, completed_at = ?, updated_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, result_base_path = ?, result_metadata_json = ?,
        error_code = NULL, error_message = NULL
      WHERE id = ? AND status = 'processing' AND lease_owner = ? AND cancel_requested = 0 AND pause_requested = 0
    `).run(timestamp, timestamp, resultBasePath, JSON.stringify(metadata), id, leaseOwner);
    if (changed.changes === 1) this.finishAttempt(id, 'completed', null, null, timestamp);
    return changed.changes === 1;
  }

  failOrRetry(id: string, leaseOwner: string, code: string, message: string, retryable: boolean, backoffSeconds: number, now = new Date()): Job {
    return this.db.transaction(() => {
      const job = this.getRequired(id);
      if (!['processing', 'pausing'].includes(job.status) || job.leaseOwner !== leaseOwner) return job;
      const timestamp = nowIso(now);
      if (job.cancelRequested || code === 'CANCELED') {
        this.markCanceled(id, leaseOwner, now);
      } else if (job.pauseRequested || job.status === 'pausing' || code === 'PAUSE_REQUESTED') {
        this.markPaused(id, leaseOwner, now);
      } else if (retryable && job.attempts < job.maxAttempts) {
        const next = nowIso(new Date(now.getTime() + backoffSeconds * 1_000));
        this.db.prepare(`
          UPDATE jobs SET status = 'queued', phase = NULL, updated_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, error_code = ?, error_message = ?, next_attempt_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
        `).run(timestamp, code, message, next, id, leaseOwner);
        this.finishAttempt(id, 'retrying', code, message, timestamp);
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'failed', phase = NULL, completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, error_code = ?, error_message = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
        `).run(timestamp, timestamp, code, message, id, leaseOwner);
        this.finishAttempt(id, 'failed', code, message, timestamp);
      }
      return this.getRequired(id);
    }).immediate();
  }

  retryFailed(id: string, maxAttempts: number, maxManualRetries = 5, now = new Date()): Job {
    return this.db.transaction(() => {
      const job = this.getRequired(id);
      if (job.status !== 'failed' || job.manualRetryCount >= maxManualRetries) {
        throw new AppError('JOB_NOT_RETRYABLE', 'This job cannot be retried.', 409);
      }
      const changed = this.db.prepare(`
        UPDATE jobs SET status = 'queued', phase = NULL, queue_entered_at = ?, updated_at = ?, completed_at = NULL,
          attempts = 0, max_attempts = ?, lease_owner = NULL, lease_expires_at = NULL,
          cancel_requested = 0, pause_requested = 0, error_code = NULL, error_message = NULL, next_attempt_at = NULL,
          manual_retry_count = manual_retry_count + 1
        WHERE id = ? AND status = 'failed'
      `).run(nowIso(now), nowIso(now), maxAttempts, id);
      if (changed.changes !== 1) throw new AppError('JOB_NOT_RETRYABLE', 'This job cannot be retried.', 409);
      return this.getRequired(id);
    }).immediate();
  }

  recoverExpired(now = new Date()): RecoveredJob[] {
    return this.db.transaction(() => {
      const timestamp = nowIso(now);
      const expired = (this.db.prepare(`
        SELECT * FROM jobs WHERE status IN ('processing', 'pausing') AND lease_expires_at < ? ORDER BY queue_entered_at, id
      `).all(timestamp) as Row[]).map(rowToJob);
      for (const job of expired) {
        if (job.cancelRequested) {
          this.db.prepare(`
            UPDATE jobs SET status = 'canceled', phase = NULL, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = ? AND status IN ('processing', 'pausing')
          `).run(timestamp, timestamp, job.id);
          this.finishAttempt(job.id, 'canceled', null, null, timestamp);
        } else if (job.pauseRequested || job.status === 'pausing') {
          this.db.prepare(`
            UPDATE jobs SET status='paused',phase=NULL,updated_at=?,lease_owner=NULL,lease_expires_at=NULL,
              pause_requested=0,cancel_requested=0,attempts=MAX(attempts - 1, 0)
            WHERE id=? AND status='pausing'
          `).run(timestamp, job.id);
          this.finishAttempt(job.id, 'paused', null, null, timestamp);
        } else if (job.attempts < job.maxAttempts) {
          this.db.prepare(`
            UPDATE jobs SET status = 'queued', phase = NULL, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              error_code = 'WORKER_LEASE_EXPIRED', error_message = 'Worker stopped before the job finished.', next_attempt_at = ?
            WHERE id = ? AND status = 'processing'
          `).run(timestamp, timestamp, job.id);
          this.finishAttempt(job.id, 'lease_expired', 'WORKER_LEASE_EXPIRED', 'Worker stopped before the job finished.', timestamp);
        } else {
          this.db.prepare(`
            UPDATE jobs SET status = 'failed', phase = NULL, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              error_code = 'WORKER_LEASE_EXPIRED', error_message = 'Worker stopped before the job finished.'
            WHERE id = ? AND status = 'processing'
          `).run(timestamp, timestamp, job.id);
          this.finishAttempt(job.id, 'failed', 'WORKER_LEASE_EXPIRED', 'Worker stopped before the job finished.', timestamp);
        }
      }
      return expired.map((job) => ({ job: this.getRequired(job.id), expiredLeaseOwner: job.leaseOwner }));
    }).immediate();
  }

  counts(): { queued: number; processing: number; paused: number; origins: { web: number; api: number; unknown: number } } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'processing', 'pausing', 'paused') GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    const originRows = this.db.prepare('SELECT origin,COUNT(*) AS count FROM jobs GROUP BY origin').all() as Array<{ origin: string; count: number }>;
    return {
      queued: Number(rows.find((row) => row.status === 'queued')?.count ?? 0),
      processing: Number(rows.find((row) => row.status === 'processing')?.count ?? 0) + Number(rows.find((row) => row.status === 'pausing')?.count ?? 0),
      paused: Number(rows.find((row) => row.status === 'paused')?.count ?? 0),
      origins: {
        web: Number(originRows.find((row) => row.origin === 'web')?.count ?? 0),
        api: Number(originRows.find((row) => row.origin === 'api')?.count ?? 0),
        unknown: Number(originRows.find((row) => row.origin === 'unknown')?.count ?? 0),
      },
    };
  }

  private finishAttempt(id: string, outcome: string, code: string | null, message: string | null, endedAt: string): void {
    this.db.prepare(`
      UPDATE job_attempts SET ended_at = ?, outcome = ?, error_code = ?, error_message = ?
      WHERE id = (SELECT id FROM job_attempts WHERE job_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)
    `).run(endedAt, outcome, code, message, id);
  }
}
