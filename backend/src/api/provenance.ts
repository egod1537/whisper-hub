import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../shared/config.js';
import type { JobOrigin } from '../shared/queue/types.js';

const trustedHeader = 'x-whisper-hub-web-token';

function equalSecret(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export function requestOrigin(request: FastifyRequest, config: Config): JobOrigin {
  const value = request.headers[trustedHeader];
  if (typeof value !== 'string' || !config.webProxyToken) return 'api';
  return equalSecret(value, config.webProxyToken) ? 'web' : 'api';
}

export const provenanceInternals = { trustedHeader };
