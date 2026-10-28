export type ErrorCode =
  | 'BAD_REQUEST'
  | 'CONTENT_LENGTH_REQUIRED'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_STORAGE'
  | 'STORAGE_UNAVAILABLE'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_STATE_CONFLICT'
  | 'UPLOAD_LIMIT_REACHED'
  | 'CHUNK_IN_PROGRESS'
  | 'CHUNK_CONFLICT'
  | 'CHUNK_LENGTH_INVALID'
  | 'CHUNK_HASH_MISMATCH'
  | 'INCOMPLETE_UPLOAD'
  | 'FILE_HASH_MISMATCH'
  | 'JOB_NOT_CANCELABLE'
  | 'JOB_NOT_RETRYABLE'
  | 'JOB_NOT_COMPLETE'
  | 'FORMAT_NOT_AVAILABLE'
  | 'MEDIA_INVALID'
  | 'DURATION_LIMIT_EXCEEDED'
  | 'LANGUAGE_UNSUPPORTED'
  | 'FORMAT_UNSUPPORTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'CONVERSION_FAILED'
  | 'CANCELED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, statusCode = 500, retryable = false, options?: ErrorOptions, details?: Record<string, unknown>) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', 'An internal error occurred.');
}

