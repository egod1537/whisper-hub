import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export interface YoutubeDownloadResult {
  originalFilename: string;
  mediaType: string;
  fileSizeBytes: number;
}

export interface YoutubeDownloader {
  download(url: string, destinationPath: string, signal: AbortSignal): Promise<YoutubeDownloadResult>;
}

export function normalizeYoutubeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('YOUTUBE_INVALID_URL', '올바른 YouTube 영상 링크를 입력해 주세요.', 422);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new AppError('YOUTUBE_INVALID_URL', 'HTTPS YouTube 영상 링크만 사용할 수 있습니다.', 422);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  let videoId: string | null = null;
  if (hostname === 'youtu.be') {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)) {
    if (parsed.pathname === '/watch') videoId = parsed.searchParams.get('v');
    else videoId = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(parsed.pathname)?.[1] ?? null;
  } else if (hostname === 'www.youtube-nocookie.com') {
    videoId = /^\/embed\/([^/]+)/.exec(parsed.pathname)?.[1] ?? null;
  }
  if (!videoId || !VIDEO_ID.test(videoId)) {
    throw new AppError('YOUTUBE_INVALID_URL', '단일 YouTube 영상 링크만 사용할 수 있습니다.', 422);
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function mediaTypeFor(extension: string): string {
  return {
    m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', ogg: 'audio/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  }[extension] ?? 'application/octet-stream';
}

function safeFilename(title: unknown, id: unknown, extension: string): string {
  const fallback = typeof id === 'string' && VIDEO_ID.test(id) ? `youtube-${id}` : 'youtube-video';
  const source = typeof title === 'string' ? title : fallback;
  const safe = source.normalize('NFKC').replace(/[\p{Cc}/\\";]/gu, '_').trim().slice(0, 160) || fallback;
  return `${safe}.${extension || 'media'}`;
}

interface CommandResult { stdout: string; stderr: string }

function commandFailure(stderr: string): AppError {
  if (/max-filesize|larger than max|file is larger/i.test(stderr)) {
    return new AppError('PAYLOAD_TOO_LARGE', 'YouTube 오디오가 서버의 크기 제한을 초과했습니다.', 413);
  }
  if (/private video|video unavailable|members-only|sign in|age-restricted|not available/i.test(stderr)) {
    return new AppError('YOUTUBE_UNAVAILABLE', '이 YouTube 영상은 다운로드할 수 없습니다.', 422);
  }
  return new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube 오디오를 가져오지 못했습니다.', 503, true);
}

async function runCommand(executable: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  if (signal.aborted) throw new AppError('CANCELED', 'Operation canceled.');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => child.kill('SIGTERM');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGTERM');
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish(new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube downloader is unavailable.', 503));
      else finish(new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube downloader could not start.', 503, true));
    });
    child.once('close', (code) => {
      if (signal.aborted) return finish(new AppError('CANCELED', 'Operation canceled.'));
      if (timedOut) return finish(new AppError('YOUTUBE_TIMEOUT', 'YouTube 다운로드 시간이 초과되었습니다.', 504, true));
      if (outputExceeded) return finish(new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube downloader returned too much output.', 502, true));
      if (code !== 0) return finish(commandFailure(stderr));
      return finish(undefined, { stdout, stderr });
    });
  });
}

export class YtDlpYoutubeDownloader implements YoutubeDownloader {
  constructor(private readonly config: Config) {}

  async download(url: string, destinationPath: string, signal: AbortSignal): Promise<YoutubeDownloadResult> {
    const normalizedUrl = normalizeYoutubeUrl(url);
    const common = ['--ignore-config', '--no-playlist', '--quiet', '--no-warnings', '--socket-timeout', '30'];
    const metadata = await runCommand(this.config.ytDlpPath, [
      ...common, '--skip-download', '--dump-single-json', normalizedUrl,
    ], this.config.youtubeMetadataTimeoutMs, signal);
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(metadata.stdout) as Record<string, unknown>;
    } catch {
      throw new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube 영상 정보를 해석하지 못했습니다.', 502, true);
    }
    if (info.is_live === true || info.live_status === 'is_live') {
      throw new AppError('YOUTUBE_UNAVAILABLE', 'YouTube 라이브 영상은 지원하지 않습니다.', 422);
    }
    if (typeof info.duration === 'number' && info.duration > this.config.maxDurationSeconds) {
      throw new AppError('DURATION_LIMIT_EXCEEDED', '영상 길이가 서버 제한을 초과했습니다.', 422);
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    const outputTemplate = `${destinationPath}.%(ext)s`;
    const downloaded = await runCommand(this.config.ytDlpPath, [
      ...common,
      '--retries', '3',
      '--fragment-retries', '3',
      '--format', 'bestaudio/best',
      '--max-filesize', String(this.config.maxUploadBytes),
      '--output', outputTemplate,
      '--print', 'after_move:filepath',
      normalizedUrl,
    ], this.config.youtubeDownloadTimeoutMs, signal);
    const candidate = downloaded.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!candidate) throw new AppError('YOUTUBE_DOWNLOAD_FAILED', '다운로드된 YouTube 오디오를 찾지 못했습니다.', 502, true);
    const resolvedCandidate = path.resolve(candidate);
    const expectedParent = path.resolve(path.dirname(destinationPath));
    if (path.dirname(resolvedCandidate) !== expectedParent || !path.basename(resolvedCandidate).startsWith(`${path.basename(destinationPath)}.`)) {
      throw new AppError('YOUTUBE_DOWNLOAD_FAILED', 'YouTube downloader returned an unsafe path.', 502);
    }
    const stat = await fs.promises.stat(resolvedCandidate);
    if (!stat.isFile()) throw new AppError('YOUTUBE_DOWNLOAD_FAILED', '다운로드된 YouTube 오디오가 올바르지 않습니다.', 502, true);
    if (stat.size > this.config.maxUploadBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'YouTube 오디오가 서버의 크기 제한을 초과했습니다.', 413);
    }
    const extension = path.extname(resolvedCandidate).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    await fs.promises.rename(resolvedCandidate, destinationPath);
    await fs.promises.chmod(destinationPath, 0o600);
    return {
      originalFilename: safeFilename(info.title, info.id, extension),
      mediaType: mediaTypeFor(extension),
      fileSizeBytes: stat.size,
    };
  }
}
