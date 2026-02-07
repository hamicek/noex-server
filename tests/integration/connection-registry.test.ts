import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer, type ConnectionInfo } from '../../src/index.js';

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

function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Push timeout')),
      timeoutMs,
    );
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
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

describe('Integration: ConnectionRegistry', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  let engine: RuleEngine | undefined;
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

    if (engine) {
      await engine.stop();
    }
    engine = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  // ── Basic registration ─────────────────────────────────────────

  describe('connection tracking', () => {
    it('tracks new connections in the registry', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      expect(server.getConnections()).toHaveLength(0);

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      const connections = server.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.remoteAddress).toBe('127.0.0.1');
      expect(connections[0]!.authenticated).toBe(false);
      expect(connections[0]!.userId).toBeNull();
      expect(connections[0]!.storeSubscriptionCount).toBe(0);
      expect(connections[0]!.rulesSubscriptionCount).toBe(0);
      expect(connections[0]!.connectedAt).toBeGreaterThan(0);
      expect(connections[0]!.connectionId).toBeTruthy();
    });

    it('tracks multiple connections independently', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      const c3 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws, c3.ws);
      await flush();

      const connections = server.getConnections();
      expect(connections).toHaveLength(3);

      const ids = connections.map((c) => c.connectionId);
      expect(new Set(ids).size).toBe(3);
    });

    it('assigns unique connectionId to each connection', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      const connections = server.getConnections();
      expect(connections[0]!.connectionId).not.toBe(
        connections[1]!.connectionId,
      );
    });
  });

  // ── Cleanup on disconnect ──────────────────────────────────────

  describe('cleanup on disconnect', () => {
    it('removes connection from registry on client disconnect', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      expect(server.getConnections()).toHaveLength(2);

      await closeClient(c1.ws);
      await flush(200);

      const remaining = server.getConnections();
      expect(remaining).toHaveLength(1);
    });

    it('removes all connections on server stop', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      expect(server.getConnections()).toHaveLength(2);

      await server.stop();

      // After stop, registry is closed — no connections
      expect(server.getConnections()).toHaveLength(0);
    });

    it('registry reflects zero connections after all clients disconnect', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      await closeClient(c1.ws);
      await closeClient(c2.ws);
      await flush(200);

      expect(server.getConnections()).toHaveLength(0);
    });
  });

  // ── Auth metadata ──────────────────────────────────────────────

  describe('auth metadata', () => {
    it('updates auth metadata on login', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async (token) => {
            if (token === 'valid') {
              return { userId: 'user-42', roles: ['admin'] };
            }
            return null;
          },
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      // Before login
      let connections = server.getConnections();
      expect(connections[0]!.authenticated).toBe(false);
      expect(connections[0]!.userId).toBeNull();

      // Login
      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'valid',
      });
      expect(resp['type']).toBe('result');

      // After login
      connections = server.getConnections();
      expect(connections[0]!.authenticated).toBe(true);
      expect(connections[0]!.userId).toBe('user-42');
    });

    it('updates auth metadata on logout', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async () => ({
            userId: 'user-1',
            roles: ['user'],
          }),
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Login
      await sendRequest(ws, { type: 'auth.login', token: 'test' });

      let connections = server.getConnections();
      expect(connections[0]!.authenticated).toBe(true);

      // Logout
      await sendRequest(ws, { type: 'auth.logout' });

      connections = server.getConnections();
      expect(connections[0]!.authenticated).toBe(false);
      expect(connections[0]!.userId).toBeNull();
    });

    it('does not update auth metadata on failed login', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async () => null,
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'bad',
      });
      expect(resp['type']).toBe('error');

      const connections = server.getConnections();
      expect(connections[0]!.authenticated).toBe(false);
      expect(connections[0]!.userId).toBeNull();
    });
  });

  // ── Subscription tracking ──────────────────────────────────────

  describe('subscription tracking', () => {
    it('tracks store subscription count', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
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
      await flush();

      // Before subscribe
      expect(server.getConnections()[0]!.storeSubscriptionCount).toBe(0);

      // Subscribe
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(subResp['type']).toBe('result');
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      // After subscribe
      expect(server.getConnections()[0]!.storeSubscriptionCount).toBe(1);

      // Unsubscribe
      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId,
      });

      // After unsubscribe
      expect(server.getConnections()[0]!.storeSubscriptionCount).toBe(0);
    });

    it('tracks rules subscription count', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      engine = await RuleEngine.start({ name: `reg-rules-${storeCounter}` });

      server = await NoexServer.start({
        store,
        rules: engine,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      expect(server.getConnections()[0]!.rulesSubscriptionCount).toBe(0);

      // Subscribe to rules events
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'test.*',
      });
      expect(subResp['type']).toBe('result');
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      expect(server.getConnections()[0]!.rulesSubscriptionCount).toBe(1);

      // Unsubscribe
      await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId,
      });

      expect(server.getConnections()[0]!.rulesSubscriptionCount).toBe(0);
    });

    it('tracks multiple subscriptions per connection', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      await store.defineBucket('users', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      store.defineQuery('all-users', async (ctx) =>
        ctx.bucket('users').all(),
      );
      store.defineQuery('user-count', async (ctx) =>
        ctx.bucket('users').count(),
      );

      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });

      expect(server.getConnections()[0]!.storeSubscriptionCount).toBe(2);
    });

    it('subscription counts are per-connection', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-data', async (ctx) =>
        ctx.bucket('data').all(),
      );

      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);
      await flush();

      // Subscribe only on c1
      await sendRequest(c1.ws, {
        type: 'store.subscribe',
        query: 'all-data',
      });

      const connections = server.getConnections();
      const c1Info = connections.find((c) =>
        connections.indexOf(c) === 0
          ? c.storeSubscriptionCount === 1
          : false,
      );
      const withSub = connections.filter(
        (c) => c.storeSubscriptionCount === 1,
      );
      const withoutSub = connections.filter(
        (c) => c.storeSubscriptionCount === 0,
      );

      expect(withSub).toHaveLength(1);
      expect(withoutSub).toHaveLength(1);
    });
  });

  // ── connectedAt ────────────────────────────────────────────────

  describe('connectedAt timestamp', () => {
    it('records accurate connection time', async () => {
      store = await Store.start({ name: `reg-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const before = Date.now();
      const { ws } = await connectClient(server.port);
      clients.push(ws);
      const after = Date.now();
      await flush();

      const connections = server.getConnections();
      expect(connections[0]!.connectedAt).toBeGreaterThanOrEqual(before - 100);
      expect(connections[0]!.connectedAt).toBeLessThanOrEqual(after + 100);
    });
  });
});
