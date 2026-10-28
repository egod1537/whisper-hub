import type { FastifyInstance } from 'fastify';
import type { SqliteDatabase } from '../../shared/db/connection.js';
import { AppError } from '../../shared/errors.js';
import { isStorageWritable } from '../../shared/storage/files.js';
import { z } from 'zod';
import { errorResponseSchema } from '../schemas.js';

export async function healthRoutes(app: FastifyInstance, options: { db: SqliteDatabase; dataDir: string }): Promise<void> {
  app.get('/', {
    schema: {
      tags: ['system'],
      security: [],
      response: {
        200: z.object({
          name: z.literal('Whisper Hub API'),
          status: z.literal('ok'),
          version: z.literal('1.0.0'),
          health: z.object({
            live: z.literal('/health/live'),
            ready: z.literal('/health/ready'),
          }),
          api: z.object({ jobs: z.literal('/api/v1/jobs') }),
          documentation: z.literal('/docs'),
          authentication: z.literal('Bearer token required for /api/v1 and /docs'),
        }),
      },
    },
  }, async () => ({
    name: 'Whisper Hub API' as const,
    status: 'ok' as const,
    version: '1.0.0' as const,
    health: { live: '/health/live' as const, ready: '/health/ready' as const },
    api: { jobs: '/api/v1/jobs' as const },
    documentation: '/docs' as const,
    authentication: 'Bearer token required for /api/v1 and /docs' as const,
  }));

  app.get('/health/live', {
    schema: { tags: ['health'], security: [], response: { 200: z.object({ status: z.literal('ok') }) } },
  }, async () => ({ status: 'ok' }));

  app.get('/health/ready', {
    schema: {
      tags: ['health'], security: [],
      response: { 200: z.object({ status: z.literal('ok') }), 503: errorResponseSchema },
    },
  }, async () => {
    try {
      options.db.prepare('SELECT 1').get();
      if (!(await isStorageWritable(options.dataDir))) throw new Error('storage check failed');
      return { status: 'ok' };
    } catch {
      throw new AppError('STORAGE_UNAVAILABLE', 'Service storage is unavailable.', 503);
    }
  });
}

