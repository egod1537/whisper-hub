import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';

export interface StreamedPart { bytes: number; sha256: string }

export async function streamChunkToFile(input: Readable, target: string, expectedBytes: number, hardCap: number): Promise<StreamedPart> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > hardCap || bytes > expectedBytes) {
        callback(new AppError('CHUNK_LENGTH_INVALID', 'Chunk length does not match the expected size.', 422));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if (bytes !== expectedBytes) throw new AppError('CHUNK_LENGTH_INVALID', 'Chunk length does not match the expected size.', 422);
    const handle = await fs.promises.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await fs.promises.rm(target, { force: true }).catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && ['ENOSPC', 'EDQUOT'].includes(String(error.code))) {
      throw new AppError('INSUFFICIENT_STORAGE', 'Insufficient storage for this upload.', 507);
    }
    throw error;
  }
}

export async function hashFile(target: string): Promise<StreamedPart> {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(); } });
  await pipeline(fs.createReadStream(target), meter);
  return { bytes, sha256: hash.digest('hex') };
}
