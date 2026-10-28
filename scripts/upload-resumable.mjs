#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const formats = new Set(['txt', 'srt', 'vtt', 'json']);
const languages = new Set(['auto', 'ko', 'ja', 'en']);

function usage() {
  return `Usage: node scripts/upload-resumable.mjs <file> [options]

Environment:
  WHISPER_HUB_URL       API origin (default: http://127.0.0.1:3000)
  WHISPER_HUB_API_KEY   Bearer token (falls back to API_KEY)

Options:
  --language <value>          auto, ko, ja, or en (default: auto)
  --formats <csv>             txt,srt,vtt,json (default: txt,srt,json)
  --concurrency <1-3>         simultaneous chunks (default: 3)
  --idempotency-key <value>   override the stable retry key
  --help                      show this help
`;
}

export function parseArguments(argv, env = process.env) {
  if (argv.includes('--help')) return { help: true };
  let filePath;
  let language = 'auto';
  let requestedFormats = ['txt', 'srt', 'json'];
  let concurrency = 3;
  let idempotencyKey;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--') && filePath === undefined) { filePath = argument; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    if (argument === '--language') language = value;
    else if (argument === '--formats') requestedFormats = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
    else if (argument === '--concurrency') concurrency = Number(value);
    else if (argument === '--idempotency-key') idempotencyKey = value;
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!filePath) throw new Error('A file path is required.');
  if (!languages.has(language)) throw new Error(`Unsupported language: ${language}`);
  if (requestedFormats.length === 0 || requestedFormats.some((format) => !formats.has(format))) throw new Error('Formats must be a unique subset of txt,srt,vtt,json.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Concurrency must be an integer from 1 to 3.');
  if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) throw new Error('Idempotency key must contain 1-128 visible ASCII characters.');
  const apiKey = env.WHISPER_HUB_API_KEY ?? env.API_KEY;
  if (!apiKey) throw new Error('Set WHISPER_HUB_API_KEY or API_KEY.');
  const baseUrl = (env.WHISPER_HUB_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return { help: false, filePath: path.resolve(filePath), language, formats: requestedFormats, concurrency, idempotencyKey, apiKey, baseUrl };
}

function mediaType(filePath) {
  return {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  }[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : 300 * (2 ** attempt);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.code ? ` ${body.error.code}: ${body.error.message ?? ''}` : '';
  } catch {
    detail = '';
  }
  return new Error(`Whisper Hub returned HTTP ${response.status}.${detail}`);
}

async function request(options, pathname, init, fetchFn) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchFn(`${options.baseUrl}/api/v1${pathname}`, {
        ...init,
        headers: { authorization: `Bearer ${options.apiKey}`, ...init?.headers },
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      await wait(300 * (2 ** attempt));
      continue;
    }
    if (response.ok) return response;
    if (attempt >= 3 || (response.status !== 429 && response.status < 500)) throw await responseError(response);
    await wait(retryDelay(response, attempt));
  }
}

function chunkBytes(index, chunkSize, fileSize) {
  const start = index * chunkSize;
  return Math.max(0, Math.min(chunkSize, fileSize - start));
}

function completedBytes(receivedParts, chunkSize, fileSize) {
  return receivedParts.reduce((sum, index) => sum + chunkBytes(index, chunkSize, fileSize), 0);
}

export async function uploadResumableFile(options, dependencies = {}) {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const onProgress = dependencies.onProgress ?? (() => undefined);
  const stat = await fs.promises.stat(options.filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('The upload path must be a non-empty file.');
  const stableKey = `cli-${crypto.createHash('sha256').update(JSON.stringify({
    filePath: options.filePath, size: stat.size, mtimeMs: stat.mtimeMs, language: options.language, formats: options.formats,
  })).digest('hex').slice(0, 48)}`;
  const idempotencyKey = options.idempotencyKey ?? stableKey;
  const created = await (await request(options, '/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      filename: path.basename(options.filePath), sizeBytes: stat.size, mimeType: mediaType(options.filePath),
      language: options.language, formats: options.formats,
    }),
  }, fetchFn)).json();
  let status = await (await request(options, `/uploads/${created.uploadId}`, {}, fetchFn)).json();
  if (status.status === 'expired' || status.status === 'aborted') {
    throw new Error(`Upload session is ${status.status}; retry with --idempotency-key set to a new value.`);
  }
  if (status.status === 'uploading') {
    const received = new Set(status.receivedParts);
    const pending = Array.from({ length: status.totalChunks }, (_, index) => index).filter((index) => !received.has(index));
    let bytesDone = completedBytes(status.receivedParts, status.chunkSizeBytes, stat.size);
    onProgress({ phase: 'uploading', completedBytes: bytesDone, totalBytes: stat.size, uploadId: status.uploadId });
    const file = await fs.promises.open(options.filePath, 'r');
    let cursor = 0;
    try {
      const uploadWorker = async () => {
        while (cursor < pending.length) {
          const index = pending[cursor++];
          const length = chunkBytes(index, status.chunkSizeBytes, stat.size);
          const buffer = Buffer.allocUnsafe(length);
          const read = await file.read(buffer, 0, length, index * status.chunkSizeBytes);
          if (read.bytesRead !== length) throw new Error(`Could not read chunk ${index}.`);
          const digest = crypto.createHash('sha256').update(buffer).digest('hex');
          await request(options, `/uploads/${status.uploadId}/parts/${index}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(length), 'x-chunk-sha256': digest },
            body: buffer,
          }, fetchFn);
          bytesDone += length;
          onProgress({ phase: 'uploading', completedBytes: bytesDone, totalBytes: stat.size, uploadId: status.uploadId });
        }
      };
      await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, uploadWorker));
    } finally {
      await file.close();
    }
    await request(options, `/uploads/${status.uploadId}/complete`, { method: 'POST' }, fetchFn);
  }
  for (let poll = 0; poll < 3_600; poll += 1) {
    status = await (await request(options, `/uploads/${created.uploadId}`, {}, fetchFn)).json();
    onProgress({
      phase: 'finalizing', completedBytes: status.status === 'completed' ? stat.size : status.assembledBytes,
      totalBytes: stat.size, uploadId: status.uploadId,
    });
    if (status.status === 'completed' && status.jobId) {
      const job = await (await request(options, `/jobs/${status.jobId}`, {}, fetchFn)).json();
      return { uploadId: status.uploadId, job };
    }
    if (status.status === 'expired' || status.status === 'aborted') throw new Error(`Upload ${status.status}: ${status.error?.message ?? ''}`);
    await wait(1_000);
  }
  throw new Error('Timed out waiting for server-side assembly.');
}

function formatProgress(progress) {
  const percent = progress.totalBytes === 0 ? 0 : progress.completedBytes / progress.totalBytes * 100;
  return `${progress.phase} ${percent.toFixed(1)}% (${progress.completedBytes}/${progress.totalBytes} bytes)`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const result = await uploadResumableFile(options, { onProgress: (progress) => process.stderr.write(`${formatProgress(progress)}\n`) });
      process.stdout.write(`${JSON.stringify({
        jobId: result.job.id, status: result.job.status, queuePosition: result.job.queuePosition,
        jobUrl: `${options.baseUrl}/api/v1/jobs/${result.job.id}`,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 1;
  }
}
