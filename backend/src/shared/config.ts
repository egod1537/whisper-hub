import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(262_144_000),
    MAX_DURATION_SECONDS: z.coerce.number().positive().default(7_200),
    MAX_CONVERSION_SECONDS: z.coerce.number().int().positive().default(7_500),
    MAX_WAV_BYTES: z.coerce.number().int().positive().default(1_500_000_000),
    WORKER_POLL_MS: z.coerce.number().int().min(50).default(1_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    JOB_LEASE_SECONDS: z.coerce.number().int().min(60).default(900),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
    DEFAULT_MODEL: z.string().min(1).default('base'),
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
  maxUploadBytes: number;
  maxDurationSeconds: number;
  maxConversionSeconds: number;
  maxWavBytes: number;
  workerPollMs: number;
  workerConcurrency: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  whisperTimeoutMs: number;
  defaultModel: string;
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
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    testMode: parsed.TEST_MODE,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    dataDir,
    dbPath: path.resolve(parsed.DB_PATH ?? path.join(dataDir, 'whisper-hub.sqlite')),
    whisperBaseUrl: parsed.WHISPER_BASE_URL.replace(/\/$/, ''),
    ...optionalApiKey,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxDurationSeconds: parsed.MAX_DURATION_SECONDS,
    maxConversionSeconds: parsed.MAX_CONVERSION_SECONDS,
    maxWavBytes: parsed.MAX_WAV_BYTES,
    workerPollMs: parsed.WORKER_POLL_MS,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    jobLeaseSeconds: parsed.JOB_LEASE_SECONDS,
    jobMaxAttempts: parsed.JOB_MAX_ATTEMPTS,
    whisperTimeoutMs: parsed.WHISPER_TIMEOUT_MS,
    defaultModel: parsed.DEFAULT_MODEL,
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

