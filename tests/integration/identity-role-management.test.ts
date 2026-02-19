import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';

// ── Helpers ──────────────────────────────────────────────────────

let requestIdCounter = 1;

function connectClient(
  port: number,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
  });
}

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Identity Role Management', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  const ADMIN_SECRET = 'test-admin-secret';

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }
    server = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  async function setup(): Promise<void> {
    store = await Store.start({ name: `identity-role-mgmt-${++storeCounter}` });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth: {
        builtIn: true,
        adminSecret: ADMIN_SECRET,
      },
    });
  }

  async function superadminClient(): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    await sendRequest(ws, {
      type: 'identity.loginWithSecret',
      secret: ADMIN_SECRET,
    });
    return ws;
  }

  async function createAndLoginUser(
    username: string,
    password: string,
    roleName?: string,
  ): Promise<{ ws: WebSocket; userId: string }> {
    const admin = await superadminClient();

    const createResp = await sendRequest(admin, {
      type: 'identity.createUser',
      username,
      password,
    });
    const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

    if (roleName) {
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName,
      });
    }

    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    await sendRequest(ws, {
      type: 'identity.login',
      username,
      password,
    });

    return { ws, userId };
  }

  // ── identity.listRoles ─────────────────────────────────────────

  describe('identity.listRoles', () => {
    it('returns system roles after server start', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, { type: 'identity.listRoles' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const roles = data['roles'] as Array<Record<string, unknown>>;
      expect(roles.length).toBeGreaterThanOrEqual(4);

      const roleNames = roles.map((r) => r['name']);
      expect(roleNames).toContain('superadmin');
      expect(roleNames).toContain('admin');
      expect(roleNames).toContain('writer');
      expect(roleNames).toContain('reader');

      for (const role of roles) {
        expect(role['system']).toBe(true);
        expect(typeof role['id']).toBe('string');
        expect(role['_version']).toBeUndefined();
      }
    });

    it('admin can list roles', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, { type: 'identity.listRoles' });
      expect(resp['type']).toBe('result');
    });

    it('rejects non-admin user', async () => {
      await setup();
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, { type: 'identity.listRoles' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.createRole ────────────────────────────────────────

  describe('identity.createRole', () => {
    it('creates a custom role', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'accountant',
        description: 'Accounting department role',
        permissions: [
          { allow: ['store.get', 'store.where'] },
          { allow: ['store.insert', 'store.update'], buckets: ['invoices'] },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('accountant');
      expect(data['description']).toBe('Accounting department role');
      expect(data['system']).toBe(false);
      expect(typeof data['id']).toBe('string');
      expect(data['permissions']).toEqual([
        { allow: ['store.get', 'store.where'] },
        { allow: ['store.insert', 'store.update'], buckets: ['invoices'] },
      ]);
    });

    it('creates a role without permissions', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'viewer',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('viewer');
      expect(data['permissions']).toEqual([]);
    });

    it('rejects duplicate role name', async () => {
      await setup();
      const ws = await superadminClient();

      await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'accountant',
      });

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'accountant',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('rejects name colliding with system role', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'admin',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('rejects empty name', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: '',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects admin (non-superadmin)', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'custom',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'custom',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });
  });

  // ── identity.updateRole ────────────────────────────────────────

  describe('identity.updateRole', () => {
    it('updates role description and permissions', async () => {
      await setup();
      const ws = await superadminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'accountant',
        description: 'Original',
      });
      const roleId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.updateRole',
        roleId,
        description: 'Updated description',
        permissions: [{ allow: ['store.get'] }],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['description']).toBe('Updated description');
      expect(data['permissions']).toEqual([{ allow: ['store.get'] }]);
    });

    it('returns NOT_FOUND for nonexistent role', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.updateRole',
        roleId: 'nonexistent-id',
        description: 'Updated',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('rejects admin (non-superadmin)', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, {
        type: 'identity.updateRole',
        roleId: 'some-id',
        description: 'hacked',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.deleteRole ────────────────────────────────────────

  describe('identity.deleteRole', () => {
    it('deletes a custom role', async () => {
      await setup();
      const ws = await superadminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'temp-role',
      });
      const roleId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const deleteResp = await sendRequest(ws, {
        type: 'identity.deleteRole',
        roleId,
      });

      expect(deleteResp['type']).toBe('result');
      expect((deleteResp['data'] as Record<string, unknown>)['deleted']).toBe(true);

      // Verify role is gone from list
      const listResp = await sendRequest(ws, { type: 'identity.listRoles' });
      const roles = (listResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles.find((r) => r['id'] === roleId)).toBeUndefined();
    });

    it('rejects deleting system roles', async () => {
      await setup();
      const ws = await superadminClient();

      // Get admin role id
      const listResp = await sendRequest(ws, { type: 'identity.listRoles' });
      const roles = (listResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;

      for (const systemRoleName of ['superadmin', 'admin', 'writer', 'reader']) {
        const role = roles.find((r) => r['name'] === systemRoleName)!;
        const resp = await sendRequest(ws, {
          type: 'identity.deleteRole',
          roleId: role['id'] as string,
        });

        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('FORBIDDEN');
      }
    });

    it('cleans up user-role assignments on delete', async () => {
      await setup();
      const ws = await superadminClient();

      // Create custom role and assign to user
      const roleResp = await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'custom',
      });
      const roleId = (roleResp['data'] as Record<string, unknown>)['id'] as string;

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, {
        type: 'identity.assignRole',
        userId,
        roleName: 'custom',
      });

      // Verify assignment exists
      const rolesBeforeResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const rolesBefore = (rolesBeforeResp['data'] as Record<string, unknown>)['roles'] as unknown[];
      expect(rolesBefore.length).toBe(1);

      // Delete role
      await sendRequest(ws, {
        type: 'identity.deleteRole',
        roleId,
      });

      // Verify assignment is cleaned up
      const rolesAfterResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const rolesAfter = (rolesAfterResp['data'] as Record<string, unknown>)['roles'] as unknown[];
      expect(rolesAfter.length).toBe(0);
    });

    it('returns NOT_FOUND for nonexistent role', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.deleteRole',
        roleId: 'nonexistent-id',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('rejects admin (non-superadmin)', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, {
        type: 'identity.deleteRole',
        roleId: 'some-id',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.assignRole ────────────────────────────────────────

  describe('identity.assignRole', () => {
    it('assigns a role to a user', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['assigned']).toBe(true);

      // Verify via getUserRoles
      const rolesResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const roles = (rolesResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles).toHaveLength(1);
      expect(roles[0]!['name']).toBe('writer');
    });

    it('assigns multiple roles to a user', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });
      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'reader' });

      const rolesResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const roles = (rolesResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles).toHaveLength(2);
      const roleNames = roles.map((r) => r['name']);
      expect(roleNames).toContain('writer');
      expect(roleNames).toContain('reader');
    });

    it('rejects duplicate assignment', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });

      const resp = await sendRequest(ws, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('rejects nonexistent user', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.assignRole',
        userId: 'nonexistent-id',
        roleName: 'writer',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('rejects nonexistent role', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.assignRole',
        userId,
        roleName: 'nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('admin can assign roles', async () => {
      await setup();
      const ws = await superadminClient();

      // Create admin user
      const adminResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'admin1',
        password: 'password1234',
      });
      const adminId = (adminResp['data'] as Record<string, unknown>)['id'] as string;
      await sendRequest(ws, { type: 'identity.assignRole', userId: adminId, roleName: 'admin' });

      // Create target user
      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      // Login as admin and assign role
      const { ws: adminWs } = await connectClient(server!.port);
      clients.push(adminWs);
      await sendRequest(adminWs, {
        type: 'identity.login',
        username: 'admin1',
        password: 'password1234',
      });

      const resp = await sendRequest(adminWs, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      expect(resp['type']).toBe('result');
    });

    it('rejects non-admin', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'target',
        password: 'password1234',
      });
      const targetId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: writerWs } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(writerWs, {
        type: 'identity.assignRole',
        userId: targetId,
        roleName: 'reader',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('assigned role is reflected in login response', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });

      // Login as Alice and check roles
      const { ws: aliceWs } = await connectClient(server!.port);
      clients.push(aliceWs);
      const loginResp = await sendRequest(aliceWs, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });

      expect(loginResp['type']).toBe('result');
      const user = (loginResp['data'] as Record<string, unknown>)['user'] as Record<string, unknown>;
      expect(user['roles']).toEqual(['writer']);
    });
  });

  // ── identity.removeRole ────────────────────────────────────────

  describe('identity.removeRole', () => {
    it('removes a role from a user', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });

      const resp = await sendRequest(ws, {
        type: 'identity.removeRole',
        userId,
        roleName: 'writer',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['removed']).toBe(true);

      // Verify role is gone
      const rolesResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const roles = (rolesResp['data'] as Record<string, unknown>)['roles'] as unknown[];
      expect(roles).toHaveLength(0);
    });

    it('rejects removing a role user does not have', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.removeRole',
        userId,
        roleName: 'writer',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('rejects nonexistent role name', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.removeRole',
        userId,
        roleName: 'nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('removed role is reflected in next login', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });
      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'reader' });
      await sendRequest(ws, { type: 'identity.removeRole', userId, roleName: 'writer' });

      // Login and check roles
      const { ws: aliceWs } = await connectClient(server!.port);
      clients.push(aliceWs);
      const loginResp = await sendRequest(aliceWs, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });

      const user = (loginResp['data'] as Record<string, unknown>)['user'] as Record<string, unknown>;
      expect(user['roles']).toEqual(['reader']);
    });

    it('rejects non-admin', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'target',
        password: 'password1234',
      });
      const targetId = (userResp['data'] as Record<string, unknown>)['id'] as string;
      await sendRequest(ws, { type: 'identity.assignRole', userId: targetId, roleName: 'reader' });

      const { ws: writerWs } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(writerWs, {
        type: 'identity.removeRole',
        userId: targetId,
        roleName: 'reader',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.getUserRoles ──────────────────────────────────────

  describe('identity.getUserRoles', () => {
    it('returns empty array for user with no roles', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['roles']).toEqual([]);
    });

    it('returns full role info objects', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'writer' });

      const resp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });

      expect(resp['type']).toBe('result');
      const roles = (resp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles).toHaveLength(1);
      expect(roles[0]!['name']).toBe('writer');
      expect(roles[0]!['system']).toBe(true);
      expect(typeof roles[0]!['id']).toBe('string');
      expect(Array.isArray(roles[0]!['permissions'])).toBe(true);
      expect(roles[0]!['_version']).toBeUndefined();
    });

    it('returns NOT_FOUND for nonexistent user', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId: 'nonexistent-id',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('returns superadmin role for virtual superadmin', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId: '__superadmin__',
      });

      expect(resp['type']).toBe('result');
      const roles = (resp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles).toHaveLength(1);
      expect(roles[0]!['name']).toBe('superadmin');
    });

    it('rejects non-admin', async () => {
      await setup();
      const ws = await superadminClient();

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'target',
        password: 'password1234',
      });
      const targetId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: writerWs } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(writerWs, {
        type: 'identity.getUserRoles',
        userId: targetId,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.assignRole with custom roles ──────────────────────

  describe('custom role lifecycle', () => {
    it('create custom role, assign to user, verify via getUserRoles', async () => {
      await setup();
      const ws = await superadminClient();

      // Create custom role
      await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'auditor',
        description: 'Can audit',
        permissions: [{ allow: ['store.get', 'store.where'] }],
      });

      // Create user and assign custom role
      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'auditor' });

      const rolesResp = await sendRequest(ws, {
        type: 'identity.getUserRoles',
        userId,
      });
      const roles = (rolesResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      expect(roles).toHaveLength(1);
      expect(roles[0]!['name']).toBe('auditor');
      expect(roles[0]!['system']).toBe(false);
    });

    it('custom role shows up in login response', async () => {
      await setup();
      const ws = await superadminClient();

      await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'auditor',
      });

      const userResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, { type: 'identity.assignRole', userId, roleName: 'auditor' });

      const { ws: aliceWs } = await connectClient(server!.port);
      clients.push(aliceWs);
      const loginResp = await sendRequest(aliceWs, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });

      const user = (loginResp['data'] as Record<string, unknown>)['user'] as Record<string, unknown>;
      expect(user['roles']).toEqual(['auditor']);
    });

    it('custom role visible in listRoles after creation', async () => {
      await setup();
      const ws = await superadminClient();

      await sendRequest(ws, {
        type: 'identity.createRole',
        name: 'auditor',
      });

      const listResp = await sendRequest(ws, { type: 'identity.listRoles' });
      const roles = (listResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      const roleNames = roles.map((r) => r['name']);
      expect(roleNames).toContain('auditor');
    });
  });
});
