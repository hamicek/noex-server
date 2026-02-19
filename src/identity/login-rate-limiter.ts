import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

interface AttemptRecord {
  count: number;
  firstAttemptAt: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export class LoginRateLimiter {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #attempts = new Map<string, AttemptRecord>();

  constructor(maxAttempts?: number, windowMs?: number) {
    this.#maxAttempts = maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#windowMs = windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Check whether a key is currently locked out.
   * Expired records are lazily cleaned up here.
   * Throws RATE_LIMITED if the key has exceeded maxAttempts within the window.
   */
  check(key: string): void {
    const record = this.#attempts.get(key);
    if (record === undefined) return;

    const now = Date.now();

    if (now - record.firstAttemptAt > this.#windowMs) {
      this.#attempts.delete(key);
      return;
    }

    if (record.count >= this.#maxAttempts) {
      const retryAfterMs = this.#windowMs - (now - record.firstAttemptAt);
      throw new NoexServerError(
        ErrorCode.RATE_LIMITED,
        'Too many failed login attempts. Try again later.',
        { retryAfterMs },
      );
    }
  }

  /** Record a failed login attempt for the given key. */
  recordFailure(key: string): void {
    const now = Date.now();
    const record = this.#attempts.get(key);

    if (record === undefined || now - record.firstAttemptAt > this.#windowMs) {
      this.#attempts.set(key, { count: 1, firstAttemptAt: now });
    } else {
      record.count++;
    }
  }

  /** Reset attempt counter for a key (e.g. after successful login). */
  reset(key: string): void {
    this.#attempts.delete(key);
  }
}
