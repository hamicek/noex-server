import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer, type ServerStats } from '../../src/server.js';

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

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────

describe('NoexServer', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

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

  // ── start ──────────────────────────────────────────────────────

  describe('start', () => {
    it('creates a running server', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.isRunning).toBe(true);
    });

    it('listens on a valid port', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.port).toBeGreaterThan(0);
    });

    it('uses port 0 to pick an ephemeral port', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.port).toBeGreaterThan(1023);
    });

    it('fails when port is already in use', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
      const port = server.port;

      const store2 = await Store.start({ name: `test-${++storeCounter}` });
      try {
        await expect(
          NoexServer.start({ store: store2, port, host: '127.0.0.1' }),
        ).rejects.toThrow();
      } finally {
        await store2.stop();
      }
    });

    it('cleans up supervisor when ws.Server fails to start', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
      const port = server.port;

      const store2 = await Store.start({ name: `test-${++storeCounter}` });
      try {
        await NoexServer.start({ store: store2, port, host: '127.0.0.1' });
      } catch {
        // Expected — port in use
      }
      await store2.stop();
      // No dangling supervisor — if cleanup failed, this would leak
    });
  });

  // ── properties ──────────────────────────────────────────────────

  describe('properties', () => {
    it('connectionCount starts at 0', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.connectionCount).toBe(0);
    });

    it('isRunning is true after start', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.isRunning).toBe(true);
    });

    it('isRunning is false after stop', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      await server.stop();

      expect(server.isRunning).toBe(false);
    });
  });

  // ── connections ─────────────────────────────────────────────────

  describe('connections', () => {
    it('accepts WebSocket connections', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['type']).toBe('welcome');
      expect(welcome['version']).toBe('1.0.0');
      expect(typeof welcome['serverTime']).toBe('number');
    });

    it('sends welcome with requiresAuth:false when auth not configured', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['requiresAuth']).toBe(false);
    });

    it('sends welcome with requiresAuth:true when auth configured', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: { validate: async () => null },
      });

      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['requiresAuth']).toBe(true);
    });

    it('increments connectionCount on connect', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      expect(server.connectionCount).toBe(1);
    });

    it('tracks multiple concurrent connections', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      const c3 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws, c3.ws);
      await flush();

      expect(server.connectionCount).toBe(3);
    });

    it('decrements connectionCount on client disconnect', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      expect(server.connectionCount).toBe(2);

      await closeClient(c1.ws);
      await flush(200);

      expect(server.connectionCount).toBe(1);
    });

    it('each connection receives its own welcome message', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      expect(c1.welcome['type']).toBe('welcome');
      expect(c2.welcome['type']).toBe('welcome');
    });
  });

  // ── store operations through WS ────────────────────────────────

  describe('store operations', () => {
    it('processes store.insert and store.get requests', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      await store.defineBucket('users', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });

      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });

      expect(insertResp['type']).toBe('result');
      const inserted = insertResp['data'] as Record<string, unknown>;
      expect(inserted['name']).toBe('Alice');
      expect(typeof inserted['id']).toBe('string');

      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(getResp['type']).toBe('result');
      const fetched = getResp['data'] as Record<string, unknown>;
      expect(fetched['name']).toBe('Alice');
      expect(fetched['id']).toBe(inserted['id']);
    });

    it('returns error for unknown operations', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'unknown.operation' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });

    it('returns error for undefined bucket', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });
  });

  // ── stop ────────────────────────────────────────────────────────

  describe('stop', () => {
    it('stops the server', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      await server.stop();

      expect(server.isRunning).toBe(false);
    });

    it('closes all client connections on stop', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      const closed = new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });

      await server.stop();
      await closed;

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it('rejects new connections after stop', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
      const port = server.port;

      await server.stop();

      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.once('open', () => {
            ws.close();
            resolve();
          });
          ws.once('error', reject);
        }),
      ).rejects.toThrow();
    });

    it('calling stop twice is safe', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      await server.stop();
      await server.stop();

      expect(server.isRunning).toBe(false);
    });

    it('stops multiple connections cleanly', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      const c3 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws, c3.ws);
      await flush();

      const allClosed = Promise.all(
        [c1.ws, c2.ws, c3.ws].map(
          (ws) => new Promise<void>((r) => ws.once('close', () => r())),
        ),
      );

      await server.stop();
      await allClosed;

      expect(c1.ws.readyState).toBe(WebSocket.CLOSED);
      expect(c2.ws.readyState).toBe(WebSocket.CLOSED);
      expect(c3.ws.readyState).toBe(WebSocket.CLOSED);
    });
  });

  // ── getStats ───────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns correct default stats', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const stats: ServerStats = await server.getStats();

      expect(stats.name).toBe('noex-server');
      expect(stats.port).toBe(server.port);
      expect(stats.host).toBe('127.0.0.1');
      expect(stats.connectionCount).toBe(0);
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(stats.authEnabled).toBe(false);
      expect(stats.rateLimitEnabled).toBe(false);
      expect(stats.rulesEnabled).toBe(false);
    });

    it('reflects custom server name', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        name: 'my-server',
      });

      const stats = await server.getStats();

      expect(stats.name).toBe('my-server');
    });

    it('counts active connections', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const stats = await server.getStats();

      expect(stats.connectionCount).toBe(2);
    });

    it('reflects auth/rateLimit/rules configuration', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: { validate: async () => null },
        rateLimit: { maxRequests: 100, windowMs: 60_000 },
      });

      const stats = await server.getStats();

      expect(stats.authEnabled).toBe(true);
      expect(stats.rateLimitEnabled).toBe(true);
      expect(stats.rulesEnabled).toBe(false);
    });

    it('uptimeMs increases over time', async () => {
      store = await Store.start({ name: `test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const stats1 = await server.getStats();
      await flush(50);
      const stats2 = await server.getStats();

      expect(stats2.uptimeMs).toBeGreaterThan(stats1.uptimeMs);
    });
  });
});
