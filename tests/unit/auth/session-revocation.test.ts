import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SessionBlacklist } from '../../../src/auth/session-revocation.js';

describe('SessionBlacklist', () => {
  // ── Construction ──────────────────────────────────────────────

  describe('constructor', () => {
    it('creates with default config', () => {
      const bl = new SessionBlacklist();
      expect(bl.size).toBe(0);
    });

    it('creates with custom TTL', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 5000 });
      expect(bl.size).toBe(0);
    });
  });

  // ── revoke / isRevoked ────────────────────────────────────────

  describe('revoke and isRevoked', () => {
    it('marks a userId as revoked', () => {
      const bl = new SessionBlacklist();
      bl.revoke('user-1');
      expect(bl.isRevoked('user-1')).toBe(true);
    });

    it('returns false for non-revoked userId', () => {
      const bl = new SessionBlacklist();
      expect(bl.isRevoked('user-1')).toBe(false);
    });

    it('increments size on revoke', () => {
      const bl = new SessionBlacklist();
      bl.revoke('user-1');
      expect(bl.size).toBe(1);
      bl.revoke('user-2');
      expect(bl.size).toBe(2);
    });

    it('does not duplicate on repeated revoke of same userId', () => {
      const bl = new SessionBlacklist();
      bl.revoke('user-1');
      bl.revoke('user-1');
      expect(bl.size).toBe(1);
      expect(bl.isRevoked('user-1')).toBe(true);
    });

    it('can revoke multiple different users', () => {
      const bl = new SessionBlacklist();
      bl.revoke('alice');
      bl.revoke('bob');
      bl.revoke('charlie');
      expect(bl.isRevoked('alice')).toBe(true);
      expect(bl.isRevoked('bob')).toBe(true);
      expect(bl.isRevoked('charlie')).toBe(true);
      expect(bl.isRevoked('dave')).toBe(false);
    });
  });

  // ── TTL expiration ────────────────────────────────────────────

  describe('TTL expiration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('entry expires after TTL', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 1000 });
      bl.revoke('user-1');
      expect(bl.isRevoked('user-1')).toBe(true);

      vi.advanceTimersByTime(999);
      expect(bl.isRevoked('user-1')).toBe(true);

      vi.advanceTimersByTime(1);
      expect(bl.isRevoked('user-1')).toBe(false);
    });

    it('expired entry is removed from map on isRevoked check', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 100 });
      bl.revoke('user-1');
      expect(bl.size).toBe(1);

      vi.advanceTimersByTime(100);
      bl.isRevoked('user-1');
      expect(bl.size).toBe(0);
    });

    it('re-revoking resets the TTL', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 1000 });
      bl.revoke('user-1');

      vi.advanceTimersByTime(800);
      expect(bl.isRevoked('user-1')).toBe(true);

      // Re-revoke resets the TTL
      bl.revoke('user-1');

      vi.advanceTimersByTime(800);
      expect(bl.isRevoked('user-1')).toBe(true);

      vi.advanceTimersByTime(200);
      expect(bl.isRevoked('user-1')).toBe(false);
    });

    it('uses default TTL of 1 hour', () => {
      const bl = new SessionBlacklist();
      bl.revoke('user-1');

      vi.advanceTimersByTime(3_599_999);
      expect(bl.isRevoked('user-1')).toBe(true);

      vi.advanceTimersByTime(1);
      expect(bl.isRevoked('user-1')).toBe(false);
    });
  });

  // ── unrevoke ──────────────────────────────────────────────────

  describe('unrevoke', () => {
    it('removes a revoked userId', () => {
      const bl = new SessionBlacklist();
      bl.revoke('user-1');
      expect(bl.isRevoked('user-1')).toBe(true);

      const removed = bl.unrevoke('user-1');
      expect(removed).toBe(true);
      expect(bl.isRevoked('user-1')).toBe(false);
      expect(bl.size).toBe(0);
    });

    it('returns false when userId was not revoked', () => {
      const bl = new SessionBlacklist();
      expect(bl.unrevoke('user-1')).toBe(false);
    });
  });

  // ── cleanup ───────────────────────────────────────────────────

  describe('cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes all expired entries', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 1000 });
      bl.revoke('user-1');
      bl.revoke('user-2');

      vi.advanceTimersByTime(500);
      bl.revoke('user-3');

      vi.advanceTimersByTime(500);
      // user-1 and user-2 expired, user-3 still active
      bl.cleanup();
      expect(bl.size).toBe(1);
      expect(bl.isRevoked('user-1')).toBe(false);
      expect(bl.isRevoked('user-2')).toBe(false);
      expect(bl.isRevoked('user-3')).toBe(true);
    });

    it('does nothing when no entries expired', () => {
      const bl = new SessionBlacklist({ blacklistTtlMs: 10_000 });
      bl.revoke('user-1');
      bl.revoke('user-2');
      bl.cleanup();
      expect(bl.size).toBe(2);
    });

    it('does nothing when empty', () => {
      const bl = new SessionBlacklist();
      bl.cleanup();
      expect(bl.size).toBe(0);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty string userId', () => {
      const bl = new SessionBlacklist();
      bl.revoke('');
      expect(bl.isRevoked('')).toBe(true);
      expect(bl.size).toBe(1);
    });

    it('TTL of 0 means entries expire immediately', () => {
      vi.useFakeTimers();
      const bl = new SessionBlacklist({ blacklistTtlMs: 0 });
      bl.revoke('user-1');
      expect(bl.isRevoked('user-1')).toBe(false);
      vi.useRealTimers();
    });
  });
});
