import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer, PROTOCOL_VERSION } from '../../src/index.js';

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

function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      msgs.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
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

describe('Integration: Connection Lifecycle', () => {
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

  // ── Welcome Message ─────────────────────────────────────────────

  describe('welcome message', () => {
    it('sends a valid welcome message on connect', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['type']).toBe('welcome');
      expect(welcome['version']).toBe(PROTOCOL_VERSION);
      expect(welcome['requiresAuth']).toBe(false);
      expect(typeof welcome['serverTime']).toBe('number');
      expect(welcome['serverTime']).toBeGreaterThan(0);
    });

    it('includes requiresAuth:true when auth is configured', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
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

    it('includes requiresAuth:false when auth is optional', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: { validate: async () => null, required: false },
      });

      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['requiresAuth']).toBe(false);
    });

    it('provides a serverTime close to Date.now()', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const before = Date.now();
      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);
      const after = Date.now();

      expect(welcome['serverTime']).toBeGreaterThanOrEqual(before - 100);
      expect(welcome['serverTime']).toBeLessThanOrEqual(after + 100);
    });
  });

  // ── Multiple Connections ────────────────────────────────────────

  describe('concurrent connections', () => {
    it('handles multiple simultaneous connections', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const results = await Promise.all([
        connectClient(server.port),
        connectClient(server.port),
        connectClient(server.port),
        connectClient(server.port),
        connectClient(server.port),
      ]);

      for (const { ws, welcome } of results) {
        clients.push(ws);
        expect(welcome['type']).toBe('welcome');
      }

      await flush();
      expect(server.connectionCount).toBe(5);
    });

    it('each connection receives independent welcome messages', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      expect(c1.welcome['type']).toBe('welcome');
      expect(c2.welcome['type']).toBe('welcome');
      expect(c1.welcome['version']).toBe(PROTOCOL_VERSION);
      expect(c2.welcome['version']).toBe(PROTOCOL_VERSION);
    });

    it('connections are isolated — one disconnect does not affect others', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      await closeClient(c1.ws);
      await flush(200);

      // c2 still functional
      const resp = await sendRequest(c2.ws, {
        type: 'store.insert',
        bucket: 'data',
        data: { value: 42 },
      });

      expect(resp['type']).toBe('result');
    });
  });

  // ── Client Disconnect ──────────────────────────────────────────

  describe('client disconnect', () => {
    it('decrements connection count on client close', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      const c3 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws, c3.ws);
      await flush();

      expect(server.connectionCount).toBe(3);

      await closeClient(c2.ws);
      await flush(200);

      expect(server.connectionCount).toBe(2);

      await closeClient(c1.ws);
      await flush(200);

      expect(server.connectionCount).toBe(1);
    });

    it('allows reconnection after disconnect', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      clients.push(c1.ws);
      await closeClient(c1.ws);
      await flush(200);

      const c2 = await connectClient(server.port);
      clients.push(c2.ws);

      expect(c2.welcome['type']).toBe('welcome');
    });
  });

  // ── Server Stop ────────────────────────────────────────────────

  describe('server stop', () => {
    it('closes all client connections', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const allClosed = Promise.all([
        new Promise<void>((r) => c1.ws.once('close', () => r())),
        new Promise<void>((r) => c2.ws.once('close', () => r())),
      ]);

      await server.stop();
      await allClosed;

      expect(c1.ws.readyState).toBe(WebSocket.CLOSED);
      expect(c2.ws.readyState).toBe(WebSocket.CLOSED);
    });

    it('rejects new connections after stop', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
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

    it('stop is idempotent', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      await server.stop();
      await server.stop();

      expect(server.isRunning).toBe(false);
    });
  });

  // ── Graceful Shutdown ────────────────────────────────────────────

  describe('graceful shutdown', () => {
    it('broadcasts a system shutdown message to all clients', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const msgs1 = collectMessages(c1.ws, 1, 2000);
      const msgs2 = collectMessages(c2.ws, 1, 2000);

      await server.stop({ gracePeriodMs: 500 });

      const [m1] = await msgs1;
      const [m2] = await msgs2;

      expect(m1!['type']).toBe('system');
      expect(m1!['event']).toBe('shutdown');
      expect(m1!['gracePeriodMs']).toBe(500);

      expect(m2!['type']).toBe('system');
      expect(m2!['event']).toBe('shutdown');
    });

    it('closes remaining clients after grace period expires', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });

      await server.stop({ gracePeriodMs: 100 });

      const closeCode = await closed;
      expect(closeCode).toBe(1000);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it('exits early when all clients disconnect during grace period', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      // Start stop with a long grace period
      const stopPromise = server.stop({ gracePeriodMs: 10_000 });

      // Wait a tick for the shutdown message to be sent
      await flush(50);

      // Disconnect both clients voluntarily
      await closeClient(c1.ws);
      await closeClient(c2.ws);

      // stop() should resolve quickly (well before the 10s grace period)
      const before = Date.now();
      await stopPromise;
      const elapsed = Date.now() - before;

      expect(elapsed).toBeLessThan(2000);
    });

    it('rejects new connections during grace period', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
      const port = server.port;

      const { ws } = await connectClient(port);
      clients.push(ws);
      await flush();

      // Start stop with a grace period — keep one client connected
      const stopPromise = server.stop({ gracePeriodMs: 500 });

      // Try to connect a new client during the grace period
      await expect(
        new Promise<void>((resolve, reject) => {
          const newWs = new WebSocket(`ws://127.0.0.1:${port}`);
          newWs.once('open', () => {
            // If it opens, it should be immediately closed by the server
            newWs.once('close', () => reject(new Error('closed_during_shutdown')));
          });
          newWs.once('error', reject);
        }),
      ).rejects.toThrow();

      await stopPromise;
    });

    it('does not send shutdown message when grace period is 0', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      // Collect any messages — with gracePeriodMs=0, no shutdown message is sent
      const msgs = collectMessages(ws, 1, 300);

      await server.stop();

      const received = await msgs;
      // No system shutdown message — connection closed directly
      const systemMsgs = received.filter((m) => m['type'] === 'system');
      expect(systemMsgs).toHaveLength(0);
    });

    it('clients can still process requests during grace period', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      // Start shutdown with a generous grace period
      const stopPromise = server.stop({ gracePeriodMs: 2000 });

      // Wait for the shutdown message to arrive
      await flush(50);

      // Client can still send requests during the grace period
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { name: 'last-minute' },
      });

      expect(resp['type']).toBe('result');

      // Close client to allow stop to finish early
      await closeClient(ws);
      await stopPromise;
    });
  });

  // ── Protocol Error Handling ────────────────────────────────────

  describe('protocol error handling', () => {
    it('responds with PARSE_ERROR for invalid JSON', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const response = collectMessages(ws, 1);
      ws.send('not valid json{{{');
      const [msg] = await response;

      expect(msg!['type']).toBe('error');
      expect(msg!['code']).toBe('PARSE_ERROR');
      expect(msg!['id']).toBe(0);
    });

    it('responds with INVALID_REQUEST for missing id', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const response = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'store.all', bucket: 'test' }));
      const [msg] = await response;

      expect(msg!['type']).toBe('error');
      expect(msg!['code']).toBe('INVALID_REQUEST');
    });

    it('responds with INVALID_REQUEST for missing type', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const response = collectMessages(ws, 1);
      ws.send(JSON.stringify({ id: 1 }));
      const [msg] = await response;

      expect(msg!['type']).toBe('error');
      expect(msg!['code']).toBe('INVALID_REQUEST');
    });

    it('responds with UNKNOWN_OPERATION for unknown type', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'totally.unknown' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });

    it('responds with PARSE_ERROR for non-object JSON', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const response = collectMessages(ws, 1);
      ws.send(JSON.stringify([1, 2, 3]));
      const [msg] = await response;

      expect(msg!['type']).toBe('error');
      expect(msg!['code']).toBe('PARSE_ERROR');
    });

    it('handles pong message without error', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Pong is accepted silently (no response expected)
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));

      // Verify server still functional after pong
      await flush();
      await store.defineBucket('test', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });

      const resp = await sendRequest(ws, { type: 'store.all', bucket: 'test' });
      expect(resp['type']).toBe('result');
    });

    it('error on one request does not break subsequent requests', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // First: cause an error
      const errResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'nonexistent',
      });
      expect(errResp['type']).toBe('error');

      // Second: valid request
      const okResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { name: 'works' },
      });
      expect(okResp['type']).toBe('result');
    });
  });

  // ── Auth Gate ──────────────────────────────────────────────────

  describe('auth gate', () => {
    it('blocks store operations when auth is required and not authenticated', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: { validate: async () => null },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'data',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('allows store operations when auth is not configured', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'data',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual([]);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────

  describe('server stats', () => {
    it('reflects active connections in stats', async () => {
      store = await Store.start({ name: `conn-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const stats = await server.getStats();
      expect(stats.connectionCount).toBe(2);
      expect(stats.port).toBe(server.port);
      expect(stats.isRunning !== undefined || stats.uptimeMs >= 0).toBe(true);
    });
  });
});
