import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../../../src/audit/audit-log.js';
import type { AuditEntry, AuditConfig } from '../../../src/audit/audit-types.js';

// ── Helpers ──────────────────────────────────────────────────────

function entry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: Date.now(),
    userId: 'user-1',
    sessionId: 'conn-1',
    operation: 'server.stats',
    resource: '*',
    result: 'success',
    remoteAddress: '127.0.0.1',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('AuditLog', () => {
  // ── Construction ──────────────────────────────────────────────

  describe('constructor', () => {
    it('creates with default config', () => {
      const log = new AuditLog();
      expect(log.size).toBe(0);
    });

    it('creates with custom config', () => {
      const log = new AuditLog({ maxEntries: 5, tiers: ['admin', 'write'] });
      expect(log.size).toBe(0);
    });
  });

  // ── shouldLog ─────────────────────────────────────────────────

  describe('shouldLog', () => {
    it('returns true for admin tier by default', () => {
      const log = new AuditLog();
      expect(log.shouldLog('admin')).toBe(true);
    });

    it('returns false for write tier by default', () => {
      const log = new AuditLog();
      expect(log.shouldLog('write')).toBe(false);
    });

    it('returns false for read tier by default', () => {
      const log = new AuditLog();
      expect(log.shouldLog('read')).toBe(false);
    });

    it('returns false for null tier', () => {
      const log = new AuditLog();
      expect(log.shouldLog(null)).toBe(false);
    });

    it('respects custom tiers config', () => {
      const log = new AuditLog({ tiers: ['admin', 'write'] });
      expect(log.shouldLog('admin')).toBe(true);
      expect(log.shouldLog('write')).toBe(true);
      expect(log.shouldLog('read')).toBe(false);
    });
  });

  // ── append / size ─────────────────────────────────────────────

  describe('append', () => {
    it('increments size', () => {
      const log = new AuditLog();
      log.append(entry());
      expect(log.size).toBe(1);
      log.append(entry());
      expect(log.size).toBe(2);
    });

    it('calls onEntry callback', () => {
      const onEntry = vi.fn();
      const log = new AuditLog({ onEntry });
      const e = entry();
      log.append(e);
      expect(onEntry).toHaveBeenCalledOnce();
      expect(onEntry).toHaveBeenCalledWith(e);
    });
  });

  // ── Ring buffer overflow ──────────────────────────────────────

  describe('ring buffer', () => {
    it('overwrites oldest entries when maxEntries exceeded', () => {
      const log = new AuditLog({ maxEntries: 3 });

      log.append(entry({ operation: 'op-1' }));
      log.append(entry({ operation: 'op-2' }));
      log.append(entry({ operation: 'op-3' }));
      expect(log.size).toBe(3);

      // Overwrite op-1
      log.append(entry({ operation: 'op-4' }));
      expect(log.size).toBe(3);

      const entries = log.query();
      expect(entries).toHaveLength(3);
      // Newest first
      expect(entries[0]!.operation).toBe('op-4');
      expect(entries[1]!.operation).toBe('op-3');
      expect(entries[2]!.operation).toBe('op-2');
    });

    it('handles double overflow correctly', () => {
      const log = new AuditLog({ maxEntries: 2 });

      log.append(entry({ operation: 'op-1' }));
      log.append(entry({ operation: 'op-2' }));
      log.append(entry({ operation: 'op-3' }));
      log.append(entry({ operation: 'op-4' }));
      log.append(entry({ operation: 'op-5' }));

      expect(log.size).toBe(2);
      const entries = log.query();
      expect(entries[0]!.operation).toBe('op-5');
      expect(entries[1]!.operation).toBe('op-4');
    });
  });

  // ── query ─────────────────────────────────────────────────────

  describe('query', () => {
    it('returns empty array when no entries', () => {
      const log = new AuditLog();
      expect(log.query()).toEqual([]);
    });

    it('returns all entries newest-first', () => {
      const log = new AuditLog();
      log.append(entry({ operation: 'op-1', timestamp: 1000 }));
      log.append(entry({ operation: 'op-2', timestamp: 2000 }));
      log.append(entry({ operation: 'op-3', timestamp: 3000 }));

      const entries = log.query();
      expect(entries).toHaveLength(3);
      expect(entries[0]!.operation).toBe('op-3');
      expect(entries[1]!.operation).toBe('op-2');
      expect(entries[2]!.operation).toBe('op-1');
    });

    // ── Filter: userId ────────────────────────────────────────

    it('filters by userId', () => {
      const log = new AuditLog();
      log.append(entry({ userId: 'alice' }));
      log.append(entry({ userId: 'bob' }));
      log.append(entry({ userId: 'alice' }));

      const entries = log.query({ userId: 'alice' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.userId === 'alice')).toBe(true);
    });

    // ── Filter: operation ─────────────────────────────────────

    it('filters by operation', () => {
      const log = new AuditLog();
      log.append(entry({ operation: 'server.stats' }));
      log.append(entry({ operation: 'server.connections' }));
      log.append(entry({ operation: 'server.stats' }));

      const entries = log.query({ operation: 'server.stats' });
      expect(entries).toHaveLength(2);
    });

    // ── Filter: result ────────────────────────────────────────

    it('filters by result', () => {
      const log = new AuditLog();
      log.append(entry({ result: 'success' }));
      log.append(entry({ result: 'error', error: 'fail' }));
      log.append(entry({ result: 'success' }));

      const errors = log.query({ result: 'error' });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.error).toBe('fail');
    });

    // ── Filter: time range ────────────────────────────────────

    it('filters by from timestamp', () => {
      const log = new AuditLog();
      log.append(entry({ timestamp: 1000 }));
      log.append(entry({ timestamp: 2000 }));
      log.append(entry({ timestamp: 3000 }));

      const entries = log.query({ from: 2000 });
      expect(entries).toHaveLength(2);
    });

    it('filters by to timestamp', () => {
      const log = new AuditLog();
      log.append(entry({ timestamp: 1000 }));
      log.append(entry({ timestamp: 2000 }));
      log.append(entry({ timestamp: 3000 }));

      const entries = log.query({ to: 2000 });
      expect(entries).toHaveLength(2);
    });

    it('filters by from + to range', () => {
      const log = new AuditLog();
      log.append(entry({ timestamp: 1000 }));
      log.append(entry({ timestamp: 2000 }));
      log.append(entry({ timestamp: 3000 }));
      log.append(entry({ timestamp: 4000 }));

      const entries = log.query({ from: 2000, to: 3000 });
      expect(entries).toHaveLength(2);
    });

    // ── Filter: limit ─────────────────────────────────────────

    it('respects limit', () => {
      const log = new AuditLog();
      for (let i = 0; i < 10; i++) {
        log.append(entry({ operation: `op-${i}` }));
      }

      const entries = log.query({ limit: 3 });
      expect(entries).toHaveLength(3);
      expect(entries[0]!.operation).toBe('op-9');
    });

    // ── Combined filters ──────────────────────────────────────

    it('combines multiple filters', () => {
      const log = new AuditLog();
      log.append(entry({ userId: 'alice', result: 'success', timestamp: 1000 }));
      log.append(entry({ userId: 'alice', result: 'error', error: 'e1', timestamp: 2000 }));
      log.append(entry({ userId: 'bob', result: 'error', error: 'e2', timestamp: 3000 }));
      log.append(entry({ userId: 'alice', result: 'error', error: 'e3', timestamp: 4000 }));

      const entries = log.query({ userId: 'alice', result: 'error' });
      expect(entries).toHaveLength(2);
      expect(entries[0]!.timestamp).toBe(4000);
      expect(entries[1]!.timestamp).toBe(2000);
    });

    it('limit applies after filter', () => {
      const log = new AuditLog();
      log.append(entry({ userId: 'alice', timestamp: 1000 }));
      log.append(entry({ userId: 'bob', timestamp: 2000 }));
      log.append(entry({ userId: 'alice', timestamp: 3000 }));
      log.append(entry({ userId: 'alice', timestamp: 4000 }));

      const entries = log.query({ userId: 'alice', limit: 2 });
      expect(entries).toHaveLength(2);
      // Newest first
      expect(entries[0]!.timestamp).toBe(4000);
      expect(entries[1]!.timestamp).toBe(3000);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('maxEntries of 1', () => {
      const log = new AuditLog({ maxEntries: 1 });
      log.append(entry({ operation: 'op-1' }));
      log.append(entry({ operation: 'op-2' }));

      expect(log.size).toBe(1);
      const entries = log.query();
      expect(entries[0]!.operation).toBe('op-2');
    });

    it('query with no matching results returns empty array', () => {
      const log = new AuditLog();
      log.append(entry({ userId: 'alice' }));

      expect(log.query({ userId: 'nobody' })).toEqual([]);
    });

    it('query with limit larger than size returns all entries', () => {
      const log = new AuditLog();
      log.append(entry());
      log.append(entry());

      expect(log.query({ limit: 100 })).toHaveLength(2);
    });

    it('null userId entries can be filtered', () => {
      const log = new AuditLog();
      log.append(entry({ userId: null }));
      log.append(entry({ userId: 'alice' }));

      const entries = log.query({ userId: 'alice' });
      expect(entries).toHaveLength(1);
    });
  });
});
