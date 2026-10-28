import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { AppError } from '../errors.js';
import type { Transcript, TranscriptSegment } from '../export/types.js';
import type { TranscribeInput, TranscriptionProvider } from './interface.js';

interface HttpResult {
  status: number;
  body: string;
}

function field(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

async function multipartRequest(url: URL, wavPath: string, language: string, signal: AbortSignal): Promise<HttpResult> {
  const boundary = `whisper-hub-${crypto.randomUUID()}`;
  const prefix = Buffer.concat([
    field(boundary, 'response_format', 'verbose_json'),
    field(boundary, 'language', language),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
  ]);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const stat = await fs.promises.stat(wavPath);
  const transport = url.protocol === 'https:' ? https : http;
  return await new Promise<HttpResult>((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(prefix.length + stat.size + suffix.length),
        accept: 'application/json',
      },
      signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
          request.destroy(new AppError('PROVIDER_INVALID_RESPONSE', 'Provider response was too large.', 502));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.write(prefix);
    const stream = fs.createReadStream(wavPath);
    const abortStream = () => stream.destroy(new AppError('CANCELED', 'Job cancellation requested.', 409));
    signal.addEventListener('abort', abortStream, { once: true });
    stream.on('error', reject);
    stream.on('close', () => signal.removeEventListener('abort', abortStream));
    stream.on('end', () => request.end(suffix));
    stream.pipe(request, { end: false });
  });
}

function normalizeResponse(body: string): Transcript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('PROVIDER_INVALID_RESPONSE', 'Transcription provider returned invalid JSON.', 502);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AppError('PROVIDER_INVALID_RESPONSE', 'Transcription provider returned an invalid response.', 502);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string' || !Array.isArray(record.segments)) {
    throw new AppError('PROVIDER_INVALID_RESPONSE', 'Transcription provider response is missing transcript data.', 502);
  }
  let previousEnd = 0;
  const segments: TranscriptSegment[] = record.segments.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new AppError('PROVIDER_INVALID_RESPONSE', 'Provider segment is invalid.', 502);
    const segment = raw as Record<string, unknown>;
    if (typeof segment.start !== 'number' || typeof segment.end !== 'number' || typeof segment.text !== 'string') {
      throw new AppError('PROVIDER_INVALID_RESPONSE', 'Provider segment timestamps are unavailable.', 502);
    }
    const startMs = Math.round(segment.start * 1_000);
    const endMs = Math.round(segment.end * 1_000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || (index > 0 && startMs < previousEnd)) {
      throw new AppError('PROVIDER_INVALID_RESPONSE', 'Provider segment timestamps are invalid.', 502);
    }
    previousEnd = endMs;
    return { startMs, endMs, text: segment.text };
  });
  const languageDetected = typeof record.language === 'string' ? { languageDetected: record.language } : {};
  return {
    text: record.text.trim(),
    segments,
    ...languageDetected,
    providerMetadata: {
      task: record.task ?? null,
      duration: record.duration ?? null,
    },
  };
}

export class WhisperHttpProvider implements TranscriptionProvider {
  readonly name = 'whisper_cpp';
  private readonly inferenceUrl: URL;
  private readonly healthUrl: URL;

  constructor(baseUrl: string, private readonly timeoutMs: number) {
    this.inferenceUrl = new URL('/inference', `${baseUrl}/`);
    this.healthUrl = new URL('/health', `${baseUrl}/`);
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    try {
      const response = await multipartRequest(this.inferenceUrl, input.wavPath, input.language, signal);
      if (response.status === 429 || response.status >= 500) {
        throw new AppError('PROVIDER_UNAVAILABLE', 'Transcription provider is temporarily unavailable.', 503, true);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AppError('PROVIDER_INVALID_RESPONSE', 'Transcription provider rejected the request.', 502);
      }
      return normalizeResponse(response.body);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted) {
        if (input.signal.aborted) throw new AppError('CANCELED', 'Job cancellation requested.', 409);
        throw new AppError('PROVIDER_TIMEOUT', 'Transcription provider timed out.', 504, true);
      }
      throw new AppError('PROVIDER_UNAVAILABLE', 'Transcription provider is unavailable.', 503, true, { cause: error });
    }
  }

  async health(signal: AbortSignal = AbortSignal.timeout(2_000)): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const whisperHttpInternals = { normalizeResponse };
