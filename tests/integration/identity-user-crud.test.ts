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

describe('Integration: Identity User CRUD', () => {
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
    store = await Store.start({ name: `identity-user-crud-${++storeCounter}` });
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

  async function adminClient(): Promise<WebSocket> {
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
  ): Promise<{ ws: WebSocket; userId: string; token: string }> {
    const admin = await adminClient();

    // Create user
    const createResp = await sendRequest(admin, {
      type: 'identity.createUser',
      username,
      password,
    });
    const userId = ((createResp['data'] as Record<string, unknown>)['id']) as string;

    // Optionally assign role
    if (roleName) {
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName,
      });
    }

    // Login as user
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const loginResp = await sendRequest(ws, {
      type: 'identity.login',
      username,
      password,
    });
    const token = ((loginResp['data'] as Record<string, unknown>)['token']) as string;

    return { ws, userId, token };
  }

  // ── identity.createUser ─────────────────────────────────────

  describe('identity.createUser', () => {
    it('creates a user with valid input', async () => {
      await setup();
      const ws = await adminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
        displayName: 'Alice',
        email: 'alice@example.com',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['username']).toBe('alice');
      expect(data['displayName']).toBe('Alice');
      expect(data['email']).toBe('alice@example.com');
      expect(data['enabled']).toBe(true);
      expect(data['passwordHash']).toBeUndefined();
    });

    it('rejects duplicate username', async () => {
      await setup();
      const ws = await adminClient();

      await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });

      const resp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'different1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('rejects short password', async () => {
      await setup();
      const ws = await adminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'short',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects non-admin user', async () => {
      await setup();

      // Create a user with writer role, then try to createUser
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'newuser',
        password: 'password1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated user', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });
  });

  // ── identity.getUser ──────────────────────────────────────────

  describe('identity.getUser', () => {
    it('returns user info without passwordHash', async () => {
      await setup();
      const ws = await adminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
        displayName: 'Alice',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const getResp = await sendRequest(ws, {
        type: 'identity.getUser',
        userId,
      });

      expect(getResp['type']).toBe('result');
      const data = getResp['data'] as Record<string, unknown>;
      expect(data['username']).toBe('alice');
      expect(data['displayName']).toBe('Alice');
      expect(data['passwordHash']).toBeUndefined();
    });

    it('returns NOT_FOUND for nonexistent user', async () => {
      await setup();
      const ws = await adminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.getUser',
        userId: 'nonexistent-id',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── identity.updateUser ───────────────────────────────────────

  describe('identity.updateUser', () => {
    it('admin can update any user', async () => {
      await setup();
      const ws = await adminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const updateResp = await sendRequest(ws, {
        type: 'identity.updateUser',
        userId,
        displayName: 'Alice Updated',
      });

      expect(updateResp['type']).toBe('result');
      expect((updateResp['data'] as Record<string, unknown>)['displayName']).toBe('Alice Updated');
    });

    it('user can update own profile', async () => {
      await setup();
      const { ws, userId } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'identity.updateUser',
        userId,
        displayName: 'Alice Self-Updated',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['displayName']).toBe('Alice Self-Updated');
    });

    it('user cannot update another user', async () => {
      await setup();
      const admin = await adminClient();

      // Create two users
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'bob',
        password: 'password1234',
      });
      const bobId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(aliceWs, {
        type: 'identity.updateUser',
        userId: bobId,
        displayName: 'Hacked',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.deleteUser ───────────────────────────────────────

  describe('identity.deleteUser', () => {
    it('admin deletes a user', async () => {
      await setup();
      const ws = await adminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const deleteResp = await sendRequest(ws, {
        type: 'identity.deleteUser',
        userId,
      });

      expect(deleteResp['type']).toBe('result');
      expect((deleteResp['data'] as Record<string, unknown>)['deleted']).toBe(true);

      // Verify user is gone
      const getResp = await sendRequest(ws, {
        type: 'identity.getUser',
        userId,
      });
      expect(getResp['type']).toBe('error');
      expect(getResp['code']).toBe('NOT_FOUND');
    });

    it('deleted user sessions are invalidated', async () => {
      await setup();

      // Create user and login
      const { ws: userWs, userId, token } = await createAndLoginUser('alice', 'password1234', 'reader');

      // Admin deletes the user
      const admin = await adminClient();
      await sendRequest(admin, {
        type: 'identity.deleteUser',
        userId,
      });

      // Try reconnecting with the old token
      const { ws: ws3 } = await connectClient(server!.port);
      clients.push(ws3);
      const reconnect = await sendRequest(ws3, {
        type: 'auth.login',
        token,
      });

      expect(reconnect['type']).toBe('error');
      expect(reconnect['code']).toBe('UNAUTHORIZED');
    });

    it('rejects non-admin', async () => {
      await setup();

      const admin = await adminClient();
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'bob',
        password: 'password1234',
      });
      const bobId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'writer');

      const resp = await sendRequest(aliceWs, {
        type: 'identity.deleteUser',
        userId: bobId,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.listUsers ────────────────────────────────────────

  describe('identity.listUsers', () => {
    it('lists users without passwordHash', async () => {
      await setup();
      const ws = await adminClient();

      await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'bob',
        password: 'password1234',
      });

      const resp = await sendRequest(ws, { type: 'identity.listUsers' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['total']).toBe(2);
      const users = data['users'] as Array<Record<string, unknown>>;
      expect(users).toHaveLength(2);
      for (const user of users) {
        expect(user['passwordHash']).toBeUndefined();
      }
    });

    it('paginates correctly', async () => {
      await setup();
      const ws = await adminClient();

      for (let i = 0; i < 5; i++) {
        await sendRequest(ws, {
          type: 'identity.createUser',
          username: `user${i}`,
          password: 'password1234',
        });
      }

      const resp = await sendRequest(ws, {
        type: 'identity.listUsers',
        page: 1,
        pageSize: 2,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect((data['users'] as unknown[]).length).toBe(2);
      expect(data['total']).toBe(5);
    });

    it('rejects non-admin', async () => {
      await setup();
      const { ws } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(ws, { type: 'identity.listUsers' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.enableUser / identity.disableUser ────────────────

  describe('identity.enableUser / identity.disableUser', () => {
    it('disables and enables a user', async () => {
      await setup();
      const ws = await adminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const disableResp = await sendRequest(ws, {
        type: 'identity.disableUser',
        userId,
      });
      expect(disableResp['type']).toBe('result');
      expect((disableResp['data'] as Record<string, unknown>)['enabled']).toBe(false);

      // Disabled user cannot login
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const loginResp = await sendRequest(ws2, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });
      expect(loginResp['type']).toBe('error');
      expect(loginResp['code']).toBe('UNAUTHORIZED');

      // Re-enable
      const enableResp = await sendRequest(ws, {
        type: 'identity.enableUser',
        userId,
      });
      expect(enableResp['type']).toBe('result');
      expect((enableResp['data'] as Record<string, unknown>)['enabled']).toBe(true);

      // Can login again
      const { ws: ws3 } = await connectClient(server!.port);
      clients.push(ws3);
      const loginResp2 = await sendRequest(ws3, {
        type: 'identity.login',
        username: 'alice',
        password: 'password1234',
      });
      expect(loginResp2['type']).toBe('result');
    });
  });

  // ── identity.changePassword ───────────────────────────────────

  describe('identity.changePassword', () => {
    it('user changes own password', async () => {
      await setup();
      const { ws, userId } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'identity.changePassword',
        userId,
        currentPassword: 'password1234',
        newPassword: 'newpassword1234',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['changed']).toBe(true);

      // Can login with new password
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const loginResp = await sendRequest(ws2, {
        type: 'identity.login',
        username: 'alice',
        password: 'newpassword1234',
      });
      expect(loginResp['type']).toBe('result');
    });

    it('rejects wrong current password', async () => {
      await setup();
      const { ws, userId } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'identity.changePassword',
        userId,
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('user cannot change another user password', async () => {
      await setup();

      const admin = await adminClient();
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'bob',
        password: 'password1234',
      });
      const bobId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'reader');

      const resp = await sendRequest(aliceWs, {
        type: 'identity.changePassword',
        userId: bobId,
        currentPassword: 'password1234',
        newPassword: 'newpassword1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── identity.resetPassword ────────────────────────────────────

  describe('identity.resetPassword', () => {
    it('admin resets password without knowing current', async () => {
      await setup();
      const ws = await adminClient();

      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'alice',
        password: 'password1234',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'identity.resetPassword',
        userId,
        newPassword: 'resetpassword1234',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['reset']).toBe(true);

      // Can login with new password
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const loginResp = await sendRequest(ws2, {
        type: 'identity.login',
        username: 'alice',
        password: 'resetpassword1234',
      });
      expect(loginResp['type']).toBe('result');
    });

    it('rejects non-admin', async () => {
      await setup();

      const admin = await adminClient();
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'bob',
        password: 'password1234',
      });
      const bobId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      const { ws: aliceWs } = await createAndLoginUser('alice', 'password1234', 'writer');

      const resp = await sendRequest(aliceWs, {
        type: 'identity.resetPassword',
        userId: bobId,
        newPassword: 'newpassword1234',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });
});
