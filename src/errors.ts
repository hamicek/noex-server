import type { ErrorCode } from './protocol/codes.js';

export class NoexServerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'NoexServerError';
    this.code = code;
    this.details = details;
  }
}
