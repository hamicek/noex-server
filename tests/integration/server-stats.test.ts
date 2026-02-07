import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
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

describe('Integration: ServerStats API', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  let engine: RuleEngine | undefined;
  const clients: WebSocket[] = [];
  let counter = 0;

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

    if (engine) {
      await engine.stop();
    }
    engine = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  // ── NoexServer.getStats() ──────────────────────────────────────

  describe('NoexServer.getStats()', () => {
    it('returns enriched stats with connections aggregate', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const stats = await server.getStats();

      expect(stats.connections).toBeDefined();
      expect(stats.connections.active).toBe(2);
      expect(stats.connections.authenticated).toBe(0);
      expect(stats.connections.totalStoreSubscriptions).toBe(0);
      expect(stats.connections.totalRulesSubscriptions).toBe(0);
    });

    it('includes store stats', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      await store.defineBucket('users', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const stats = await server.getStats();

      expect(stats.store).toBeDefined();
      const storeStats = stats.store as Record<string, unknown>;
      expect(storeStats['name']).toBe(`stats-${counter}`);
      const buckets = storeStats['buckets'] as Record<string, unknown>;
      expect(buckets['count']).toBe(1);
    });

    it('includes rules stats when rules engine is configured', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      engine = await RuleEngine.start({ name: `rules-${counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        rules: engine,
      });

      const stats = await server.getStats();

      expect(stats.rules).toBeDefined();
      expect(stats.rulesEnabled).toBe(true);
      const rulesStats = stats.rules as Record<string, unknown>;
      expect(rulesStats['rulesCount']).toBe(0);
    });

    it('returns null for rules stats when not configured', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const stats = await server.getStats();

      expect(stats.rules).toBeNull();
      expect(stats.rulesEnabled).toBe(false);
    });

    it('tracks authenticated connections', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async (token) =>
            token === 'valid'
              ? { userId: 'u1', roles: ['user'] }
              : null,
          required: false,
        },
      });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      // Only c1 authenticates
      await sendRequest(c1.ws, { type: 'auth.login', token: 'valid' });
      await flush();

      const stats = await server.getStats();

      expect(stats.connections.active).toBe(2);
      expect(stats.connections.authenticated).toBe(1);
    });

    it('tracks subscription counts across connections', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      await sendRequest(c1.ws, { type: 'store.subscribe', query: 'all-items' });
      await sendRequest(c2.ws, { type: 'store.subscribe', query: 'all-items' });
      await sendRequest(c2.ws, { type: 'store.subscribe', query: 'all-items' });
      await flush();

      const stats = await server.getStats();

      expect(stats.connections.totalStoreSubscriptions).toBe(3);
    });

    it('updates connection count after disconnect', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      expect((await server.getStats()).connections.active).toBe(2);

      await closeClient(c1.ws);
      await flush(200);

      expect((await server.getStats()).connections.active).toBe(1);
    });
  });

  // ── server.stats WS operation ──────────────────────────────────

  describe('server.stats WS operation', () => {
    it('returns server stats over WebSocket', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        name: 'test-server',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      const resp = await sendRequest(ws, { type: 'server.stats' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('test-server');
      expect(data['connectionCount']).toBe(1);
      expect(data['authEnabled']).toBe(false);
      expect(data['rateLimitEnabled']).toBe(false);
      expect(data['rulesEnabled']).toBe(false);
    });

    it('includes connections aggregate', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const resp = await sendRequest(c1.ws, { type: 'server.stats' });
      const data = resp['data'] as Record<string, unknown>;
      const conns = data['connections'] as Record<string, unknown>;

      expect(conns['active']).toBe(2);
      expect(conns['authenticated']).toBe(0);
      expect(conns['totalStoreSubscriptions']).toBe(0);
      expect(conns['totalRulesSubscriptions']).toBe(0);
    });

    it('includes store stats', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Insert some data
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'data',
        data: { value: 42 },
      });

      const resp = await sendRequest(ws, { type: 'server.stats' });
      const data = resp['data'] as Record<string, unknown>;
      const storeStats = data['store'] as Record<string, unknown>;
      const records = storeStats['records'] as Record<string, unknown>;

      expect(records['total']).toBe(1);
    });

    it('includes rules stats when configured', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      engine = await RuleEngine.start({ name: `rules-${counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        rules: engine,
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'server.stats' });
      const data = resp['data'] as Record<string, unknown>;

      expect(data['rulesEnabled']).toBe(true);
      expect(data['rules']).toBeDefined();
      expect(data['rules']).not.toBeNull();
    });

    it('returns null rules stats when not configured', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'server.stats' });
      const data = resp['data'] as Record<string, unknown>;

      expect(data['rulesEnabled']).toBe(false);
      expect(data['rules']).toBeNull();
    });

    it('reflects rate limit configuration', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        rateLimit: { maxRequests: 1000, windowMs: 60_000 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'server.stats' });
      const data = resp['data'] as Record<string, unknown>;

      expect(data['rateLimitEnabled']).toBe(true);
    });
  });

  // ── server.connections WS operation ────────────────────────────

  describe('server.connections WS operation', () => {
    it('returns list of active connections', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const resp = await sendRequest(c1.ws, { type: 'server.connections' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
    });

    it('each connection has expected fields', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      const resp = await sendRequest(ws, { type: 'server.connections' });
      const data = resp['data'] as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      const conn = data[0]!;
      expect(conn['connectionId']).toBeDefined();
      expect(typeof conn['connectionId']).toBe('string');
      expect(conn['remoteAddress']).toBeDefined();
      expect(typeof conn['connectedAt']).toBe('number');
      expect(conn['authenticated']).toBe(false);
      expect(conn['userId']).toBeNull();
      expect(conn['storeSubscriptionCount']).toBe(0);
      expect(conn['rulesSubscriptionCount']).toBe(0);
    });

    it('reflects authenticated state after login', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async (token) =>
            token === 'valid'
              ? { userId: 'u1', roles: ['admin'] }
              : null,
          required: false,
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid' });
      await flush();

      const resp = await sendRequest(ws, { type: 'server.connections' });
      const data = resp['data'] as Array<Record<string, unknown>>;
      const conn = data.find((c) => c['authenticated'] === true);

      expect(conn).toBeDefined();
      expect(conn!['userId']).toBe('u1');
    });

    it('reflects subscription counts', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'store.subscribe', query: 'all-items' });
      await sendRequest(ws, { type: 'store.subscribe', query: 'all-items' });
      await flush();

      const resp = await sendRequest(ws, { type: 'server.connections' });
      const data = resp['data'] as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0]!['storeSubscriptionCount']).toBe(2);
    });

    it('removes disconnected connections from the list', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      await closeClient(c1.ws);
      await flush(200);

      const resp = await sendRequest(c2.ws, { type: 'server.connections' });
      const data = resp['data'] as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
    });
  });

  // ── server.* unknown operation ─────────────────────────────────

  describe('unknown server operation', () => {
    it('returns UNKNOWN_OPERATION for server.unknown', async () => {
      store = await Store.start({ name: `stats-${++counter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'server.unknown' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });
  });
});
