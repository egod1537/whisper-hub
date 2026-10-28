import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../shared/config.js';
import { AppError } from '../shared/errors.js';
import { removePath } from '../shared/storage/files.js';
import { resolveInside, sourceRelativePath } from '../shared/storage/paths.js';
import { uploadAssemblyRelativePath, uploadSessionRelativePath } from '../shared/uploads/paths.js';
import type { UploadRepository } from '../shared/uploads/repository.js';
import { hashFile } from '../shared/uploads/stream.js';
import type { UploadSession } from '../shared/uploads/types.js';

export class UploadFinalizerService {
  constructor(private readonly options: { config: Config; repository: UploadRepository; owner: string; logger: Logger }) {}

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const session = this.options.repository.claimFinalization(this.options.owner, this.options.config.uploadFinalizerLeaseSeconds);
      if (!session) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.options.config.workerPollMs);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        continue;
      }
      await this.finalize(session).catch((error: unknown) => {
        const terminal = error instanceof AppError && ['FILE_HASH_MISMATCH', 'INCOMPLETE_UPLOAD', 'CHUNK_HASH_MISMATCH'].includes(error.code);
        const code = error instanceof AppError ? error.code : 'FINALIZATION_FAILED';
        const message = terminal ? (error instanceof Error ? error.message : 'Upload finalization failed.') : 'Upload finalization will be retried.';
        this.options.repository.failFinalization(session.id, this.options.owner, code, message, terminal);
        this.options.logger[terminal ? 'warn' : 'error']({ err: error, uploadId: session.id }, 'upload finalization failed');
      });
    }
  }

  async finalize(session: UploadSession): Promise<void> {
    if (!session.jobId) throw new AppError('INTERNAL_ERROR', 'Upload has no reserved job ID.');
    const { config, repository, owner, logger } = this.options;
    const sourceRelative = sourceRelativePath(session.jobId);
    const source = resolveInside(config.dataDir, sourceRelative);
    let finalHash: string;
    const existingSource = await fs.promises.stat(source).catch(() => null);
    if (existingSource?.isFile()) {
      const existing = await hashFile(source);
      if (existing.bytes !== session.totalSizeBytes) {
        await removePath(path.dirname(source));
        throw new AppError('INCOMPLETE_UPLOAD', 'Assembled upload has an invalid size.', 422);
      }
      finalHash = existing.sha256;
      if (!repository.updateFinalizationProgress(session.id, owner, session.totalSizeBytes, config.uploadFinalizerLeaseSeconds)) {
        throw new AppError('UPLOAD_STATE_CONFLICT', 'Finalization lease was lost.', 409, true);
      }
    } else {
      const parts = repository.parts(session.id);
      if (parts.length !== session.totalChunks) throw new AppError('INCOMPLETE_UPLOAD', 'Validated upload parts are missing.', 409);
      const staging = resolveInside(config.dataDir, uploadAssemblyRelativePath(session.id, owner));
      await fs.promises.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
      await fs.promises.rm(staging, { force: true });
      const output = await fs.promises.open(staging, 'wx', 0o600);
      const wholeHash = createHash('sha256');
      let wholeBytes = 0;
      try {
        for (const [expectedIndex, part] of parts.entries()) {
          if (part.index !== expectedIndex) throw new AppError('INCOMPLETE_UPLOAD', 'Upload part sequence is incomplete.', 409);
          const partHash = createHash('sha256');
          let partBytes = 0;
          const input = fs.createReadStream(resolveInside(config.dataDir, part.relativePath));
          for await (const value of input) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            partBytes += chunk.length;
            wholeBytes += chunk.length;
            partHash.update(chunk);
            wholeHash.update(chunk);
            await output.write(chunk);
          }
          if (partBytes !== part.bytes || partHash.digest('hex') !== part.sha256) throw new AppError('CHUNK_HASH_MISMATCH', 'A stored upload chunk failed verification.', 422);
          if (!repository.updateFinalizationProgress(session.id, owner, wholeBytes, config.uploadFinalizerLeaseSeconds)) {
            throw new AppError('UPLOAD_STATE_CONFLICT', 'Finalization lease was lost.', 409, true);
          }
        }
        if (wholeBytes !== session.totalSizeBytes) throw new AppError('INCOMPLETE_UPLOAD', 'Assembled upload has an invalid size.', 422);
        finalHash = wholeHash.digest('hex');
        if (session.expectedSha256 && finalHash !== session.expectedSha256) throw new AppError('FILE_HASH_MISMATCH', 'Assembled file SHA-256 does not match.', 422);
        await output.sync();
      } catch (error) {
        await output.close().catch(() => undefined);
        await fs.promises.rm(staging, { force: true }).catch(() => undefined);
        throw error;
      }
      await output.close();
      await fs.promises.mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
      await fs.promises.rename(staging, source);
      await fs.promises.chmod(source, 0o600);
    }
    if (session.expectedSha256 && finalHash !== session.expectedSha256) {
      await removePath(path.dirname(source));
      throw new AppError('FILE_HASH_MISMATCH', 'Assembled file SHA-256 does not match.', 422);
    }
    const completed = repository.completeFinalization({
      uploadId: session.id, owner, computedSha256: finalHash, sourcePath: sourceRelative,
      maxAttempts: config.jobMaxAttempts, model: config.defaultModel,
    });
    await removePath(resolveInside(config.dataDir, uploadSessionRelativePath(session.id)));
    repository.clearCompletedParts(session.id);
    logger.info({ uploadId: session.id, jobId: completed.jobId, bytes: session.totalSizeBytes }, 'upload finalized and job queued');
  }
}
