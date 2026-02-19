import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { IdentityManager } from '../../../src/identity/identity-manager.js';
import type { IdentityConfig, UserInfo } from '../../../src/identity/identity-types.js';
import { hashPassword } from '../../../src/identity/password-hasher.js';

const DEFAULT_CONFIG: IdentityConfig = {
  adminSecret: 'test-secret',
};

describe('IdentityManager — User CRUD', () => {
  let store: Store;
  let manager: IdentityManager;
  let storeCounter = 0;

  beforeEach(async () => {
    store = await Store.start({ name: `user-crud-test-${++storeCounter}` });
    manager = await IdentityManager.start(store, DEFAULT_CONFIG);
  });

  afterEach(async () => {
    await manager.stop();
    await store.stop();
  });

  // ── createUser ────────────────────────────────────────────────

  describe('createUser()', () => {
    it('creates a user with valid input', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        displayName: 'Alice Wonder',
        email: 'alice@example.com',
      });

      expect(user.username).toBe('alice');
      expect(user.displayName).toBe('Alice Wonder');
      expect(user.email).toBe('alice@example.com');
      expect(user.enabled).toBe(true);
      expect(user.id).toBeDefined();
      expect(user._createdAt).toBeGreaterThan(0);
    });

    it('strips passwordHash from the result', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      expect((user as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
    });

    it('creates user with enabled: false', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        enabled: false,
      });

      expect(user.enabled).toBe(false);
    });

    it('stores metadata', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        metadata: { role: 'developer', team: 'backend' },
      });

      expect(user.metadata).toEqual({ role: 'developer', team: 'backend' });
    });

    it('rejects duplicate username', async () => {
      await manager.createUser({ username: 'alice', password: 'password1234' });

      await expect(
        manager.createUser({ username: 'alice', password: 'different1234' }),
      ).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
    });

    it('rejects short username (< 3 chars)', async () => {
      await expect(
        manager.createUser({ username: 'ab', password: 'password1234' }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('3'),
      });
    });

    it('rejects short password (< 8 chars)', async () => {
      await expect(
        manager.createUser({ username: 'alice', password: 'short' }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('8'),
      });
    });

    it('the created user can log in', async () => {
      await manager.createUser({ username: 'alice', password: 'password1234' });

      const result = await manager.login('alice', 'password1234');
      expect(result.user.username).toBe('alice');
    });
  });

  // ── getUser ───────────────────────────────────────────────────

  describe('getUser()', () => {
    it('returns user info without passwordHash', async () => {
      const created = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        displayName: 'Alice',
      });

      const user = await manager.getUser(created.id);

      expect(user.id).toBe(created.id);
      expect(user.username).toBe('alice');
      expect(user.displayName).toBe('Alice');
      expect((user as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.getUser('nonexistent-id'),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // ── updateUser ────────────────────────────────────────────────

  describe('updateUser()', () => {
    let alice: UserInfo;

    beforeEach(async () => {
      alice = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        displayName: 'Alice',
        email: 'alice@example.com',
      });
    });

    it('updates displayName', async () => {
      const updated = await manager.updateUser(alice.id, {
        displayName: 'Alice Updated',
      });

      expect(updated.displayName).toBe('Alice Updated');
      expect(updated.email).toBe('alice@example.com'); // unchanged
    });

    it('updates email', async () => {
      const updated = await manager.updateUser(alice.id, {
        email: 'newalice@example.com',
      });

      expect(updated.email).toBe('newalice@example.com');
    });

    it('updates metadata', async () => {
      const updated = await manager.updateUser(alice.id, {
        metadata: { department: 'engineering' },
      });

      expect(updated.metadata).toEqual({ department: 'engineering' });
    });

    it('returns the same user when no changes provided', async () => {
      const updated = await manager.updateUser(alice.id, {});

      expect(updated.id).toBe(alice.id);
      expect(updated.username).toBe('alice');
    });

    it('does not include passwordHash in result', async () => {
      const updated = await manager.updateUser(alice.id, { displayName: 'New' });

      expect((updated as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.updateUser('nonexistent-id', { displayName: 'Test' }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // ── deleteUser ────────────────────────────────────────────────

  describe('deleteUser()', () => {
    it('deletes a user', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await manager.deleteUser(user.id);

      await expect(manager.getUser(user.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('deletes user sessions', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      // Create a session by logging in
      const loginResult = await manager.login('alice', 'password1234');

      await manager.deleteUser(user.id);

      // Session should be invalid
      const session = await manager.validateSession(loginResult.token);
      expect(session).toBeNull();
    });

    it('deletes user-role assignments', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      // Assign a role directly via store
      const roles = await store.bucket('_roles').where({ name: 'writer' }) as Array<{ id: string }>;
      await store.bucket('_user_roles').insert({
        userId: user.id,
        roleId: roles[0]!.id,
      });

      await manager.deleteUser(user.id);

      // User-role assignments should be gone
      const userRoles = await store.bucket('_user_roles').where({ userId: user.id });
      expect(userRoles).toHaveLength(0);
    });

    it('deletes ACL entries for the user', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      // Create an ACL entry
      await store.bucket('_acl').insert({
        subjectType: 'user',
        subjectId: user.id,
        resourceType: 'bucket',
        resourceName: 'test',
        operations: ['read', 'write'],
      });

      await manager.deleteUser(user.id);

      const aclEntries = await store.bucket('_acl').where({ subjectId: user.id });
      expect(aclEntries).toHaveLength(0);
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.deleteUser('nonexistent-id'),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // ── listUsers ─────────────────────────────────────────────────

  describe('listUsers()', () => {
    it('returns empty list when no users exist', async () => {
      const result = await manager.listUsers();

      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
    });

    it('lists users without passwordHash', async () => {
      await manager.createUser({ username: 'alice', password: 'password1234' });
      await manager.createUser({ username: 'bob', password: 'password1234' });

      const result = await manager.listUsers();

      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
      for (const user of result.users) {
        expect((user as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
      }
    });

    it('paginates correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.createUser({ username: `user${i}`, password: 'password1234' });
      }

      const page1 = await manager.listUsers({ page: 1, pageSize: 2 });
      expect(page1.users).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(2);

      const page2 = await manager.listUsers({ page: 2, pageSize: 2 });
      expect(page2.users).toHaveLength(2);

      const page3 = await manager.listUsers({ page: 3, pageSize: 2 });
      expect(page3.users).toHaveLength(1);
    });

    it('returns empty for page beyond total', async () => {
      await manager.createUser({ username: 'alice', password: 'password1234' });

      const result = await manager.listUsers({ page: 10, pageSize: 50 });
      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(1);
    });
  });

  // ── enableUser / disableUser ──────────────────────────────────

  describe('enableUser() / disableUser()', () => {
    it('disables a user', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const disabled = await manager.disableUser(user.id);
      expect(disabled.enabled).toBe(false);
    });

    it('enables a previously disabled user', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
        enabled: false,
      });

      const enabled = await manager.enableUser(user.id);
      expect(enabled.enabled).toBe(true);
    });

    it('disableUser invalidates sessions', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const loginResult = await manager.login('alice', 'password1234');

      await manager.disableUser(user.id);

      const session = await manager.validateSession(loginResult.token);
      expect(session).toBeNull();
    });

    it('disabled user cannot log in', async () => {
      await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const user = await manager.createUser({
        username: 'bob',
        password: 'password1234',
      });
      await manager.disableUser(user.id);

      await expect(
        manager.login('bob', 'password1234'),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Account disabled',
      });
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.enableUser('nonexistent-id'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        manager.disableUser('nonexistent-id'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('strips passwordHash from result', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const enabled = await manager.enableUser(user.id);
      expect((enabled as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();

      const disabled = await manager.disableUser(user.id);
      expect((disabled as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
    });
  });

  // ── changePassword ────────────────────────────────────────────

  describe('changePassword()', () => {
    it('changes password when current password is correct', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await manager.changePassword(user.id, 'password1234', 'newpassword1234');

      // Old password should fail
      await expect(
        manager.login('alice', 'password1234'),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      // New password should work
      const result = await manager.login('alice', 'newpassword1234');
      expect(result.user.username).toBe('alice');
    });

    it('rejects wrong current password', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await expect(
        manager.changePassword(user.id, 'wrongpassword', 'newpassword1234'),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Current password is incorrect',
      });
    });

    it('rejects short new password', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await expect(
        manager.changePassword(user.id, 'password1234', 'short'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('invalidates all sessions', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const loginResult = await manager.login('alice', 'password1234');

      await manager.changePassword(user.id, 'password1234', 'newpassword1234');

      const session = await manager.validateSession(loginResult.token);
      expect(session).toBeNull();
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.changePassword('nonexistent', 'old12345', 'new12345678'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ── resetPassword ─────────────────────────────────────────────

  describe('resetPassword()', () => {
    it('resets password without verifying old password', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await manager.resetPassword(user.id, 'newpassword1234');

      // Old password should fail
      await expect(
        manager.login('alice', 'password1234'),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      // New password should work
      const result = await manager.login('alice', 'newpassword1234');
      expect(result.user.username).toBe('alice');
    });

    it('rejects short new password', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      await expect(
        manager.resetPassword(user.id, 'short'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('invalidates all sessions', async () => {
      const user = await manager.createUser({
        username: 'alice',
        password: 'password1234',
      });

      const loginResult = await manager.login('alice', 'password1234');

      await manager.resetPassword(user.id, 'newpassword1234');

      const session = await manager.validateSession(loginResult.token);
      expect(session).toBeNull();
    });

    it('throws NOT_FOUND for nonexistent user', async () => {
      await expect(
        manager.resetPassword('nonexistent', 'new12345678'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
