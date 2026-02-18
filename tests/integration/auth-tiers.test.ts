import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';
import type { AuthConfig, AuthSession } from '../../src/config.js';

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

async function login(
  ws: WebSocket,
  token: string,
): Promise<Record<string, unknown>> {
  return sendRequest(ws, { type: 'auth.login', token });
}

// ── Fixtures ─────────────────────────────────────────────────────

const sessions: Record<string, AuthSession> = {
  admin:  { userId: 'admin-1',  roles: ['admin'] },
  writer: { userId: 'writer-1', roles: ['writer'] },
  reader: { userId: 'reader-1', roles: ['reader'] },
  custom: { userId: 'custom-1', roles: ['user'] },
};

const auth: AuthConfig = {
  validate: async (token) => sessions[token] ?? null,
};

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Operation Tiers', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    clients.length = 0;

    if (server?.isRunning) await server.stop();
    server = undefined;

    if (store) await store.stop();
    store = undefined;
  });

  async function setup(): Promise<void> {
    store = await Store.start({ name: `tiers-test-${++storeCounter}` });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth,
    });
  }

  async function connect(token: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const resp = await login(ws, token);
    expect(resp['type']).toBe('result');
    return ws;
  }

  // ── Admin tier ─────────────────────────────────────────────────

  describe('admin tier', () => {
    it('admin can access admin-tier operations', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('result');
    });

    it('writer cannot access admin-tier operations', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
      expect(resp['message']).toContain('requires admin');
    });

    it('reader cannot access admin-tier operations', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Write tier ─────────────────────────────────────────────────

  describe('write tier', () => {
    it('admin can access write-tier operations', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });
      expect(resp['type']).toBe('result');
    });

    it('writer can access write-tier operations', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });
      expect(resp['type']).toBe('result');
    });

    it('reader cannot access write-tier operations', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Charlie' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
      expect(resp['message']).toContain('requires write');
    });
  });

  // ── Read tier ──────────────────────────────────────────────────

  describe('read tier', () => {
    it('admin can access read-tier operations', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('result');
    });

    it('writer can access read-tier operations', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('result');
    });

    it('reader can access read-tier operations', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Custom roles bypass ────────────────────────────────────────

  describe('custom roles bypass tier check', () => {
    it('custom role can access all operations (tier check not applicable)', async () => {
      await setup();
      const ws = await connect('custom');

      // Read
      const readResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(readResp['type']).toBe('result');

      // Write
      const writeResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Dave' },
      });
      expect(writeResp['type']).toBe('result');

      // Admin
      const adminResp = await sendRequest(ws, { type: 'server.stats' });
      expect(adminResp['type']).toBe('result');
    });
  });

  // ── Auth operations are exempt ─────────────────────────────────

  describe('auth operations are tier-exempt', () => {
    it('reader can use auth.whoami (not in tier map)', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, { type: 'auth.whoami' });
      expect(resp['type']).toBe('result');
    });
  });

  // ── No auth configured ─────────────────────────────────────────

  describe('no auth configured', () => {
    it('skips tier check entirely when auth is not configured', async () => {
      store = await Store.start({ name: `tiers-noauth-${++storeCounter}` });
      await store.defineBucket('users', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });
      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Eve' },
      });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Multiple operations, same session ──────────────────────────

  describe('multiple operations', () => {
    it('writer can read and write but not admin', async () => {
      await setup();
      const ws = await connect('writer');

      // Read — OK
      const readResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: 'nonexistent',
      });
      expect(readResp['type']).toBe('result');

      // Write — OK
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Frank' },
      });
      expect(insertResp['type']).toBe('result');

      // Admin — FORBIDDEN
      const statsResp = await sendRequest(ws, {
        type: 'server.connections',
      });
      expect(statsResp['type']).toBe('error');
      expect(statsResp['code']).toBe('FORBIDDEN');
    });
  });
});
