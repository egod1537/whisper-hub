import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { AppError } from '../shared/errors.js';

interface ProcessResult {
  stdout: string;
  stderr: string;
}

async function runProcess(command: string, args: string[], options: {
  signal: AbortSignal;
  timeoutMs: number;
  outputPath?: string;
  maxOutputBytes?: number;
  onStdoutLine?(line: string): void;
}): Promise<ProcessResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combinedSignal = AbortSignal.any([options.signal, timeout]);
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: combinedSignal, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let stdoutLineBuffer = '';
    let limitExceeded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= 1024 * 1024) stdout.push(chunk);
      if (options.onStdoutLine) {
        stdoutLineBuffer += chunk.toString('utf8');
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) options.onStdoutLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 64 * 1024) stderr.push(chunk);
    });
    const monitor = options.outputPath && options.maxOutputBytes ? setInterval(() => {
      try {
        if (fs.statSync(options.outputPath!).size > options.maxOutputBytes!) {
          limitExceeded = true;
          child.kill('SIGKILL');
        }
      } catch {
        // Output may not exist yet.
      }
    }, 250) : undefined;
    monitor?.unref();
    child.on('error', (error) => {
      if (monitor) clearInterval(monitor);
      if (limitExceeded) reject(new AppError('CONVERSION_FAILED', 'Converted media exceeded the safe output limit.', 422));
      else if (options.signal.aborted) reject(new AppError('CANCELED', 'Job cancellation requested.', 409));
      else if (timeout.aborted) reject(new AppError('CONVERSION_FAILED', 'Media processing timed out.', 422));
      else reject(new AppError('CONVERSION_FAILED', 'Media processing could not be started.', 422, false, { cause: error }));
    });
    child.on('close', (code) => {
      if (monitor) clearInterval(monitor);
      if (stdoutLineBuffer && options.onStdoutLine) options.onStdoutLine(stdoutLineBuffer);
      if (limitExceeded) {
        reject(new AppError('CONVERSION_FAILED', 'Converted media exceeded the safe output limit.', 422));
      } else if (options.signal.aborted) {
        reject(new AppError('CANCELED', 'Job cancellation requested.', 409));
      } else if (timeout.aborted) {
        reject(new AppError('CONVERSION_FAILED', 'Media processing timed out.', 422));
      } else if (code !== 0) {
        reject(new AppError('CONVERSION_FAILED', 'Media processing failed.', 422));
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      }
    });
  });
}

export async function probeDuration(inputPath: string, signal: AbortSignal): Promise<number> {
  let result: ProcessResult;
  try {
    result = await runProcess('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', inputPath,
    ], { signal, timeoutMs: 60_000 });
  } catch (error) {
    if (error instanceof AppError && error.code === 'CANCELED') throw error;
    throw new AppError('MEDIA_INVALID', 'Uploaded file is not valid audio or video.', 422);
  }
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration < 0) throw new Error('invalid duration');
    return duration;
  } catch {
    throw new AppError('MEDIA_INVALID', 'Uploaded file is not valid audio or video.', 422);
  }
}

export async function convertToWav(inputPath: string, outputPath: string, options: {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  durationSeconds: number;
  onProgress?(currentSeconds: number, totalSeconds: number): void;
}): Promise<void> {
  let currentSeconds = 0;
  await runProcess('ffmpeg', [
    '-nostdin', '-v', 'error', '-nostats', '-stats_period', '0.5', '-progress', 'pipe:1', '-i', inputPath, '-map', '0:a:0',
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outputPath,
  ], {
    ...options,
    outputPath,
    onStdoutLine: (line) => {
      const separator = line.indexOf('=');
      if (separator < 1) return;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === 'out_time_us') {
        const parsed = Number(value) / 1_000_000;
        if (Number.isFinite(parsed) && parsed >= currentSeconds) {
          currentSeconds = Math.min(parsed, options.durationSeconds);
          options.onProgress?.(currentSeconds, options.durationSeconds);
        }
      } else if (key === 'progress' && value === 'end') {
        options.onProgress?.(options.durationSeconds, options.durationSeconds);
      }
    },
  });
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 44 || stat.size > options.maxOutputBytes) {
    throw new AppError('CONVERSION_FAILED', 'Media conversion produced an invalid output.', 422);
  }
}

