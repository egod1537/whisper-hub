import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import path from 'node:path';
import { AppError } from '../errors.js';
import { resolveInside } from './paths.js';

export interface StoredUpload {
  tempPath: string;
  size: number;
  sha256: string;
}

export function ensureStorage(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const child of ['uploads', 'uploads/.sessions', 'results', '.tmp']) {
    fs.mkdirSync(resolveInside(dataDir, child), { recursive: true, mode: 0o700 });
  }
}

export async function streamUploadToTemp(dataDir: string, input: Readable, maxBytes: number): Promise<StoredUpload> {
  ensureStorage(dataDir);
  const tempPath = resolveInside(dataDir, path.posix.join('.tmp', `upload-${randomUUID()}.part`));
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new AppError('PAYLOAD_TOO_LARGE', 'Uploaded file is too large.', 413));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    return { tempPath, size, sha256: hash.digest('hex') };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function moveUploadIntoPlace(dataDir: string, tempPath: string, relativePath: string): Promise<string> {
  const target = resolveInside(dataDir, relativePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.rename(tempPath, target);
  await fs.promises.chmod(target, 0o600);
  return target;
}

export async function removePath(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

export async function isStorageWritable(dataDir: string): Promise<boolean> {
  try {
    ensureStorage(dataDir);
    const check = resolveInside(dataDir, path.posix.join('.tmp', `.ready-${randomUUID()}`));
    await fs.promises.writeFile(check, '', { flag: 'wx', mode: 0o600 });
    await fs.promises.unlink(check);
    return true;
  } catch {
    return false;
  }
}

