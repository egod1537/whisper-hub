export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'STORAGE_UNAVAILABLE'
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

  constructor(code: ErrorCode, message: string, statusCode = 500, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', 'An internal error occurred.');
}

