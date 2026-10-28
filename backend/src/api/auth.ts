import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../shared/config.js';
import { AppError } from '../shared/errors.js';

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function createAuthHandler(config: Config) {
  return async function authenticate(request: FastifyRequest, _reply?: FastifyReply): Promise<void> {
    if (config.testMode && config.apiKey === undefined) return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || !config.apiKey || !secureEqual(header.slice(7), config.apiKey)) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required.', 401);
    }
  };
}

