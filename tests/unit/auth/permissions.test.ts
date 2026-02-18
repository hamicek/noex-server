import { describe, it, expect } from 'vitest';
import {
  checkPermissions,
  extractResource,
  isAllowed,
  matchPattern,
  operationMatches,
  resourceConstraintsSatisfied,
} from '../../../src/auth/permissions.js';
import type { AuthSession, PermissionConfig, PermissionRule } from '../../../src/config.js';
import type { ClientRequest } from '../../../src/protocol/types.js';

// ── Helpers ──────────────────────────────────────────────────────

const session: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
};

function req(type: string, extra?: Record<string, unknown>): ClientRequest {
  return { id: 1, type, ...extra } as ClientRequest;
}

// ── matchPattern ─────────────────────────────────────────────────

describe('matchPattern', () => {
  it('* matches any value', () => {
    expect(matchPattern('*', 'store.insert')).toBe(true);
    expect(matchPattern('*', 'rules.emit')).toBe(true);
    expect(matchPattern('*', 'anything')).toBe(true);
  });

  it('prefix.* matches operations starting with prefix.', () => {
    expect(matchPattern('store.*', 'store.insert')).toBe(true);
    expect(matchPattern('store.*', 'store.get')).toBe(true);
    expect(matchPattern('store.*', 'store.where')).toBe(true);
  });

  it('prefix.* does not match other prefixes', () => {
    expect(matchPattern('store.*', 'rules.emit')).toBe(false);
    expect(matchPattern('store.*', 'auth.login')).toBe(false);
  });

  it('prefix.* does not match the prefix alone (without dot)', () => {
    expect(matchPattern('store.*', 'store')).toBe(false);
  });

  it('exact pattern matches only exact value', () => {
    expect(matchPattern('store.insert', 'store.insert')).toBe(true);
    expect(matchPattern('store.insert', 'store.get')).toBe(false);
    expect(matchPattern('store.insert', 'store.insert.extra')).toBe(false);
  });

  it('non-wildcard pattern does not match partial values', () => {
    expect(matchPattern('store', 'store.insert')).toBe(false);
  });
});

// ── operationMatches ─────────────────────────────────────────────

describe('operationMatches', () => {
  it('matches single string pattern', () => {
    expect(operationMatches('store.insert', 'store.*')).toBe(true);
    expect(operationMatches('store.insert', 'store.insert')).toBe(true);
    expect(operationMatches('store.insert', 'store.get')).toBe(false);
  });

  it('matches if any pattern in array matches', () => {
    expect(operationMatches('store.insert', ['store.insert', 'store.update'])).toBe(true);
    expect(operationMatches('store.update', ['store.insert', 'store.update'])).toBe(true);
    expect(operationMatches('store.delete', ['store.insert', 'store.update'])).toBe(false);
  });

  it('handles wildcard in array', () => {
    expect(operationMatches('store.insert', ['rules.*', 'store.*'])).toBe(true);
  });
});

// ── resourceConstraintsSatisfied ─────────────────────────────────

describe('resourceConstraintsSatisfied', () => {
  it('returns true when rule has no constraints', () => {
    const rule: PermissionRule = { role: 'user', allow: '*' };
    expect(resourceConstraintsSatisfied('store.insert', 'users', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('rules.emit', 'order.created', rule)).toBe(true);
  });

  it('checks buckets for store operations', () => {
    const rule: PermissionRule = { role: 'user', allow: 'store.*', buckets: ['users', 'posts'] };
    expect(resourceConstraintsSatisfied('store.insert', 'users', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('store.insert', 'posts', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('store.insert', 'secrets', rule)).toBe(false);
  });

  it('ignores buckets constraint for non-store operations', () => {
    const rule: PermissionRule = { role: 'user', allow: '*', buckets: ['users'] };
    expect(resourceConstraintsSatisfied('rules.emit', 'order.created', rule)).toBe(true);
  });

  it('checks topics for rules operations', () => {
    const rule: PermissionRule = { role: 'user', allow: 'rules.*', topics: ['order.*', 'user.created'] };
    expect(resourceConstraintsSatisfied('rules.emit', 'order.created', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('rules.emit', 'order.shipped', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('rules.emit', 'user.created', rule)).toBe(true);
    expect(resourceConstraintsSatisfied('rules.emit', 'payment.processed', rule)).toBe(false);
  });

  it('ignores topics constraint for non-rules operations', () => {
    const rule: PermissionRule = { role: 'user', allow: '*', topics: ['order.*'] };
    expect(resourceConstraintsSatisfied('store.insert', 'users', rule)).toBe(true);
  });

  it('handles wildcard topics', () => {
    const rule: PermissionRule = { role: 'user', allow: 'rules.*', topics: ['*'] };
    expect(resourceConstraintsSatisfied('rules.emit', 'anything', rule)).toBe(true);
  });
});

// ── isAllowed ────────────────────────────────────────────────────

describe('isAllowed', () => {
  // ── Custom check override ───────────────────────────────────

  describe('custom check override', () => {
    it('check returning true allows access', () => {
      const perms: PermissionConfig = { check: () => true };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
    });

    it('check returning false denies access', () => {
      const perms: PermissionConfig = { check: () => false };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(false);
    });

    it('check returning undefined falls through to rules', () => {
      const perms: PermissionConfig = {
        check: () => undefined,
        rules: [{ role: 'user', allow: 'store.insert' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
    });

    it('check returning undefined falls through to default when no rule matches', () => {
      const perms: PermissionConfig = {
        check: () => undefined,
        default: 'deny',
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(false);
    });

    it('check receives correct arguments', () => {
      const calls: Array<[AuthSession, string, string]> = [];
      const perms: PermissionConfig = {
        check: (s, op, res) => {
          calls.push([s, op, res]);
          return true;
        },
      };
      isAllowed(session, 'store.insert', 'users', perms);
      expect(calls).toEqual([[session, 'store.insert', 'users']]);
    });
  });

  // ── Declarative rules ───────────────────────────────────────

  describe('declarative rules', () => {
    it('matching rule allows access', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: 'store.insert' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
    });

    it('no matching rule falls through to default', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'admin', allow: '*' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(false);
    });

    it('rule with wildcard allow matches any operation', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: '*' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'rules.emit', 'order.created', perms)).toBe(true);
    });

    it('rule with prefix wildcard matches operations with that prefix', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: 'store.*' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'store.get', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'rules.emit', 'topic', perms)).toBe(false);
    });

    it('rule with allow array matches any listed operation', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: ['store.insert', 'store.update'] }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'store.update', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'store.delete', 'users', perms)).toBe(false);
    });

    it('rule with bucket constraint restricts to specific buckets', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: 'store.*', buckets: ['users', 'posts'] }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'store.insert', 'posts', perms)).toBe(true);
      expect(isAllowed(session, 'store.insert', 'secrets', perms)).toBe(false);
    });

    it('rule with topic constraint restricts to specific topics', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'user', allow: 'rules.*', topics: ['order.*'] }],
      };
      expect(isAllowed(session, 'rules.emit', 'order.created', perms)).toBe(true);
      expect(isAllowed(session, 'rules.emit', 'user.created', perms)).toBe(false);
    });

    it('multiple rules — first full match wins', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [
          { role: 'user', allow: 'store.*', buckets: ['posts'] },
          { role: 'user', allow: 'store.*', buckets: ['users'] },
        ],
      };
      // Both buckets accessible via separate rules
      expect(isAllowed(session, 'store.insert', 'posts', perms)).toBe(true);
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(session, 'store.insert', 'secrets', perms)).toBe(false);
    });

    it('session with multiple roles can match rules for any role', () => {
      const multiRoleSession: AuthSession = {
        userId: 'user-1',
        roles: ['editor', 'viewer'],
      };
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [
          { role: 'editor', allow: ['store.insert', 'store.update'] },
          { role: 'viewer', allow: ['store.get', 'store.all'] },
        ],
      };
      expect(isAllowed(multiRoleSession, 'store.insert', 'users', perms)).toBe(true);
      expect(isAllowed(multiRoleSession, 'store.all', 'users', perms)).toBe(true);
      expect(isAllowed(multiRoleSession, 'store.delete', 'users', perms)).toBe(false);
    });

    it('rule role must match session role', () => {
      const perms: PermissionConfig = {
        default: 'deny',
        rules: [{ role: 'admin', allow: '*' }],
      };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(false);
    });

    it('empty rules array falls through to default', () => {
      expect(isAllowed(session, 'store.insert', 'users', { rules: [], default: 'deny' })).toBe(false);
      expect(isAllowed(session, 'store.insert', 'users', { rules: [], default: 'allow' })).toBe(true);
    });
  });

  // ── Default behavior ────────────────────────────────────────

  describe('default behavior', () => {
    it('defaults to allow when not specified', () => {
      expect(isAllowed(session, 'store.insert', 'users', {})).toBe(true);
    });

    it('explicit default allow', () => {
      expect(isAllowed(session, 'store.insert', 'users', { default: 'allow' })).toBe(true);
    });

    it('explicit default deny', () => {
      expect(isAllowed(session, 'store.insert', 'users', { default: 'deny' })).toBe(false);
    });
  });

  // ── Backward compatibility ──────────────────────────────────

  describe('backward compatibility', () => {
    it('old-style check-only config still works (allow)', () => {
      const perms: PermissionConfig = { check: () => true };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(true);
    });

    it('old-style check-only config still works (deny)', () => {
      const perms: PermissionConfig = { check: () => false };
      expect(isAllowed(session, 'store.insert', 'users', perms)).toBe(false);
    });
  });
});

// ── checkPermissions ─────────────────────────────────────────────

describe('checkPermissions', () => {
  it('passes when access is allowed', () => {
    expect(() =>
      checkPermissions(session, req('store.insert', { bucket: 'users' }), { check: () => true }),
    ).not.toThrow();
  });

  it('throws FORBIDDEN when access is denied', () => {
    expect(() =>
      checkPermissions(session, req('store.delete', { bucket: 'users' }), { check: () => false }),
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

  it('works with declarative rules', () => {
    const perms: PermissionConfig = {
      default: 'deny',
      rules: [{ role: 'user', allow: 'store.insert', buckets: ['users'] }],
    };

    // Allowed
    expect(() =>
      checkPermissions(session, req('store.insert', { bucket: 'users' }), perms),
    ).not.toThrow();

    // Denied — wrong bucket
    expect(() =>
      checkPermissions(session, req('store.insert', { bucket: 'secrets' }), perms),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));

    // Denied — wrong operation
    expect(() =>
      checkPermissions(session, req('store.delete', { bucket: 'users' }), perms),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});

// ── extractResource (existing tests preserved) ──────────────────

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
