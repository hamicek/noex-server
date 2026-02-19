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

describe('Integration: Identity Permissions', () => {
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
    store = await Store.start({ name: `identity-perms-${++storeCounter}` });
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

  async function defineBucket(name: string): Promise<void> {
    const ws = await superadminClient();
    await sendRequest(ws, {
      type: 'store.defineBucket',
      name,
      config: {
        key: 'id',
        schema: { id: { type: 'string', auto: 'uuid' }, value: { type: 'string' } },
      },
    });
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

    // Wait for cache invalidation
    await delay(50);

    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    await sendRequest(ws, {
      type: 'identity.login',
      username,
      password,
    });

    return { ws, userId };
  }

  // ── Superadmin can do everything ──────────────────────────────

  describe('superadmin access', () => {
    it('superadmin can insert into a bucket', async () => {
      await setup();
      await defineBucket('items');
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'test' },
      });
      expect(resp['type']).toBe('result');
    });

    it('superadmin can defineBucket', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'new-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });
      expect(resp['type']).toBe('result');
    });

    it('superadmin can view server stats', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Writer permissions ────────────────────────────────────────

  describe('writer role', () => {
    it('writer can insert into a bucket', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'hello' },
      });
      expect(resp['type']).toBe('result');
    });

    it('writer can read from a bucket', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp['type']).toBe('result');
    });

    it('writer cannot defineBucket', async () => {
      await setup();
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'hacked',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot view server stats', async () => {
      await setup();
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer can list buckets', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('writer1', 'password1234', 'writer');

      const resp = await sendRequest(ws, { type: 'store.buckets' });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Reader permissions ────────────────────────────────────────

  describe('reader role', () => {
    it('reader can read from a bucket', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('reader1', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp['type']).toBe('result');
    });

    it('reader cannot insert', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('reader1', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'hack' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot delete', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('reader1', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'items',
        key: 'some-key',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot defineBucket', async () => {
      await setup();
      const { ws } = await createAndLoginUser('reader1', 'password1234', 'reader');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'hacked',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── No role (default deny) ────────────────────────────────────

  describe('user without role', () => {
    it('cannot read from a bucket', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('norole1', 'password1234');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot insert into a bucket', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('norole1', 'password1234');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'hack' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot list buckets', async () => {
      await setup();
      const { ws } = await createAndLoginUser('norole1', 'password1234');

      const resp = await sendRequest(ws, { type: 'store.buckets' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('can still use identity self-service operations', async () => {
      await setup();
      const { ws } = await createAndLoginUser('norole1', 'password1234');

      const resp = await sendRequest(ws, { type: 'identity.whoami' });
      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['authenticated']).toBe(true);
    });
  });

  // ── Admin permissions ─────────────────────────────────────────

  describe('admin role', () => {
    it('admin can defineBucket', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'admin-bucket',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });
      expect(resp['type']).toBe('result');
    });

    it('admin can view server stats', async () => {
      await setup();
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('result');
    });

    it('admin can insert and read', async () => {
      await setup();
      await defineBucket('items');
      const { ws } = await createAndLoginUser('admin1', 'password1234', 'admin');

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'admin-data' },
      });
      expect(insertResp['type']).toBe('result');

      const readResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(readResp['type']).toBe('result');
    });
  });

  // ── System bucket protection ──────────────────────────────────

  describe('system bucket protection', () => {
    it('cannot read from _users bucket directly', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: '_users',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
      expect(resp['message']).toContain('system bucket');
    });

    it('cannot insert into _roles bucket directly', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: '_roles',
        data: { name: 'hacked', system: false },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot defineBucket with _ prefix', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: '_hacked',
        config: {
          key: 'id',
          schema: { id: { type: 'string', auto: 'uuid' } },
        },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot dropBucket with _ prefix', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.dropBucket',
        name: '_users',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('cannot access system buckets in transaction', async () => {
      await setup();
      const ws = await superadminClient();

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'get', bucket: '_users', key: 'some-key' },
        ],
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('system buckets are invisible in store.buckets', async () => {
      await setup();

      // Define a user-facing bucket
      await defineBucket('items');

      const ws = await superadminClient();
      const resp = await sendRequest(ws, { type: 'store.buckets' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const names = data['names'] as string[];

      // User bucket should be visible
      expect(names).toContain('items');

      // System buckets should NOT be visible
      expect(names.every((n) => !n.startsWith('_'))).toBe(true);

      // Count should reflect only non-system buckets
      expect(data['count']).toBe(names.length);
    });
  });

  // ── Role change → immediate permission change ─────────────────

  describe('cache invalidation', () => {
    it('assigning a role immediately grants new permissions', async () => {
      await setup();
      await defineBucket('items');

      const admin = await superadminClient();

      // Create user with no roles
      const createResp = await sendRequest(admin, {
        type: 'identity.createUser',
        username: 'dynamic-user',
        password: 'password1234',
      });
      const userId = (createResp['data'] as Record<string, unknown>)['id'] as string;

      // Login user (no roles yet)
      const { ws: userWs } = await connectClient(server!.port);
      clients.push(userWs);
      await sendRequest(userWs, {
        type: 'identity.login',
        username: 'dynamic-user',
        password: 'password1234',
      });

      // Verify: cannot read (no role)
      const denyResp = await sendRequest(userWs, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(denyResp['type']).toBe('error');
      expect(denyResp['code']).toBe('FORBIDDEN');

      // Admin assigns writer role
      await sendRequest(admin, {
        type: 'identity.assignRole',
        userId,
        roleName: 'writer',
      });

      // Wait for cache invalidation
      await delay(100);

      // Verify: NOW the user CAN read (the cache sees the new role)
      // Note: the user's session roles are stale — but isAllowed checks the cache,
      // not the session roles. So the permission check passes.
      const allowResp = await sendRequest(userWs, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(allowResp['type']).toBe('result');
    });

    it('removing a role immediately revokes permissions', async () => {
      await setup();
      await defineBucket('items');

      // Create user with writer role
      const { ws: userWs, userId } = await createAndLoginUser(
        'dynamic-user',
        'password1234',
        'writer',
      );

      // Verify: can insert (writer role)
      const allowResp = await sendRequest(userWs, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'test' },
      });
      expect(allowResp['type']).toBe('result');

      // Remove writer role
      const admin = await superadminClient();
      await sendRequest(admin, {
        type: 'identity.removeRole',
        userId,
        roleName: 'writer',
      });

      // Wait for cache invalidation
      await delay(100);

      // Verify: DENIED now
      const denyResp = await sendRequest(userWs, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 'blocked' },
      });
      expect(denyResp['type']).toBe('error');
      expect(denyResp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Custom role permissions ───────────────────────────────────

  describe('custom role with specific permissions', () => {
    it('custom role with bucket constraint allows access to specific bucket only', async () => {
      await setup();
      await defineBucket('invoices');
      await defineBucket('secrets');

      const admin = await superadminClient();

      // Create custom role that can only read/write "invoices"
      await sendRequest(admin, {
        type: 'identity.createRole',
        name: 'accountant',
        permissions: [
          { allow: ['store.get', 'store.all', 'store.where', 'store.findOne', 'store.count'] },
          { allow: ['store.insert', 'store.update'], buckets: ['invoices'] },
          { allow: ['store.buckets'] },
        ],
      });

      // Wait for cache to pick up the new role
      await delay(50);

      const { ws } = await createAndLoginUser('alice', 'password1234', 'accountant');

      // Can insert into invoices
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'invoices',
        data: { value: 'invoice-1' },
      });
      expect(insertResp['type']).toBe('result');

      // Cannot insert into secrets (bucket constraint)
      const denyResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'secrets',
        data: { value: 'hacked' },
      });
      expect(denyResp['type']).toBe('error');
      expect(denyResp['code']).toBe('FORBIDDEN');

      // Can read from both (read has no bucket constraint)
      const readInvoices = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'invoices',
      });
      expect(readInvoices['type']).toBe('result');

      const readSecrets = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'secrets',
      });
      expect(readSecrets['type']).toBe('result');
    });
  });
});
