import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { IdentityManager } from '../../../src/identity/identity-manager.js';
import { IdentityCache } from '../../../src/identity/identity-cache.js';
import type { IdentityConfig, RoleRecord, UserRoleRecord } from '../../../src/identity/identity-types.js';
import { SUPERADMIN_USER_ID } from '../../../src/identity/identity-types.js';

const DEFAULT_CONFIG: IdentityConfig = {
  adminSecret: 'test-secret',
};

describe('IdentityCache', () => {
  let store: Store;
  let manager: IdentityManager;
  let cache: IdentityCache;
  let storeCounter = 0;

  beforeEach(async () => {
    store = await Store.start({ name: `cache-test-${++storeCounter}` });
    // IdentityManager.start() creates system buckets, system roles, and the cache
    manager = await IdentityManager.start(store, DEFAULT_CONFIG);
    // Create a standalone cache for direct testing
    cache = await IdentityCache.start(store);
  });

  afterEach(async () => {
    await cache.stop();
    await manager.stop();
    await store.stop();
  });

  // ── Role loading ──────────────────────────────────────────────

  describe('role loading', () => {
    it('loads all system roles on start', () => {
      expect(cache.getRoleByName('superadmin')).toBeDefined();
      expect(cache.getRoleByName('admin')).toBeDefined();
      expect(cache.getRoleByName('writer')).toBeDefined();
      expect(cache.getRoleByName('reader')).toBeDefined();
    });

    it('role lookup by id matches lookup by name', () => {
      const writerByName = cache.getRoleByName('writer')!;
      const writerById = cache.getRole(writerByName.id)!;
      expect(writerById.name).toBe('writer');
      expect(writerById.id).toBe(writerByName.id);
    });

    it('returns undefined for nonexistent role', () => {
      expect(cache.getRoleByName('nonexistent')).toBeUndefined();
      expect(cache.getRole('nonexistent-id')).toBeUndefined();
    });
  });

  // ── User roles ────────────────────────────────────────────────

  describe('user roles', () => {
    it('returns empty set for user with no roles', async () => {
      const user = await store.bucket('_users').insert({
        username: 'noroles',
        passwordHash: '$scrypt$fake',
        enabled: true,
      });

      expect(cache.getUserRoleIds(user.id as string).size).toBe(0);
      expect(cache.getUserRoleNames(user.id as string)).toEqual([]);
      expect(cache.getUserRoles(user.id as string)).toEqual([]);
    });

    it('returns superadmin role for SUPERADMIN_USER_ID', () => {
      expect(cache.getUserRoleNames(SUPERADMIN_USER_ID)).toEqual(['superadmin']);

      const roles = cache.getUserRoles(SUPERADMIN_USER_ID);
      expect(roles).toHaveLength(1);
      expect(roles[0]!.name).toBe('superadmin');
    });

    it('reflects assigned roles after cache reload', async () => {
      const user = await store.bucket('_users').insert({
        username: 'alice',
        passwordHash: '$scrypt$fake',
        enabled: true,
      });
      const userId = user.id as string;

      const writerRole = cache.getRoleByName('writer')!;
      await store.bucket('_user_roles').insert({
        userId,
        roleId: writerRole.id,
      });

      // Wait for cache invalidation (event-based reload)
      await store.settle();
      await delay(50);

      const roleNames = cache.getUserRoleNames(userId);
      expect(roleNames).toContain('writer');

      const roleIds = cache.getUserRoleIds(userId);
      expect(roleIds.has(writerRole.id)).toBe(true);
    });
  });

  // ── ACL ───────────────────────────────────────────────────────

  describe('ACL', () => {
    it('returns null for nonexistent ACL', () => {
      expect(cache.getUserAcl('some-user', 'bucket', 'invoices')).toBeNull();
      expect(cache.getRoleAcl('some-role', 'bucket', 'invoices')).toBeNull();
    });

    it('loads user ACL entries', async () => {
      await store.bucket('_acl').insert({
        subjectType: 'user',
        subjectId: 'user-1',
        resourceType: 'bucket',
        resourceName: 'invoices',
        operations: ['read', 'write'],
      });

      await store.settle();
      await delay(50);

      const ops = cache.getUserAcl('user-1', 'bucket', 'invoices');
      expect(ops).toEqual(['read', 'write']);
    });

    it('loads role ACL entries', async () => {
      await store.bucket('_acl').insert({
        subjectType: 'role',
        subjectId: 'role-1',
        resourceType: 'bucket',
        resourceName: 'reports',
        operations: ['read'],
      });

      await store.settle();
      await delay(50);

      const ops = cache.getRoleAcl('role-1', 'bucket', 'reports');
      expect(ops).toEqual(['read']);
    });
  });

  // ── Ownership ─────────────────────────────────────────────────

  describe('ownership', () => {
    it('returns false when no ownership exists', () => {
      expect(cache.isOwner('user-1', 'bucket', 'invoices')).toBe(false);
    });

    it('loads ownership records', async () => {
      await store.bucket('_resource_owners').insert({
        userId: 'user-1',
        resourceType: 'bucket',
        resourceName: 'invoices',
        createdAt: Date.now(),
      });

      await store.settle();
      await delay(50);

      expect(cache.isOwner('user-1', 'bucket', 'invoices')).toBe(true);
      expect(cache.isOwner('user-1', 'bucket', 'other')).toBe(false);
      expect(cache.isOwner('user-2', 'bucket', 'invoices')).toBe(false);
    });
  });

  // ── Cache invalidation ────────────────────────────────────────

  describe('cache invalidation', () => {
    it('reloads roles when _roles bucket changes', async () => {
      await store.bucket('_roles').insert({
        name: 'custom',
        system: false,
        permissions: [{ allow: ['store.get'] }],
      });

      await store.settle();
      await delay(50);

      expect(cache.getRoleByName('custom')).toBeDefined();
      expect(cache.getRoleByName('custom')!.system).toBe(false);
    });

    it('reloads user-roles when _user_roles bucket changes', async () => {
      const user = await store.bucket('_users').insert({
        username: 'bob',
        passwordHash: '$scrypt$fake',
        enabled: true,
      });
      const userId = user.id as string;

      const readerRole = cache.getRoleByName('reader')!;

      // Assign role directly in store
      await store.bucket('_user_roles').insert({
        userId,
        roleId: readerRole.id,
      });

      await store.settle();
      await delay(50);

      expect(cache.getUserRoleNames(userId)).toContain('reader');
    });

    it('reloads ownership when _resource_owners changes', async () => {
      expect(cache.isOwner('user-x', 'bucket', 'data')).toBe(false);

      await store.bucket('_resource_owners').insert({
        userId: 'user-x',
        resourceType: 'bucket',
        resourceName: 'data',
        createdAt: Date.now(),
      });

      await store.settle();
      await delay(50);

      expect(cache.isOwner('user-x', 'bucket', 'data')).toBe(true);
    });

    it('reloads ACL when _acl bucket changes', async () => {
      expect(cache.getUserAcl('user-x', 'bucket', 'secret')).toBeNull();

      await store.bucket('_acl').insert({
        subjectType: 'user',
        subjectId: 'user-x',
        resourceType: 'bucket',
        resourceName: 'secret',
        operations: ['read'],
      });

      await store.settle();
      await delay(50);

      expect(cache.getUserAcl('user-x', 'bucket', 'secret')).toEqual(['read']);
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
