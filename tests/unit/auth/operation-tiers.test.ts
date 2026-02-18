import { describe, it, expect } from 'vitest';
import { getOperationTier } from '../../../src/auth/operation-tiers.js';
import type { OperationTier } from '../../../src/auth/operation-tiers.js';

describe('operation-tiers', () => {
  describe('getOperationTier', () => {
    // ── Admin tier ─────────────────────────────────────────────────

    it.each([
      'store.defineBucket',
      'store.dropBucket',
      'store.updateBucket',
      'store.getBucketSchema',
      'store.defineQuery',
      'store.undefineQuery',
      'store.listQueries',
      'rules.registerRule',
      'rules.unregisterRule',
      'rules.updateRule',
      'rules.enableRule',
      'rules.disableRule',
      'rules.getRule',
      'rules.getRules',
      'procedures.register',
      'procedures.unregister',
      'procedures.update',
      'procedures.list',
      'server.stats',
      'server.connections',
      'audit.query',
    ])('returns "admin" for %s', (operation) => {
      expect(getOperationTier(operation)).toBe('admin' satisfies OperationTier);
    });

    // ── Write tier ────────────────────────────────────────────────

    it.each([
      'store.insert',
      'store.update',
      'store.delete',
      'store.clear',
      'store.transaction',
      'rules.emit',
      'rules.setFact',
      'rules.deleteFact',
      'procedures.call',
    ])('returns "write" for %s', (operation) => {
      expect(getOperationTier(operation)).toBe('write' satisfies OperationTier);
    });

    // ── Read tier ─────────────────────────────────────────────────

    it.each([
      'store.get',
      'store.all',
      'store.where',
      'store.findOne',
      'store.count',
      'store.first',
      'store.last',
      'store.paginate',
      'store.sum',
      'store.avg',
      'store.min',
      'store.max',
      'store.subscribe',
      'store.unsubscribe',
      'store.buckets',
      'store.stats',
      'rules.getFact',
      'rules.queryFacts',
      'rules.getAllFacts',
      'rules.subscribe',
      'rules.unsubscribe',
      'rules.stats',
      'procedures.get',
    ])('returns "read" for %s', (operation) => {
      expect(getOperationTier(operation)).toBe('read' satisfies OperationTier);
    });

    // ── Unknown operations ────────────────────────────────────────

    it('returns null for auth operations', () => {
      expect(getOperationTier('auth.login')).toBeNull();
      expect(getOperationTier('auth.logout')).toBeNull();
      expect(getOperationTier('auth.whoami')).toBeNull();
    });

    it('returns null for ping', () => {
      expect(getOperationTier('ping')).toBeNull();
    });

    it('returns null for completely unknown operations', () => {
      expect(getOperationTier('foo.bar')).toBeNull();
      expect(getOperationTier('')).toBeNull();
    });
  });
});
