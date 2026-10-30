import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalHttpsUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Webhook URL must use HTTPS').optional(),
);

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TEST_MODE: booleanString,
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATA_DIR: z.string().min(1).default('/data'),
    DB_PATH: z.string().min(1).optional(),
    WHISPER_BASE_URL: z.string().url().default('http://host.docker.internal:8080'),
    API_KEY: z.string().min(16).optional(),
    WEB_PROXY_TOKEN: z.string().min(32).optional(),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(262_144_000),
    MAX_RESUMABLE_UPLOAD_BYTES: z.coerce.number().int().positive().max(2_147_483_648).default(2_147_483_648),
    UPLOAD_CHUNK_SIZE_BYTES: z.coerce.number().int().min(1_048_576).max(20_971_520).default(20_971_520),
    UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    UPLOAD_MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).default(20),
    UPLOAD_MAX_STAGED_BYTES: z.coerce.number().int().positive().default(4_294_967_296),
    UPLOAD_MAX_INFLIGHT_CHUNKS: z.coerce.number().int().min(1).max(64).default(6),
    UPLOAD_FINALIZER_LEASE_SECONDS: z.coerce.number().int().min(60).default(900),
    MAX_DURATION_SECONDS: z.coerce.number().positive().default(7_200),
    MAX_CONVERSION_SECONDS: z.coerce.number().int().positive().default(7_500),
    MAX_WAV_BYTES: z.coerce.number().int().positive().default(1_500_000_000),
    YT_DLP_PATH: z.string().min(1).default('yt-dlp'),
    YOUTUBE_METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    YOUTUBE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
    WORKER_POLL_MS: z.coerce.number().int().min(50).default(1_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    JOB_LEASE_SECONDS: z.coerce.number().int().min(60).default(900),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
    DEFAULT_MODEL: z.string().min(1).default('large-v3'),
    CHATGPT_POLISH_ENABLED: booleanString,
    CHATGPT_PLAN_CREDENTIALS_PATH: z.string().min(1).default('/chatgpt/chatgpt-plan.json'),
    CHATGPT_POLISH_MODEL: z.string().min(1).default('gpt-5.6-sol'),
    CHATGPT_POLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    CHATGPT_POLISH_CHUNK_CHARS: z.coerce.number().int().min(1_000).max(100_000).default(20_000),
    MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    MONITOR_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(10).default(3),
    MONITOR_ALERT_REPEAT_MINUTES: z.coerce.number().int().min(5).max(1_440).default(60),
    MONITOR_DISK_WARN_PERCENT: z.coerce.number().min(50).max(99).default(90),
    MONITOR_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(10_737_418_240),
    MONITOR_QUEUE_WARN_COUNT: z.coerce.number().int().min(1).default(20),
    MONITOR_HEALTH_URLS: z.string().default('http://api:3000/health/ready,http://frontend:8080/healthz'),
    MONITOR_ALERT_WEBHOOK_URL: optionalHttpsUrl,
    MONITOR_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
    CORS_ORIGINS: z.string().optional(),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().default('1 minute'),
    COMPLETED_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
    FAILED_RETENTION_DAYS: z.coerce.number().int().min(0).default(3),
    SOURCE_RETENTION_DAYS: z.coerce.number().int().min(0).default(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: booleanString,
  })
  .superRefine((value, ctx) => {
    if (!value.TEST_MODE && !value.API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['API_KEY'], message: 'API_KEY is required unless TEST_MODE=true' });
    }
    if (!value.TEST_MODE && !value.WEB_PROXY_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['WEB_PROXY_TOKEN'], message: 'WEB_PROXY_TOKEN is required unless TEST_MODE=true' });
    }
    if (Math.ceil(value.MAX_RESUMABLE_UPLOAD_BYTES / value.UPLOAD_CHUNK_SIZE_BYTES) > 10_000) {
      ctx.addIssue({ code: 'custom', path: ['UPLOAD_CHUNK_SIZE_BYTES'], message: 'Resumable uploads may not exceed 10,000 chunks' });
    }
  });

export type Config = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  testMode: boolean;
  apiHost: string;
  apiPort: number;
  dataDir: string;
  dbPath: string;
  whisperBaseUrl: string;
  apiKey?: string;
  webProxyToken?: string;
  maxUploadBytes: number;
  maxResumableUploadBytes: number;
  uploadChunkSizeBytes: number;
  uploadSessionTtlHours: number;
  uploadMaxActiveSessions: number;
  uploadMaxStagedBytes: number;
  uploadMaxInflightChunks: number;
  uploadFinalizerLeaseSeconds: number;
  maxDurationSeconds: number;
  maxConversionSeconds: number;
  maxWavBytes: number;
  ytDlpPath: string;
  youtubeMetadataTimeoutMs: number;
  youtubeDownloadTimeoutMs: number;
  workerPollMs: number;
  workerConcurrency: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  whisperTimeoutMs: number;
  defaultModel: string;
  chatGptPolishEnabled: boolean;
  chatGptPlanCredentialsPath: string;
  chatGptPolishModel: string;
  chatGptPolishTimeoutMs: number;
  chatGptPolishChunkChars: number;
  monitorIntervalSeconds: number;
  monitorFailureThreshold: number;
  monitorAlertRepeatMinutes: number;
  monitorDiskWarnPercent: number;
  monitorMinFreeBytes: number;
  monitorQueueWarnCount: number;
  monitorHealthUrls: string[];
  monitorAlertWebhookUrl?: string;
  monitorWebhookTimeoutMs: number;
  corsOrigins: string[];
  rateLimitMax: number;
  rateLimitWindow: string;
  completedRetentionDays: number;
  failedRetentionDays: number;
  sourceRetentionDays: number;
  logLevel: string;
  trustProxy: boolean;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  const optionalApiKey = parsed.API_KEY === undefined ? {} : { apiKey: parsed.API_KEY };
  const optionalWebProxyToken = parsed.WEB_PROXY_TOKEN === undefined ? {} : { webProxyToken: parsed.WEB_PROXY_TOKEN };
  const optionalMonitorWebhook = parsed.MONITOR_ALERT_WEBHOOK_URL === undefined ? {} : { monitorAlertWebhookUrl: parsed.MONITOR_ALERT_WEBHOOK_URL };
  const monitorHealthUrls = parsed.MONITOR_HEALTH_URLS.split(',').map((item) => item.trim()).filter(Boolean);
  for (const healthUrl of monitorHealthUrls) new URL(healthUrl);
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    testMode: parsed.TEST_MODE,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    dataDir,
    dbPath: path.resolve(parsed.DB_PATH ?? path.join(dataDir, 'whisper-hub.sqlite')),
    whisperBaseUrl: parsed.WHISPER_BASE_URL.replace(/\/$/, ''),
    ...optionalApiKey,
    ...optionalWebProxyToken,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxResumableUploadBytes: parsed.MAX_RESUMABLE_UPLOAD_BYTES,
    uploadChunkSizeBytes: parsed.UPLOAD_CHUNK_SIZE_BYTES,
    uploadSessionTtlHours: parsed.UPLOAD_SESSION_TTL_HOURS,
    uploadMaxActiveSessions: parsed.UPLOAD_MAX_ACTIVE_SESSIONS,
    uploadMaxStagedBytes: parsed.UPLOAD_MAX_STAGED_BYTES,
    uploadMaxInflightChunks: parsed.UPLOAD_MAX_INFLIGHT_CHUNKS,
    uploadFinalizerLeaseSeconds: parsed.UPLOAD_FINALIZER_LEASE_SECONDS,
    maxDurationSeconds: parsed.MAX_DURATION_SECONDS,
    maxConversionSeconds: parsed.MAX_CONVERSION_SECONDS,
    maxWavBytes: parsed.MAX_WAV_BYTES,
    ytDlpPath: parsed.YT_DLP_PATH,
    youtubeMetadataTimeoutMs: parsed.YOUTUBE_METADATA_TIMEOUT_MS,
    youtubeDownloadTimeoutMs: parsed.YOUTUBE_DOWNLOAD_TIMEOUT_MS,
    workerPollMs: parsed.WORKER_POLL_MS,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    jobLeaseSeconds: parsed.JOB_LEASE_SECONDS,
    jobMaxAttempts: parsed.JOB_MAX_ATTEMPTS,
    whisperTimeoutMs: parsed.WHISPER_TIMEOUT_MS,
    defaultModel: parsed.DEFAULT_MODEL,
    chatGptPolishEnabled: parsed.CHATGPT_POLISH_ENABLED,
    chatGptPlanCredentialsPath: path.resolve(parsed.CHATGPT_PLAN_CREDENTIALS_PATH),
    chatGptPolishModel: parsed.CHATGPT_POLISH_MODEL,
    chatGptPolishTimeoutMs: parsed.CHATGPT_POLISH_TIMEOUT_MS,
    chatGptPolishChunkChars: parsed.CHATGPT_POLISH_CHUNK_CHARS,
    monitorIntervalSeconds: parsed.MONITOR_INTERVAL_SECONDS,
    monitorFailureThreshold: parsed.MONITOR_FAILURE_THRESHOLD,
    monitorAlertRepeatMinutes: parsed.MONITOR_ALERT_REPEAT_MINUTES,
    monitorDiskWarnPercent: parsed.MONITOR_DISK_WARN_PERCENT,
    monitorMinFreeBytes: parsed.MONITOR_MIN_FREE_BYTES,
    monitorQueueWarnCount: parsed.MONITOR_QUEUE_WARN_COUNT,
    monitorHealthUrls,
    ...optionalMonitorWebhook,
    monitorWebhookTimeoutMs: parsed.MONITOR_WEBHOOK_TIMEOUT_MS,
    corsOrigins: parsed.CORS_ORIGINS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    rateLimitWindow: parsed.RATE_LIMIT_WINDOW,
    completedRetentionDays: parsed.COMPLETED_RETENTION_DAYS,
    failedRetentionDays: parsed.FAILED_RETENTION_DAYS,
    sourceRetentionDays: parsed.SOURCE_RETENTION_DAYS,
    logLevel: parsed.LOG_LEVEL,
    trustProxy: parsed.TRUST_PROXY,
  });
}

