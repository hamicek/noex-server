import { describe, it, expect } from 'vitest';
import { LoginRateLimiter } from '../../../src/identity/login-rate-limiter.js';

describe('LoginRateLimiter', () => {
  // ── Basic behavior ────────────────────────────────────────────

  it('allows requests under the limit', () => {
    const limiter = new LoginRateLimiter(5, 60_000);

    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('user:alice');
    }

    expect(() => limiter.check('user:alice')).not.toThrow();
  });

  it('blocks after maxAttempts failures', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    for (let i = 0; i < 3; i++) {
      limiter.recordFailure('user:alice');
    }

    expect(() => limiter.check('user:alice')).toThrow('Too many failed login attempts');
  });

  it('throws RATE_LIMITED error code', () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    limiter.recordFailure('key');
    limiter.recordFailure('key');

    try {
      limiter.check('key');
      expect.unreachable('should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.details).toHaveProperty('retryAfterMs');
      expect(error.details.retryAfterMs).toBeGreaterThan(0);
      expect(error.details.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  // ── Per-key isolation ─────────────────────────────────────────

  it('tracks keys independently', () => {
    const limiter = new LoginRateLimiter(2, 60_000);

    limiter.recordFailure('user:alice');
    limiter.recordFailure('user:alice');

    expect(() => limiter.check('user:alice')).toThrow();
    expect(() => limiter.check('user:bob')).not.toThrow();
  });

  it('tracks username and IP keys independently', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    for (let i = 0; i < 3; i++) {
      limiter.recordFailure('ip:192.168.1.1');
    }

    // IP is locked out
    expect(() => limiter.check('ip:192.168.1.1')).toThrow();

    // But user key is still fine
    expect(() => limiter.check('user:alice')).not.toThrow();
  });

  // ── Reset ─────────────────────────────────────────────────────

  it('reset clears the counter for a key', () => {
    const limiter = new LoginRateLimiter(2, 60_000);

    limiter.recordFailure('user:alice');
    limiter.recordFailure('user:alice');
    expect(() => limiter.check('user:alice')).toThrow();

    limiter.reset('user:alice');
    expect(() => limiter.check('user:alice')).not.toThrow();
  });

  it('reset on one key does not affect other keys', () => {
    const limiter = new LoginRateLimiter(2, 60_000);

    limiter.recordFailure('ip:10.0.0.1');
    limiter.recordFailure('ip:10.0.0.1');
    limiter.recordFailure('user:alice');
    limiter.recordFailure('user:alice');

    limiter.reset('user:alice');

    // user key is cleared
    expect(() => limiter.check('user:alice')).not.toThrow();
    // IP key is still locked
    expect(() => limiter.check('ip:10.0.0.1')).toThrow();
  });

  // ── Window expiration ─────────────────────────────────────────

  it('expired window is cleaned up on check', async () => {
    const limiter = new LoginRateLimiter(2, 50); // 50ms window

    limiter.recordFailure('key');
    limiter.recordFailure('key');
    expect(() => limiter.check('key')).toThrow();

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 80));

    expect(() => limiter.check('key')).not.toThrow();
  });

  it('expired window resets the counter on recordFailure', async () => {
    const limiter = new LoginRateLimiter(2, 50);

    limiter.recordFailure('key');

    await new Promise((r) => setTimeout(r, 80));

    // This should start a fresh window, not add to old count
    limiter.recordFailure('key');
    expect(() => limiter.check('key')).not.toThrow();
  });

  // ── Configuration ─────────────────────────────────────────────

  it('uses default values when not configured', () => {
    const limiter = new LoginRateLimiter();

    // Should allow 4 failures without throwing (default is 5)
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('key');
    }
    expect(() => limiter.check('key')).not.toThrow();

    limiter.recordFailure('key');
    expect(() => limiter.check('key')).toThrow();
  });

  it('respects custom maxAttempts', () => {
    const limiter = new LoginRateLimiter(10, 60_000);

    for (let i = 0; i < 9; i++) {
      limiter.recordFailure('key');
    }
    expect(() => limiter.check('key')).not.toThrow();

    limiter.recordFailure('key');
    expect(() => limiter.check('key')).toThrow();
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('check on unknown key does nothing', () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    expect(() => limiter.check('nonexistent')).not.toThrow();
  });

  it('reset on unknown key does nothing', () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    expect(() => limiter.reset('nonexistent')).not.toThrow();
  });

  it('recordFailure after check still increments correctly', () => {
    const limiter = new LoginRateLimiter(3, 60_000);

    limiter.recordFailure('key');
    limiter.check('key'); // ok
    limiter.recordFailure('key');
    limiter.check('key'); // ok
    limiter.recordFailure('key');
    expect(() => limiter.check('key')).toThrow();
  });
});
