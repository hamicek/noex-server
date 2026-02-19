import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { IdentityManager } from '../../../src/identity/identity-manager.js';
import { SYSTEM_BUCKET_NAMES, SYSTEM_ROLES } from '../../../src/identity/identity-types.js';
import type { IdentityConfig, RoleRecord } from '../../../src/identity/identity-types.js';

const DEFAULT_CONFIG: IdentityConfig = {
  adminSecret: 'test-secret-key-for-bootstrap',
};

describe('IdentityManager', () => {
  let store: Store;
  let manager: IdentityManager;
  let storeCounter = 0;

  beforeEach(async () => {
    store = await Store.start({ name: `identity-mgr-test-${++storeCounter}` });
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
    if (store) {
      await store.stop();
    }
  });

  // ── start() ──────────────────────────────────────────────────────

  describe('start()', () => {
    it('creates all system buckets', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      for (const name of SYSTEM_BUCKET_NAMES) {
        expect(store.hasBucket(name)).toBe(true);
      }
    });

    it('creates all 4 system roles', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const roles = await store.bucket('_roles').all() as RoleRecord[];
      const roleNames = roles.map((r) => r.name).sort();

      expect(roleNames).toEqual([...SYSTEM_ROLES].sort());
    });

    it('marks system roles with system: true', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const roles = await store.bucket('_roles').all() as RoleRecord[];
      for (const role of roles) {
        expect(role.system).toBe(true);
      }
    });

    it('superadmin role has wildcard permissions', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const roles = await store.bucket('_roles').where({ name: 'superadmin' }) as RoleRecord[];
      expect(roles).toHaveLength(1);
      expect(roles[0]!.permissions).toEqual([{ allow: '*' }]);
    });

    it('reader role has only read permissions', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const roles = await store.bucket('_roles').where({ name: 'reader' }) as RoleRecord[];
      expect(roles).toHaveLength(1);

      const permissions = roles[0]!.permissions;
      const allAllowed = permissions.flatMap((p) =>
        Array.isArray(p.allow) ? p.allow : [p.allow],
      );

      // Reader should not have any write/admin operations
      for (const op of allAllowed) {
        expect(op).not.toContain('insert');
        expect(op).not.toContain('update');
        expect(op).not.toContain('delete');
        expect(op).not.toContain('clear');
        expect(op).not.toContain('defineBucket');
        expect(op).not.toContain('dropBucket');
      }
    });

    it('exposes store and config', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      expect(manager.store).toBe(store);
      expect(manager.config).toBe(DEFAULT_CONFIG);
    });
  });

  // ── idempotency ──────────────────────────────────────────────────

  describe('idempotent restart', () => {
    it('second start does not duplicate system roles', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);
      await manager.stop();

      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const roles = await store.bucket('_roles').all() as RoleRecord[];
      expect(roles).toHaveLength(4);
    });

    it('preserves existing data across restart', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      // Simulate a user that was created
      await store.bucket('_users').insert({
        username: 'testuser',
        passwordHash: '$scrypt$fake$hash',
        enabled: true,
      });

      await manager.stop();

      // Restart
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);

      const users = await store.bucket('_users').where({ username: 'testuser' });
      expect(users).toHaveLength(1);
      expect(users[0]!['username']).toBe('testuser');
    });
  });

  // ── stop() ───────────────────────────────────────────────────────

  describe('stop()', () => {
    it('completes without error', async () => {
      manager = await IdentityManager.start(store, DEFAULT_CONFIG);
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });
});
