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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Identity E2E Scenarios', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  const ADMIN_SECRET = 'e2e-test-admin-secret';

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

  async function setup(overrides?: { sessionTtl?: number; audit?: Record<string, unknown> }): Promise<void> {
    store = await Store.start({ name: `identity-e2e-${++storeCounter}` });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth: {
        builtIn: true,
        adminSecret: ADMIN_SECRET,
        ...(overrides?.sessionTtl !== undefined ? { sessionTtl: overrides.sessionTtl } : {}),
      },
      ...(overrides?.audit !== undefined ? { audit: overrides.audit } : {}),
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
  ): Promise<{ ws: WebSocket; userId: string; token: string }> {
    const admin = await superadminClient();

    const createResp = await sendRequest(admin, {
      type: 'identity.createUser',
      username,
      password,
    });
    expect(createResp['type']).toBe('result');
    const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

    if (roleName) {
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName,
      });
    }

    await delay(50);

    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const loginResp = await sendRequest(ws, {
      type: 'identity.login',
      username,
      password,
    });
    expect(loginResp['type']).toBe('result');
    const token = (loginResp['data'] as Record<string, unknown>)['token'] as string;

    return { ws, userId, token };
  }

  // ── Scenario 1: Bootstrap Flow ──────────────────────────────────

  describe('bootstrap flow', () => {
    it('fresh server → loginWithSecret → createUser → assignRole → login → operate', async () => {
      await setup();

      // 1. Bootstrap: loginWithSecret
      const { ws: adminWs } = await connectClient(server!.port);
      clients.push(adminWs);
      const secretResp = await sendRequest(adminWs, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });
      expect(secretResp['type']).toBe('result');
      const saUser = (secretResp['data'] as Record<string, unknown>)['user'] as Record<string, unknown>;
      expect(saUser['username']).toBe('__superadmin__');
      expect(saUser['roles']).toEqual(['superadmin']);

      // 2. Create the first real admin user
      const createAdminResp = await sendRequest(adminWs, {
        type: 'identity.createUser',
        username: 'sysadmin',
        password: 'AdminPass123',
        displayName: 'System Administrator',
      });
      expect(createAdminResp['type']).toBe('result');
      const sysadminId = (createAdminResp['data'] as Record<string, unknown>)['id'] as string;

      // 3. Assign admin role
      const assignResp = await sendRequest(adminWs, {
        type: 'identity.assignRole',
        userId: sysadminId,
        roleName: 'admin',
      });
      expect(assignResp['type']).toBe('result');

      await delay(50);

      // 4. Create regular users
      const createWriterResp = await sendRequest(adminWs, {
        type: 'identity.createUser',
        username: 'writer1',
        password: 'WriterPass1',
      });
      expect(createWriterResp['type']).toBe('result');
      const writerId = (createWriterResp['data'] as Record<string, unknown>)['id'] as string;

      const assignWriterResp = await sendRequest(adminWs, {
        type: 'identity.assignRole',
        userId: writerId,
        roleName: 'writer',
      });
      expect(assignWriterResp['type']).toBe('result');

      // 5. Define a bucket for the application
      const defResp = await sendRequest(adminWs, {
        type: 'store.defineBucket',
        name: 'articles',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', auto: 'uuid' },
            title: { type: 'string' },
            body: { type: 'string' },
          },
        },
      });
      expect(defResp['type']).toBe('result');

      await delay(50);

      // 6. sysadmin logs in on a fresh connection and can operate
      const { ws: sysadminWs } = await connectClient(server!.port);
      clients.push(sysadminWs);
      const sysadminLogin = await sendRequest(sysadminWs, {
        type: 'identity.login',
        username: 'sysadmin',
        password: 'AdminPass123',
      });
      expect(sysadminLogin['type']).toBe('result');
      const sysadminUser = (sysadminLogin['data'] as Record<string, unknown>)['user'] as Record<string, unknown>;
      expect(sysadminUser['roles']).toEqual(['admin']);
      expect(sysadminUser['displayName']).toBe('System Administrator');

      // sysadmin can read from the bucket
      const readResp = await sendRequest(sysadminWs, {
        type: 'store.all',
        bucket: 'articles',
      });
      expect(readResp['type']).toBe('result');

      // 7. writer logs in and can write data
      const { ws: writerWs } = await connectClient(server!.port);
      clients.push(writerWs);
      const writerLogin = await sendRequest(writerWs, {
        type: 'identity.login',
        username: 'writer1',
        password: 'WriterPass1',
      });
      expect(writerLogin['type']).toBe('result');

      const insertResp = await sendRequest(writerWs, {
        type: 'store.insert',
        bucket: 'articles',
        data: { title: 'Hello World', body: 'First article' },
      });
      expect(insertResp['type']).toBe('result');

      // 8. Verify the written data can be read
      const allResp = await sendRequest(sysadminWs, {
        type: 'store.all',
        bucket: 'articles',
      });
      expect(allResp['type']).toBe('result');
      const records = allResp['data'] as Record<string, unknown>[];
      expect(records).toHaveLength(1);
      expect(records[0]!['title']).toBe('Hello World');
    });
  });

  // ── Scenario 2: Multi-user permission enforcement ─────────────

  describe('multi-user permission enforcement', () => {
    it('admin, writer, reader, no-role — each has correct access boundaries', async () => {
      await setup();

      // Setup: define a bucket
      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'products',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, name: { type: 'string' }, price: { type: 'number' } },
        },
      });

      // Seed data
      await sendRequest(admin, {
        type: 'store.insert',
        bucket: 'products',
        data: { name: 'Widget', price: 9.99 },
      });

      await delay(50);

      // Create all users
      const { ws: adminWs } = await createAndLoginUser('admin1', 'AdminPass1', 'admin');
      const { ws: writerWs } = await createAndLoginUser('writer1', 'WriterPass', 'writer');
      const { ws: readerWs } = await createAndLoginUser('reader1', 'ReaderPass', 'reader');
      const { ws: noRoleWs } = await createAndLoginUser('norole1', 'NoRolePass');

      // ── Admin: can do everything ──
      const adminRead = await sendRequest(adminWs, { type: 'store.all', bucket: 'products' });
      expect(adminRead['type']).toBe('result');
      expect((adminRead['data'] as unknown[]).length).toBeGreaterThanOrEqual(1);

      const adminInsert = await sendRequest(adminWs, {
        type: 'store.insert',
        bucket: 'products',
        data: { name: 'Gadget', price: 19.99 },
      });
      expect(adminInsert['type']).toBe('result');

      const adminDefine = await sendRequest(adminWs, {
        type: 'store.defineBucket',
        name: 'admin-only',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });
      expect(adminDefine['type']).toBe('result');

      // ── Writer: can read + write, cannot define buckets ──
      const writerRead = await sendRequest(writerWs, { type: 'store.all', bucket: 'products' });
      expect(writerRead['type']).toBe('result');
      expect((writerRead['data'] as unknown[]).length).toBeGreaterThanOrEqual(1);

      const writerInsert = await sendRequest(writerWs, {
        type: 'store.insert',
        bucket: 'products',
        data: { name: 'Doohickey', price: 5.99 },
      });
      expect(writerInsert['type']).toBe('result');

      const writerDefine = await sendRequest(writerWs, {
        type: 'store.defineBucket',
        name: 'hacked',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });
      expect(writerDefine['type']).toBe('error');
      expect(writerDefine['code']).toBe('FORBIDDEN');

      // ── Reader: can read, cannot write or define ──
      const readerRead = await sendRequest(readerWs, { type: 'store.all', bucket: 'products' });
      expect(readerRead['type']).toBe('result');
      expect((readerRead['data'] as unknown[]).length).toBeGreaterThanOrEqual(1);

      const readerInsert = await sendRequest(readerWs, {
        type: 'store.insert',
        bucket: 'products',
        data: { name: 'NoWay', price: 0 },
      });
      expect(readerInsert['type']).toBe('error');
      expect(readerInsert['code']).toBe('FORBIDDEN');

      const readerDefine = await sendRequest(readerWs, {
        type: 'store.defineBucket',
        name: 'hacked',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });
      expect(readerDefine['type']).toBe('error');
      expect(readerDefine['code']).toBe('FORBIDDEN');

      // ── No-role: cannot do anything on store ──
      const noRoleRead = await sendRequest(noRoleWs, { type: 'store.all', bucket: 'products' });
      expect(noRoleRead['type']).toBe('error');
      expect(noRoleRead['code']).toBe('FORBIDDEN');

      // But can still use self-service identity operations
      const whoami = await sendRequest(noRoleWs, { type: 'identity.whoami' });
      expect(whoami['type']).toBe('result');
      expect((whoami['data'] as Record<string, unknown>)['authenticated']).toBe(true);
    });

    it('writer cannot manage identity (create users, assign roles)', async () => {
      await setup();

      const { ws: writerWs } = await createAndLoginUser('writer1', 'WriterPass', 'writer');

      const createUserResp = await sendRequest(writerWs, {
        type: 'identity.createUser',
        username: 'hacked-user',
        password: 'HackedPass1',
      });
      expect(createUserResp['type']).toBe('error');
      expect(createUserResp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot manage identity', async () => {
      await setup();

      const { ws: readerWs, userId } = await createAndLoginUser('reader1', 'ReaderPass', 'reader');

      const listUsersResp = await sendRequest(readerWs, {
        type: 'identity.listUsers',
      });
      expect(listUsersResp['type']).toBe('error');
      expect(listUsersResp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Scenario 3: Ownership Flow ──────────────────────────────────

  describe('ownership flow', () => {
    it('user creates bucket → grants others → they operate → revoke → verify', async () => {
      await setup();

      // Alice (admin) creates a bucket — becomes owner
      const { ws: aliceWs, userId: aliceId } = await createAndLoginUser('alice', 'AlicePass1', 'admin');

      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'team-data',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, content: { type: 'string' } },
        },
      });

      await delay(50);

      // Verify alice is the owner
      const ownerResp = await sendRequest(aliceWs, {
        type: 'identity.getOwner',
        resourceType: 'bucket',
        resourceName: 'team-data',
      });
      expect(ownerResp['type']).toBe('result');
      const owner = (ownerResp['data'] as Record<string, unknown>)['owner'] as Record<string, unknown>;
      expect(owner['userId']).toBe(aliceId);

      // Create bob and charlie with no roles
      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'BobPass123');
      const { ws: charlieWs, userId: charlieId } = await createAndLoginUser('charlie', 'CharlieP1');

      // Bob and Charlie cannot access the bucket (no role, no ACL)
      const bobDeny = await sendRequest(bobWs, { type: 'store.all', bucket: 'team-data' });
      expect(bobDeny['type']).toBe('error');
      expect(bobDeny['code']).toBe('FORBIDDEN');

      // Alice grants bob read+write, charlie read only
      const grantBob = await sendRequest(aliceWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'team-data',
        operations: ['read', 'write'],
      });
      expect(grantBob['type']).toBe('result');

      const grantCharlie = await sendRequest(aliceWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: charlieId,
        resourceType: 'bucket',
        resourceName: 'team-data',
        operations: ['read'],
      });
      expect(grantCharlie['type']).toBe('result');

      await delay(100);

      // Bob can now read and write
      const bobInsert = await sendRequest(bobWs, {
        type: 'store.insert',
        bucket: 'team-data',
        data: { content: 'bob-data' },
      });
      expect(bobInsert['type']).toBe('result');

      // Charlie can read but not write
      const charlieRead = await sendRequest(charlieWs, { type: 'store.all', bucket: 'team-data' });
      expect(charlieRead['type']).toBe('result');
      const records = charlieRead['data'] as unknown[];
      expect(records).toHaveLength(1);

      const charlieInsert = await sendRequest(charlieWs, {
        type: 'store.insert',
        bucket: 'team-data',
        data: { content: 'charlie-hack' },
      });
      expect(charlieInsert['type']).toBe('error');
      expect(charlieInsert['code']).toBe('FORBIDDEN');

      // Alice revokes bob's write access
      await sendRequest(aliceWs, {
        type: 'identity.revoke',
        subjectType: 'user',
        subjectId: bobId,
        resourceType: 'bucket',
        resourceName: 'team-data',
        operations: ['write'],
      });

      await delay(100);

      // Bob can still read but no longer write
      const bobReadAfter = await sendRequest(bobWs, { type: 'store.all', bucket: 'team-data' });
      expect(bobReadAfter['type']).toBe('result');

      const bobInsertAfter = await sendRequest(bobWs, {
        type: 'store.insert',
        bucket: 'team-data',
        data: { content: 'denied' },
      });
      expect(bobInsertAfter['type']).toBe('error');
      expect(bobInsertAfter['code']).toBe('FORBIDDEN');

      // Verify effective access via myAccess
      const bobAccess = await sendRequest(bobWs, { type: 'identity.myAccess' });
      expect(bobAccess['type']).toBe('result');
      const bobResources = (bobAccess['data'] as Record<string, unknown>)['resources'] as Array<Record<string, unknown>>;
      const bobTeamData = bobResources.find((r) => r['resourceName'] === 'team-data');
      expect(bobTeamData).toBeDefined();
      expect(bobTeamData!['operations']).toEqual(['read']);
      expect(bobTeamData!['isOwner']).toBe(false);

      // Alice's myAccess shows she's the owner
      const aliceAccess = await sendRequest(aliceWs, { type: 'identity.myAccess' });
      expect(aliceAccess['type']).toBe('result');
      const aliceResources = (aliceAccess['data'] as Record<string, unknown>)['resources'] as Array<Record<string, unknown>>;
      const aliceTeamData = aliceResources.find((r) => r['resourceName'] === 'team-data');
      expect(aliceTeamData).toBeDefined();
      expect(aliceTeamData!['isOwner']).toBe(true);
    });

    it('ownership transfer changes who can grant', async () => {
      await setup();

      const { ws: aliceWs } = await createAndLoginUser('alice', 'AlicePass1', 'admin');
      const { ws: bobWs, userId: bobId } = await createAndLoginUser('bob', 'BobPass123');
      const { userId: charlieId } = await createAndLoginUser('charlie', 'CharlieP1');

      // Alice creates a bucket
      await sendRequest(aliceWs, {
        type: 'store.defineBucket',
        name: 'transferable',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      // Transfer ownership to bob
      const transfer = await sendRequest(aliceWs, {
        type: 'identity.transferOwner',
        resourceType: 'bucket',
        resourceName: 'transferable',
        newOwnerId: bobId,
      });
      expect(transfer['type']).toBe('result');

      await delay(50);

      // Bob (new owner) can now grant charlie access
      const grantResp = await sendRequest(bobWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: charlieId,
        resourceType: 'bucket',
        resourceName: 'transferable',
        operations: ['read'],
      });
      expect(grantResp['type']).toBe('result');
    });
  });

  // ── Scenario 4: Session Lifecycle ──────────────────────────────

  describe('session lifecycle', () => {
    it('login → operate → refresh → operate → logout → denied → re-login', async () => {
      await setup();

      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'notes',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' }, text: { type: 'string' } },
        },
      });

      await delay(50);

      // 1. Login
      const { ws, token: oldToken } = await createAndLoginUser('user1', 'UserPass12', 'writer');

      // 2. Operate
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'notes',
        data: { text: 'first note' },
      });
      expect(insertResp['type']).toBe('result');

      // 3. Refresh session
      const refreshResp = await sendRequest(ws, { type: 'identity.refreshSession' });
      expect(refreshResp['type']).toBe('result');
      const newToken = (refreshResp['data'] as Record<string, unknown>)['token'] as string;
      expect(newToken).not.toBe(oldToken);

      // 4. Operate with refreshed session
      const insertResp2 = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'notes',
        data: { text: 'second note' },
      });
      expect(insertResp2['type']).toBe('result');

      // 5. Old token is invalid for reconnect
      const { ws: reconnectWs } = await connectClient(server!.port);
      clients.push(reconnectWs);
      const oldTokenReconnect = await sendRequest(reconnectWs, {
        type: 'auth.login',
        token: oldToken,
      });
      expect(oldTokenReconnect['type']).toBe('error');
      expect(oldTokenReconnect['code']).toBe('UNAUTHORIZED');

      // 6. New token IS valid for reconnect
      const { ws: reconnectWs2 } = await connectClient(server!.port);
      clients.push(reconnectWs2);
      const newTokenReconnect = await sendRequest(reconnectWs2, {
        type: 'auth.login',
        token: newToken,
      });
      expect(newTokenReconnect['type']).toBe('result');

      // 7. Logout
      const logoutResp = await sendRequest(ws, { type: 'identity.logout' });
      expect(logoutResp['type']).toBe('result');

      // 8. Post-logout: operations denied
      const postLogout = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'notes',
        data: { text: 'denied' },
      });
      expect(postLogout['type']).toBe('error');
      expect(postLogout['code']).toBe('UNAUTHORIZED');

      // 9. Re-login on the same connection
      const reLogin = await sendRequest(ws, {
        type: 'identity.login',
        username: 'user1',
        password: 'UserPass12',
      });
      expect(reLogin['type']).toBe('result');

      // 10. Operations work again
      const insertResp3 = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'notes',
        data: { text: 'third note' },
      });
      expect(insertResp3['type']).toBe('result');
    });

    it('expired session blocks operations and requires re-login', async () => {
      await setup({ sessionTtl: 200 });

      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'temp',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      const { ws } = await createAndLoginUser('user1', 'UserPass12', 'writer');

      // Immediate operation succeeds
      const okResp = await sendRequest(ws, { type: 'store.all', bucket: 'temp' });
      expect(okResp['type']).toBe('result');

      // Wait for expiration
      await delay(400);

      // Operation fails
      const failResp = await sendRequest(ws, { type: 'store.all', bucket: 'temp' });
      expect(failResp['type']).toBe('error');
      expect(failResp['code']).toBe('UNAUTHORIZED');

      // Re-login on the same connection
      const reLogin = await sendRequest(ws, {
        type: 'identity.login',
        username: 'user1',
        password: 'UserPass12',
      });
      expect(reLogin['type']).toBe('result');

      // Operations work again
      const okResp2 = await sendRequest(ws, { type: 'store.all', bucket: 'temp' });
      expect(okResp2['type']).toBe('result');
    });

    it('token reconnect on a new connection preserves identity', async () => {
      await setup();

      const { token, userId } = await createAndLoginUser('user1', 'UserPass12', 'writer');

      // New connection using auth.login with token
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const reconnect = await sendRequest(ws2, {
        type: 'auth.login',
        token,
      });
      expect(reconnect['type']).toBe('result');
      expect((reconnect['data'] as Record<string, unknown>)['userId']).toBe(userId);

      // Verify whoami on the reconnected connection
      const whoami = await sendRequest(ws2, { type: 'identity.whoami' });
      expect(whoami['type']).toBe('result');
      expect((whoami['data'] as Record<string, unknown>)['authenticated']).toBe(true);
      expect((whoami['data'] as Record<string, unknown>)['userId']).toBe(userId);
    });
  });

  // ── Scenario 5: Security Edge Cases ──────────────────────────────

  describe('security edge cases', () => {
    it('disabled user cannot login', async () => {
      await setup();

      const admin = await superadminClient();

      // Create a user and then disable
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'disabled1',
        password: 'DisabledP1',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(admin, {
        type: 'identity.disableUser',
        userId,
      });

      await delay(50);

      // Attempt login — should fail
      const { ws } = await connectClient(server!.port);
      clients.push(ws);
      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'disabled1',
        password: 'DisabledP1',
      });
      expect(loginResp['type']).toBe('error');
      expect(loginResp['code']).toBe('UNAUTHORIZED');
      expect(loginResp['message']).toBe('Account disabled');
    });

    it('re-enabled user can login again', async () => {
      await setup();

      const admin = await superadminClient();

      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'toggle1',
        password: 'ToggleP123',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      // Disable
      await sendRequest(admin, { type: 'identity.disableUser', userId });
      await delay(50);

      // Can't login
      const { ws: ws1 } = await connectClient(server!.port);
      clients.push(ws1);
      const failResp = await sendRequest(ws1, {
        type: 'identity.login',
        username: 'toggle1',
        password: 'ToggleP123',
      });
      expect(failResp['type']).toBe('error');

      // Re-enable
      await sendRequest(admin, { type: 'identity.enableUser', userId });
      await delay(50);

      // Now login succeeds
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const okResp = await sendRequest(ws2, {
        type: 'identity.login',
        username: 'toggle1',
        password: 'ToggleP123',
      });
      expect(okResp['type']).toBe('result');
    });

    it('deleted user sessions are invalidated', async () => {
      await setup();

      const { ws, userId, token } = await createAndLoginUser('doomed', 'DoomedPass', 'writer');

      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'test-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });

      await delay(50);

      // User can operate
      const preDelete = await sendRequest(ws, { type: 'store.all', bucket: 'test-bucket' });
      expect(preDelete['type']).toBe('result');

      // Admin deletes the user
      const deleteResp = await sendRequest(admin, {
        type: 'identity.deleteUser',
        userId,
      });
      expect(deleteResp['type']).toBe('result');

      await delay(100);

      // Token reconnect on a new connection fails
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const reconnect = await sendRequest(ws2, {
        type: 'auth.login',
        token,
      });
      expect(reconnect['type']).toBe('error');
      expect(reconnect['code']).toBe('UNAUTHORIZED');
    });

    it('password change invalidates other sessions', async () => {
      await setup();

      const admin = await superadminClient();

      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'pwchange',
        password: 'OldPass123',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      await delay(50);

      // Login on two separate connections
      const { ws: conn1 } = await connectClient(server!.port);
      clients.push(conn1);
      const login1 = await sendRequest(conn1, {
        type: 'identity.login',
        username: 'pwchange',
        password: 'OldPass123',
      });
      expect(login1['type']).toBe('result');
      const token1 = (login1['data'] as Record<string, unknown>)['token'] as string;

      const { ws: conn2 } = await connectClient(server!.port);
      clients.push(conn2);
      const login2 = await sendRequest(conn2, {
        type: 'identity.login',
        username: 'pwchange',
        password: 'OldPass123',
      });
      expect(login2['type']).toBe('result');

      // Change password from conn1
      const changeResp = await sendRequest(conn1, {
        type: 'identity.changePassword',
        userId,
        currentPassword: 'OldPass123',
        newPassword: 'NewPass123',
      });
      expect(changeResp['type']).toBe('result');

      await delay(100);

      // conn1's old token should be invalidated too (changePassword invalidates ALL sessions)
      const { ws: reconnWs } = await connectClient(server!.port);
      clients.push(reconnWs);
      const reconnect = await sendRequest(reconnWs, {
        type: 'auth.login',
        token: token1,
      });
      expect(reconnect['type']).toBe('error');
      expect(reconnect['code']).toBe('UNAUTHORIZED');

      // Login with old password fails
      const { ws: freshWs } = await connectClient(server!.port);
      clients.push(freshWs);
      const oldPwLogin = await sendRequest(freshWs, {
        type: 'identity.login',
        username: 'pwchange',
        password: 'OldPass123',
      });
      expect(oldPwLogin['type']).toBe('error');

      // Login with new password works
      const { ws: freshWs2 } = await connectClient(server!.port);
      clients.push(freshWs2);
      const newPwLogin = await sendRequest(freshWs2, {
        type: 'identity.login',
        username: 'pwchange',
        password: 'NewPass123',
      });
      expect(newPwLogin['type']).toBe('result');
    });

    it('system buckets are inaccessible and invisible', async () => {
      await setup();

      const ws = await superadminClient();

      // Define a regular bucket so we can compare
      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'visible',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });

      // Cannot read system buckets
      for (const bucket of ['_users', '_roles', '_sessions', '_user_roles', '_acl', '_resource_owners']) {
        const resp = await sendRequest(ws, { type: 'store.all', bucket });
        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('FORBIDDEN');
      }

      // Cannot define bucket with _ prefix
      const defResp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: '_evil',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });
      expect(defResp['type']).toBe('error');
      expect(defResp['code']).toBe('FORBIDDEN');

      // System buckets hidden from bucket list
      const bucketsResp = await sendRequest(ws, { type: 'store.buckets' });
      expect(bucketsResp['type']).toBe('result');
      const names = (bucketsResp['data'] as Record<string, unknown>)['names'] as string[];
      expect(names).toContain('visible');
      expect(names.every((n) => !n.startsWith('_'))).toBe(true);
    });

    it('non-owner non-admin cannot grant access (grant escalation prevention)', async () => {
      await setup();

      // Superadmin creates bucket
      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'store.defineBucket',
        name: 'restricted',
        config: { key: 'id', schema: { id: { type: 'string', auto: 'uuid' } } },
      });

      // Create users
      const { ws: writerWs } = await createAndLoginUser('writer1', 'WriterP123', 'writer');
      const { userId: readerId } = await createAndLoginUser('reader1', 'ReaderP123', 'reader');

      // Writer tries to grant reader access to a bucket they don't own
      const grantResp = await sendRequest(writerWs, {
        type: 'identity.grant',
        subjectType: 'user',
        subjectId: readerId,
        resourceType: 'bucket',
        resourceName: 'restricted',
        operations: ['read'],
      });
      expect(grantResp['type']).toBe('error');
      expect(grantResp['code']).toBe('FORBIDDEN');
    });

    it('admin reset password works, user changePassword with wrong current fails', async () => {
      await setup();

      const admin = await superadminClient();

      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'resetme',
        password: 'Original1',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      await delay(50);

      // Login
      const { ws } = await connectClient(server!.port);
      clients.push(ws);
      await sendRequest(ws, {
        type: 'identity.login',
        username: 'resetme',
        password: 'Original1',
      });

      // changePassword with wrong current — UNAUTHORIZED
      const wrongResp = await sendRequest(ws, {
        type: 'identity.changePassword',
        userId,
        currentPassword: 'WrongCurr1',
        newPassword: 'NewPass123',
      });
      expect(wrongResp['type']).toBe('error');
      expect(wrongResp['code']).toBe('UNAUTHORIZED');

      // Admin resetPassword (no current needed)
      const resetResp = await sendRequest(admin, {
        type: 'identity.resetPassword',
        userId,
        newPassword: 'AdminReset',
      });
      expect(resetResp['type']).toBe('result');

      await delay(50);

      // Login with new password works
      const { ws: freshWs } = await connectClient(server!.port);
      clients.push(freshWs);
      const newLogin = await sendRequest(freshWs, {
        type: 'identity.login',
        username: 'resetme',
        password: 'AdminReset',
      });
      expect(newLogin['type']).toBe('result');
    });

    it('cannot delete virtual superadmin', async () => {
      await setup();

      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.deleteUser',
        userId: '__superadmin__',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot disable virtual superadmin', async () => {
      await setup();

      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'identity.disableUser',
        userId: '__superadmin__',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot delete system roles', async () => {
      await setup();

      const ws = await superadminClient();

      const rolesResp = await sendRequest(ws, { type: 'identity.listRoles' });
      const roles = (rolesResp['data'] as Record<string, unknown>)['roles'] as Array<Record<string, unknown>>;
      const writerRole = roles.find((r) => r['name'] === 'writer');
      expect(writerRole).toBeDefined();

      const deleteResp = await sendRequest(ws, {
        type: 'identity.deleteRole',
        roleId: writerRole!['id'] as string,
      });
      expect(deleteResp['type']).toBe('error');
      expect(deleteResp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Scenario 6: Audit logging of identity events ────────────────

  describe('audit logging of identity events', () => {
    it('identity operations are audited', async () => {
      await setup({ audit: { tiers: ['admin', 'write'] } });

      const ws = await superadminClient();

      // Perform identity operations
      const createResp = await sendRequest(ws, {
        type: 'identity.createUser',
        username: 'audited',
        password: 'AuditPass1',
      });
      expect(createResp['type']).toBe('result');
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      await sendRequest(ws, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      await delay(50);

      // Query audit log
      const auditResp = await sendRequest(ws, { type: 'audit.query' });
      expect(auditResp['type']).toBe('result');
      const entries = (auditResp['data'] as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;

      // Verify identity operations are present
      const createEntry = entries.find((e) => e['operation'] === 'identity.createUser');
      expect(createEntry).toBeDefined();
      expect(createEntry!['result']).toBe('success');
      expect((createEntry!['details'] as Record<string, unknown>)['username']).toBe('audited');

      const assignEntry = entries.find((e) => e['operation'] === 'identity.assignRole');
      expect(assignEntry).toBeDefined();
      expect(assignEntry!['result']).toBe('success');
      expect((assignEntry!['details'] as Record<string, unknown>)['roleName']).toBe('writer');
    });

    it('failed login attempts are audited', async () => {
      await setup({ audit: { tiers: ['admin', 'write'] } });

      // Attempt bad login
      const { ws } = await connectClient(server!.port);
      clients.push(ws);
      const failLogin = await sendRequest(ws, {
        type: 'identity.login',
        username: 'nonexistent',
        password: 'whatever1',
      });
      expect(failLogin['type']).toBe('error');

      // Query audit as superadmin
      const adminWs = await superadminClient();
      const auditResp = await sendRequest(adminWs, { type: 'audit.query' });
      const entries = (auditResp['data'] as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;

      const failedEntry = entries.find(
        (e) => e['operation'] === 'identity.login' && e['result'] === 'error',
      );
      expect(failedEntry).toBeDefined();
    });
  });
});
