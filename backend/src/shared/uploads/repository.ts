import type { SqliteDatabase } from '../db/connection.js';
import { AppError } from '../errors.js';
import type { JobOrigin, OutputFormat } from '../queue/types.js';
import type { UploadPart, UploadSession, UploadStatus, UploadStatusView } from './types.js';

type Row = Record<string, string | number | bigint | Buffer | null>;
const nowIso = (now = new Date()) => now.toISOString();

function rowToSession(row: Row): UploadSession {
  return {
    id: String(row.id), status: row.status as UploadStatus, origin: row.origin as JobOrigin, displayFilename: String(row.display_filename),
    totalSizeBytes: Number(row.total_size_bytes), expectedSha256: row.expected_sha256 === null ? null : String(row.expected_sha256),
    computedSha256: row.computed_sha256 === null ? null : String(row.computed_sha256), language: String(row.language),
    formats: JSON.parse(String(row.formats_json)) as OutputFormat[], chunkSizeBytes: Number(row.chunk_size_bytes),
    totalChunks: Number(row.total_chunks), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at), jobId: row.job_id === null ? null : String(row.job_id),
    finalizeOwner: row.finalize_owner === null ? null : String(row.finalize_owner),
    finalizeLeaseExpiresAt: row.finalize_lease_expires_at === null ? null : String(row.finalize_lease_expires_at),
    assembledBytes: Number(row.assembled_bytes),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
  };
}

function rowToPart(row: Row): UploadPart {
  return { uploadId: String(row.upload_id), index: Number(row.idx), bytes: Number(row.bytes), sha256: String(row.sha256), relativePath: String(row.relative_path), storedAt: String(row.stored_at) };
}

export interface CreateUploadInput {
  id: string; displayFilename: string; totalSizeBytes: number; expectedSha256: string | null; language: string;
  formats: OutputFormat[]; chunkSizeBytes: number; totalChunks: number; expiresAt: string;
  idempotencyKey: string | null; requestHash: string; origin: JobOrigin;
}

export class UploadRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateUploadInput, maxActive: number, now = new Date()): { session: UploadSession; replay: boolean } {
    return this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.db.prepare('SELECT * FROM upload_sessions WHERE create_idempotency_key = ?').get(input.idempotencyKey) as Row | undefined;
        if (existing) {
          if (String(existing.create_request_hash) !== input.requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different upload metadata.', 409);
          return { session: rowToSession(existing), replay: true };
        }
      }
      const timestamp = nowIso(now);
      this.db.prepare("UPDATE upload_sessions SET status='expired',updated_at=? WHERE status='uploading' AND expires_at <= ?").run(timestamp, timestamp);
      const active = this.db.prepare("SELECT COUNT(*) count FROM upload_sessions WHERE status IN ('uploading','finalizing')").get() as { count: number };
      if (Number(active.count) >= maxActive) throw new AppError('UPLOAD_LIMIT_REACHED', 'Too many active upload sessions.', 429, true);
      this.db.prepare(`INSERT INTO upload_sessions (
        id,status,origin,display_filename,total_size_bytes,expected_sha256,language,formats_json,chunk_size_bytes,total_chunks,
        created_at,updated_at,expires_at,create_idempotency_key,create_request_hash
      ) VALUES (?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.origin, input.displayFilename, input.totalSizeBytes, input.expectedSha256, input.language, JSON.stringify(input.formats),
          input.chunkSizeBytes, input.totalChunks, timestamp, timestamp, input.expiresAt, input.idempotencyKey, input.requestHash);
      return { session: this.getRequired(input.id), replay: false };
    }).immediate();
  }

  get(id: string): UploadSession | null {
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  getRequired(id: string): UploadSession {
    const session = this.get(id);
    if (!session) throw new AppError('UPLOAD_NOT_FOUND', 'Upload session not found.', 404);
    return session;
  }

  markExpiredIfNeeded(id: string, now = new Date()): UploadSession {
    const timestamp = nowIso(now);
    this.db.prepare(`UPDATE upload_sessions SET status='expired', updated_at=?, finalize_owner=NULL, finalize_lease_expires_at=NULL
      WHERE id=? AND status='uploading' AND expires_at <= ?`).run(timestamp, id, timestamp);
    return this.getRequired(id);
  }

  parts(id: string): UploadPart[] {
    return (this.db.prepare('SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY idx').all(id) as Row[]).map(rowToPart);
  }

  statusView(id: string, now = new Date()): UploadStatusView {
    const session = this.markExpiredIfNeeded(id, now);
    const parts = this.parts(id);
    return {
      uploadId: id, status: session.status, sizeBytes: session.totalSizeBytes, chunkSizeBytes: session.chunkSizeBytes,
      totalChunks: session.totalChunks, receivedParts: parts.map((part) => part.index),
      receivedBytes: parts.reduce((sum, part) => sum + part.bytes, 0), expiresAt: session.expiresAt,
      assembledBytes: session.status === 'completed' ? session.totalSizeBytes : session.assembledBytes,
      jobId: session.status === 'completed' ? session.jobId : null,
      error: session.errorCode ? { code: session.errorCode, message: session.errorMessage ?? 'Upload failed.' } : null,
    };
  }

  claimPart(input: { uploadId: string; index: number; bytes: number; sha256: string; owner: string; maxInflight: number; maxStagedBytes: number }, now = new Date()): { session: UploadSession; replay: boolean } {
    return this.db.transaction(() => {
      const session = this.markExpiredIfNeeded(input.uploadId, now);
      if (session.status === 'expired') throw new AppError('UPLOAD_EXPIRED', 'Upload session has expired.', 410);
      if (session.status !== 'uploading') throw new AppError('UPLOAD_STATE_CONFLICT', 'Upload session no longer accepts chunks.', 409);
      const existing = this.db.prepare('SELECT * FROM upload_parts WHERE upload_id=? AND idx=?').get(input.uploadId, input.index) as Row | undefined;
      if (existing) {
        if (Number(existing.bytes) !== input.bytes || String(existing.sha256) !== input.sha256) throw new AppError('CHUNK_CONFLICT', 'A different chunk is already stored at this index.', 409);
        return { session, replay: true };
      }
      const timestamp = nowIso(now);
      this.db.prepare('DELETE FROM upload_part_claims WHERE lease_expires_at <= ?').run(timestamp);
      const globalClaims = this.db.prepare('SELECT COUNT(*) count FROM upload_part_claims').get() as { count: number };
      const sessionClaims = this.db.prepare('SELECT COUNT(*) count FROM upload_part_claims WHERE upload_id=?').get(input.uploadId) as { count: number };
      if (Number(globalClaims.count) >= input.maxInflight || Number(sessionClaims.count) >= Math.min(3, input.maxInflight)) {
        throw new AppError('RATE_LIMITED', 'Too many chunks are currently being uploaded.', 429, true);
      }
      const staged = this.db.prepare("SELECT COALESCE(SUM(bytes),0) bytes FROM upload_parts p JOIN upload_sessions s ON s.id=p.upload_id WHERE s.status IN ('uploading','finalizing')").get() as { bytes: number };
      if (Number(staged.bytes) + input.bytes > input.maxStagedBytes) throw new AppError('INSUFFICIENT_STORAGE', 'Upload staging quota is full.', 507, true);
      try {
        this.db.prepare('INSERT INTO upload_part_claims(upload_id,idx,owner,lease_expires_at) VALUES (?,?,?,?)')
          .run(input.uploadId, input.index, input.owner, nowIso(new Date(now.getTime() + 900_000)));
      } catch {
        throw new AppError('CHUNK_IN_PROGRESS', 'This chunk is already being uploaded.', 409, true);
      }
      return { session, replay: false };
    }).immediate();
  }

  commitPart(input: { uploadId: string; index: number; bytes: number; sha256: string; relativePath: string; owner: string }, now = new Date()): void {
    this.db.transaction(() => {
      const claim = this.db.prepare('SELECT owner FROM upload_part_claims WHERE upload_id=? AND idx=?').get(input.uploadId, input.index) as { owner: string } | undefined;
      if (!claim || claim.owner !== input.owner) throw new AppError('CHUNK_IN_PROGRESS', 'Chunk claim was lost.', 409, true);
      const existing = this.db.prepare('SELECT bytes,sha256 FROM upload_parts WHERE upload_id=? AND idx=?').get(input.uploadId, input.index) as { bytes: number; sha256: string } | undefined;
      if (existing && (Number(existing.bytes) !== input.bytes || existing.sha256 !== input.sha256)) throw new AppError('CHUNK_CONFLICT', 'A different chunk is already stored at this index.', 409);
      if (!existing) this.db.prepare('INSERT INTO upload_parts(upload_id,idx,bytes,sha256,relative_path,stored_at) VALUES (?,?,?,?,?,?)')
        .run(input.uploadId, input.index, input.bytes, input.sha256, input.relativePath, nowIso(now));
      this.db.prepare('DELETE FROM upload_part_claims WHERE upload_id=? AND idx=? AND owner=?').run(input.uploadId, input.index, input.owner);
      this.db.prepare('UPDATE upload_sessions SET updated_at=? WHERE id=?').run(nowIso(now), input.uploadId);
    }).immediate();
  }

  releasePartClaim(uploadId: string, index: number, owner: string): void {
    this.db.prepare('DELETE FROM upload_part_claims WHERE upload_id=? AND idx=? AND owner=?').run(uploadId, index, owner);
  }

  removeMissingPart(uploadId: string, index: number): void {
    this.db.prepare("DELETE FROM upload_parts WHERE upload_id=? AND idx=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND status='uploading')").run(uploadId, index, uploadId);
  }

  requestFinalize(uploadId: string, jobId: string, now = new Date()): UploadSession {
    return this.db.transaction(() => {
      const session = this.markExpiredIfNeeded(uploadId, now);
      if (session.status === 'expired') throw new AppError('UPLOAD_EXPIRED', 'Upload session has expired.', 410);
      if (session.status === 'aborted') throw new AppError('UPLOAD_STATE_CONFLICT', 'Upload session was aborted.', 409);
      if (session.status === 'completed' || session.status === 'finalizing') return session;
      const parts = this.parts(uploadId);
      const received = new Set(parts.map((part) => part.index));
      const missing = Array.from({ length: session.totalChunks }, (_, index) => index).filter((index) => !received.has(index));
      const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
      if (missing.length > 0 || bytes !== session.totalSizeBytes) {
        throw new AppError('INCOMPLETE_UPLOAD', 'Upload is missing one or more chunks.', 409, false, undefined, { missingParts: missing.slice(0, 200) });
      }
      const changed = this.db.prepare(`UPDATE upload_sessions SET status='finalizing',job_id=?,assembled_bytes=0,updated_at=?,error_code=NULL,error_message=NULL
        WHERE id=? AND status='uploading'`).run(jobId, nowIso(now), uploadId);
      if (changed.changes !== 1) return this.getRequired(uploadId);
      return this.getRequired(uploadId);
    }).immediate();
  }

  abort(uploadId: string, now = new Date()): UploadSession {
    return this.db.transaction(() => {
      const session = this.getRequired(uploadId);
      if (session.status === 'completed' || session.status === 'finalizing') throw new AppError('UPLOAD_STATE_CONFLICT', 'Finalized uploads cannot be aborted; cancel the job instead.', 409);
      if (session.status === 'aborted') return session;
      this.db.prepare("UPDATE upload_sessions SET status='aborted',updated_at=?,finalize_owner=NULL,finalize_lease_expires_at=NULL WHERE id=? AND status IN ('uploading','expired')")
        .run(nowIso(now), uploadId);
      this.db.prepare('DELETE FROM upload_part_claims WHERE upload_id=?').run(uploadId);
      return this.getRequired(uploadId);
    }).immediate();
  }

  claimFinalization(owner: string, leaseSeconds: number, now = new Date()): UploadSession | null {
    return this.db.transaction(() => {
      const timestamp = nowIso(now);
      const row = this.db.prepare(`SELECT id FROM upload_sessions WHERE status='finalizing'
        AND (finalize_lease_expires_at IS NULL OR finalize_lease_expires_at <= ?) ORDER BY updated_at,id LIMIT 1`).get(timestamp) as { id: string } | undefined;
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE upload_sessions SET finalize_owner=?,finalize_lease_expires_at=?,assembled_bytes=0,updated_at=?
        WHERE id=? AND status='finalizing' AND (finalize_lease_expires_at IS NULL OR finalize_lease_expires_at <= ?)`)
        .run(owner, nowIso(new Date(now.getTime() + leaseSeconds * 1_000)), timestamp, row.id, timestamp);
      return changed.changes === 1 ? this.getRequired(row.id) : null;
    }).immediate();
  }

  renewFinalization(id: string, owner: string, leaseSeconds: number, now = new Date()): boolean {
    return this.db.prepare(`UPDATE upload_sessions SET finalize_lease_expires_at=?,updated_at=? WHERE id=? AND status='finalizing' AND finalize_owner=?`)
      .run(nowIso(new Date(now.getTime() + leaseSeconds * 1_000)), nowIso(now), id, owner).changes === 1;
  }

  updateFinalizationProgress(id: string, owner: string, assembledBytes: number, leaseSeconds: number, now = new Date()): boolean {
    if (!Number.isSafeInteger(assembledBytes) || assembledBytes < 0) return false;
    return this.db.prepare(`UPDATE upload_sessions SET assembled_bytes=MIN(?,total_size_bytes),finalize_lease_expires_at=?,updated_at=?
      WHERE id=? AND status='finalizing' AND finalize_owner=?`)
      .run(assembledBytes, nowIso(new Date(now.getTime() + leaseSeconds * 1_000)), nowIso(now), id, owner).changes === 1;
  }

  completeFinalization(input: { uploadId: string; owner: string; computedSha256: string; sourcePath: string; maxAttempts: number; model: string }, now = new Date()): UploadSession {
    return this.db.transaction(() => {
      const session = this.getRequired(input.uploadId);
      if (session.status === 'completed') return session;
      if (session.status !== 'finalizing' || session.finalizeOwner !== input.owner || !session.jobId) throw new AppError('UPLOAD_STATE_CONFLICT', 'Finalization lease was lost.', 409, true);
      const timestamp = nowIso(now);
      this.db.prepare(`INSERT INTO jobs (
        id,status,phase,origin,created_at,queue_entered_at,updated_at,original_filename,media_type,file_size_bytes,source_path,language,
        requested_output_formats,provider,model,max_attempts
      ) VALUES (?, 'queued', NULL, ?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, ?, ?, 'whisper_cpp', ?, ?)`)
        .run(session.jobId, session.origin, timestamp, timestamp, timestamp, session.displayFilename, session.totalSizeBytes, input.sourcePath, session.language,
          JSON.stringify(session.formats), input.model, input.maxAttempts);
      const changed = this.db.prepare(`UPDATE upload_sessions SET status='completed',computed_sha256=?,assembled_bytes=total_size_bytes,updated_at=?,finalize_owner=NULL,
        finalize_lease_expires_at=NULL,error_code=NULL,error_message=NULL WHERE id=? AND status='finalizing' AND finalize_owner=?`)
        .run(input.computedSha256, timestamp, input.uploadId, input.owner);
      if (changed.changes !== 1) throw new AppError('UPLOAD_STATE_CONFLICT', 'Finalization lease was lost.', 409, true);
      return this.getRequired(input.uploadId);
    }).immediate();
  }

  failFinalization(id: string, owner: string, code: string, message: string, terminal: boolean, now = new Date()): void {
    const status = terminal ? 'aborted' : 'finalizing';
    this.db.prepare(`UPDATE upload_sessions SET status=?,error_code=?,error_message=?,updated_at=?,finalize_owner=NULL,finalize_lease_expires_at=NULL
      WHERE id=? AND status='finalizing' AND finalize_owner=?`).run(status, code, message, nowIso(now), id, owner);
  }

  metrics(): { active: number; stagedBytes: number; finalizing: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('uploading','finalizing') THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN status='finalizing' THEN 1 ELSE 0 END) finalizing FROM upload_sessions`).get() as { active: number | null; finalizing: number | null };
    const staged = this.db.prepare("SELECT COALESCE(SUM(p.bytes),0) bytes FROM upload_parts p JOIN upload_sessions s ON s.id=p.upload_id WHERE s.status IN ('uploading','finalizing')").get() as { bytes: number };
    return { active: Number(row.active ?? 0), stagedBytes: Number(staged.bytes), finalizing: Number(row.finalizing ?? 0) };
  }

  clearCompletedParts(id: string): void {
    this.db.prepare("DELETE FROM upload_parts WHERE upload_id=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND status='completed')").run(id, id);
  }

  clearTerminalParts(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM upload_part_claims WHERE upload_id=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND status IN ('aborted','expired'))").run(id, id);
      this.db.prepare("DELETE FROM upload_parts WHERE upload_id=? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id=? AND status IN ('aborted','expired'))").run(id, id);
    }).immediate();
  }

  expireSessions(now = new Date()): string[] {
    const timestamp = nowIso(now);
    const rows = this.db.prepare("SELECT id FROM upload_sessions WHERE status='uploading' AND expires_at <= ?").all(timestamp) as Array<{ id: string }>;
    this.db.prepare("UPDATE upload_sessions SET status='expired',updated_at=? WHERE status='uploading' AND expires_at <= ?").run(timestamp, timestamp);
    return rows.map((row) => row.id);
  }
}
