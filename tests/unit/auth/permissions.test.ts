import { describe, it, expect } from 'vitest';
import { checkPermissions, extractResource } from '../../../src/auth/permissions.js';
import type { AuthSession, PermissionConfig } from '../../../src/config.js';
import type { ClientRequest } from '../../../src/protocol/types.js';

// ── Helpers ──────────────────────────────────────────────────────

const session: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
};

function req(type: string, extra?: Record<string, unknown>): ClientRequest {
  return { id: 1, type, ...extra } as ClientRequest;
}

function allowAll(): PermissionConfig {
  return { check: () => true };
}

function denyAll(): PermissionConfig {
  return { check: () => false };
}

// ── Tests ────────────────────────────────────────────────────────

describe('permissions', () => {
  // ── checkPermissions ───────────────────────────────────────────

  describe('checkPermissions', () => {
    it('passes when check returns true', () => {
      expect(() =>
        checkPermissions(session, req('store.insert', { bucket: 'users' }), allowAll()),
      ).not.toThrow();
    });

    it('throws FORBIDDEN when check returns false', () => {
      expect(() =>
        checkPermissions(session, req('store.delete', { bucket: 'users' }), denyAll()),
      ).toThrow(
        expect.objectContaining({
          code: 'FORBIDDEN',
          message: 'No permission for store.delete on users',
        }),
      );
    });

    it('passes session, operation, and resource to check function', () => {
      const calls: Array<[AuthSession, string, string]> = [];
      const permissions: PermissionConfig = {
        check: (s, op, res) => {
          calls.push([s, op, res]);
          return true;
        },
      };

      checkPermissions(session, req('store.all', { bucket: 'orders' }), permissions);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([session, 'store.all', 'orders']);
    });
  });

  // ── extractResource ────────────────────────────────────────────

  describe('extractResource', () => {
    // Store operations
    it('returns bucket for store CRUD operations', () => {
      expect(extractResource(req('store.insert', { bucket: 'users' }))).toBe('users');
      expect(extractResource(req('store.get', { bucket: 'users', key: 'u1' }))).toBe('users');
      expect(extractResource(req('store.update', { bucket: 'users', key: 'u1', data: {} }))).toBe('users');
      expect(extractResource(req('store.delete', { bucket: 'users', key: 'u1' }))).toBe('users');
      expect(extractResource(req('store.all', { bucket: 'users' }))).toBe('users');
      expect(extractResource(req('store.where', { bucket: 'users', filter: {} }))).toBe('users');
      expect(extractResource(req('store.clear', { bucket: 'users' }))).toBe('users');
    });

    it('returns query name for store.subscribe', () => {
      expect(extractResource(req('store.subscribe', { query: 'all-users' }))).toBe('all-users');
    });

    it('returns subscriptionId for store.unsubscribe', () => {
      expect(extractResource(req('store.unsubscribe', { subscriptionId: 'sub-1' }))).toBe('sub-1');
    });

    it('returns * for store operations without bucket', () => {
      expect(extractResource(req('store.stats'))).toBe('*');
      expect(extractResource(req('store.buckets'))).toBe('*');
    });

    // Rules operations
    it('returns topic for rules.emit', () => {
      expect(extractResource(req('rules.emit', { topic: 'order.created' }))).toBe('order.created');
    });

    it('returns key for rules fact operations', () => {
      expect(extractResource(req('rules.setFact', { key: 'user:1:score' }))).toBe('user:1:score');
      expect(extractResource(req('rules.getFact', { key: 'user:1:score' }))).toBe('user:1:score');
      expect(extractResource(req('rules.deleteFact', { key: 'user:1:score' }))).toBe('user:1:score');
    });

    it('returns pattern for rules.queryFacts', () => {
      expect(extractResource(req('rules.queryFacts', { pattern: 'user:*' }))).toBe('user:*');
    });

    it('returns pattern for rules.subscribe', () => {
      expect(extractResource(req('rules.subscribe', { pattern: 'order.*' }))).toBe('order.*');
    });

    it('returns * for rules operations without identifiable resource', () => {
      expect(extractResource(req('rules.getAllFacts'))).toBe('*');
      expect(extractResource(req('rules.stats'))).toBe('*');
    });

    // Other
    it('returns * for non-store/non-rules operations', () => {
      expect(extractResource(req('ping'))).toBe('*');
    });
  });
});
