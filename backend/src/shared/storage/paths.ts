import path from 'node:path';
import { AppError } from '../errors.js';

export function resolveInside(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new AppError('INTERNAL_ERROR', 'Unsafe storage path.');
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relativePath);
  const relation = path.relative(base, resolved);
  if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) return resolved;
  throw new AppError('INTERNAL_ERROR', 'Unsafe storage path.');
}

export function sourceRelativePath(jobId: string): string {
  return path.posix.join('uploads', jobId, 'source');
}

export function resultRelativePath(jobId: string): string {
  return path.posix.join('results', jobId);
}

export function tempRelativePath(jobId: string, suffix: string): string {
  return path.posix.join('.tmp', `${jobId}-${suffix}`);
}

export function safeDownloadBaseName(originalFilename: string): string {
  const stem = path.basename(originalFilename, path.extname(originalFilename));
  const safe = stem.normalize('NFKC').replace(/[\p{Cc}/\\";]/gu, '_').trim().slice(0, 100);
  return safe || 'transcript';
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

