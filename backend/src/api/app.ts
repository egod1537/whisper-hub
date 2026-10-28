import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { Config } from '../shared/config.js';
import type { SqliteDatabase } from '../shared/db/connection.js';
import { AppError, safeError } from '../shared/errors.js';
import type { TranscriptionProvider } from '../shared/providers/interface.js';
import { JobRepository } from '../shared/queue/repository.js';
import { createAuthHandler } from './auth.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';

export async function buildApp(options: { config: Config; db: SqliteDatabase; provider: TranscriptionProvider; logger?: boolean }): Promise<FastifyInstance> {
  const { config, db, provider } = options;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel, redact: ['req.headers.authorization', 'headers.authorization'] },
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: config.rateLimitWindow });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins });
  }
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 2, fields: 3, parts: 4, fieldNameSize: 100, fieldSize: 1_024 },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Whisper Hub API', version: '1.0.0' },
      servers: [{ url: 'http://127.0.0.1:3000' }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: (document) => {
      if (!('openapiObject' in document)) return document.swaggerObject;
      const { openapiObject } = document;
      const operation = openapiObject.paths?.['/api/v1/jobs']?.post;
      if (operation && !('$ref' in operation)) {
        operation.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                additionalProperties: false,
                properties: {
                  file: { type: 'string', format: 'binary', description: 'Exactly one audio or video file.' },
                  language: { type: 'string', default: 'auto', description: 'Provider-supported ISO language code or auto.' },
                  formats: { type: 'string', default: 'txt,srt,json', description: 'Unique comma-separated subset of txt,srt,vtt,json.' },
                },
              },
            },
          },
        };
      }
      return openapiObject;
    },
  });
  const authenticate = createAuthHandler(config);
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiHooks: { onRequest: authenticate },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (request.url.startsWith('/api/v1/')) await authenticate(request, reply);
  });
  const repository = new JobRepository(db);
  await healthRoutes(app, { db, dataDir: config.dataDir });
  await jobRoutes(app, { config, repository, provider });
  app.setNotFoundHandler(async () => {
    throw new AppError('NOT_FOUND', 'Route not found.', 404);
  });
  app.setErrorHandler(async (error, request, reply) => {
    let appError: AppError;
    const errorRecord = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    if (error instanceof AppError) {
      appError = error;
    } else if (errorRecord.statusCode === 429) {
      appError = new AppError('RATE_LIMITED', 'Too many requests.', 429);
    } else if (errorRecord.statusCode === 413) {
      appError = new AppError('PAYLOAD_TOO_LARGE', 'Uploaded file is too large.', 413);
    } else if (typeof errorRecord.code === 'string' && ['ENOSPC', 'EROFS', 'EACCES', 'EDQUOT'].includes(errorRecord.code)) {
      appError = new AppError('STORAGE_UNAVAILABLE', 'Service storage is unavailable.', 503);
    } else if ('validation' in errorRecord || errorRecord.name === 'ZodError') {
      appError = new AppError('VALIDATION_FAILED', 'Request validation failed.', 422);
    } else if (typeof errorRecord.statusCode === 'number' && errorRecord.statusCode >= 400 && errorRecord.statusCode < 500) {
      appError = new AppError('BAD_REQUEST', 'Request is malformed.', 400);
    } else {
      appError = safeError(error);
    }
    const log = appError.statusCode >= 500 ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);
    log({ err: { code: appError.code, message: appError.message }, statusCode: appError.statusCode }, 'request failed');
    return reply.code(appError.statusCode).send({
      error: { code: appError.code, message: appError.message, requestId: request.id },
    });
  });
  await app.ready();
  return app;
}

