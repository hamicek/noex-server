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

// ── Fixtures ─────────────────────────────────────────────────────

const userSession: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
};

const otherSession: AuthSession = {
  userId: 'user-2',
  roles: ['user'],
};

function createAuth(): AuthConfig {
  return {
    validate: async (token) => {
      if (token === 'user-1') return userSession;
      if (token === 'user-2') return otherSession;
      return null;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Rate Limiting', () => {
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

  async function setup(options?: {
    maxRequests?: number;
    windowMs?: number;
    auth?: AuthConfig;
  }): Promise<void> {
    store = await Store.start({ name: `rl-test-${++storeCounter}` });
    await store.defineBucket('items', {
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
      auth: options?.auth,
      rateLimit: {
        maxRequests: options?.maxRequests ?? 5,
        windowMs: options?.windowMs ?? 60_000,
      },
    });
  }

  // ── Basic rate limiting ───────────────────────────────────────

  describe('basic enforcement', () => {
    it('allows requests within the limit', async () => {
      await setup({ maxRequests: 5 });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      for (let i = 0; i < 5; i++) {
        const resp = await sendRequest(ws, {
          type: 'store.all',
          bucket: 'items',
        });
        expect(resp['type']).toBe('result');
      }
    });

    it('rejects requests exceeding the limit with RATE_LIMITED', async () => {
      await setup({ maxRequests: 3 });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        const resp = await sendRequest(ws, {
          type: 'store.all',
          bucket: 'items',
        });
        expect(resp['type']).toBe('result');
      }

      // 4th request should be rejected
      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RATE_LIMITED');
      expect(resp['message']).toMatch(/Rate limit exceeded/);
    });

    it('includes retryAfterMs in error details', async () => {
      await setup({ maxRequests: 1 });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'store.all', bucket: 'items' });

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RATE_LIMITED');
      const details = resp['details'] as Record<string, unknown>;
      expect(details).toBeDefined();
      expect(typeof details['retryAfterMs']).toBe('number');
      expect(details['retryAfterMs']).toBeGreaterThan(0);
    });
  });

  // ── Per-connection isolation (by IP) ──────────────────────────

  describe('per-connection isolation (unauthenticated)', () => {
    it('tracks limits independently per connection', async () => {
      await setup({ maxRequests: 2 });
      const { ws: ws1 } = await connectClient(server!.port);
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws1, ws2);

      // Both connections share the same loopback IP (127.0.0.1),
      // so they share the rate limit bucket.
      const resp1 = await sendRequest(ws1, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp1['type']).toBe('result');

      const resp2 = await sendRequest(ws2, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp2['type']).toBe('result');

      // 3rd request from either connection should be rejected (shared IP limit)
      const resp3 = await sendRequest(ws1, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp3['type']).toBe('error');
      expect(resp3['code']).toBe('RATE_LIMITED');
    });
  });

  // ── Per-user isolation (with auth) ────────────────────────────

  describe('per-user isolation (authenticated)', () => {
    it('uses userId as rate limit key after login', async () => {
      await setup({ maxRequests: 2, auth: createAuth() });

      const { ws: ws1 } = await connectClient(server!.port);
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws1, ws2);

      // Login as different users
      await sendRequest(ws1, { type: 'auth.login', token: 'user-1' });
      await sendRequest(ws2, { type: 'auth.login', token: 'user-2' });

      // Each user has their own limit
      for (let i = 0; i < 2; i++) {
        const r1 = await sendRequest(ws1, {
          type: 'store.all',
          bucket: 'items',
        });
        expect(r1['type']).toBe('result');

        const r2 = await sendRequest(ws2, {
          type: 'store.all',
          bucket: 'items',
        });
        expect(r2['type']).toBe('result');
      }

      // user-1 exceeded
      const over1 = await sendRequest(ws1, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(over1['code']).toBe('RATE_LIMITED');

      // user-2 also exceeded
      const over2 = await sendRequest(ws2, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(over2['code']).toBe('RATE_LIMITED');
    });

    it('switches rate limit key from IP to userId after login', async () => {
      await setup({ maxRequests: 1, auth: createAuth() });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // auth.login is rate-limited by IP (session not yet set)
      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'user-1',
      });
      expect(loginResp['type']).toBe('result');

      // After login, rate limit key switches to userId — fresh bucket
      const resp1 = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp1['type']).toBe('result');

      // Now the user bucket is exhausted
      const resp2 = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(resp2['code']).toBe('RATE_LIMITED');
    });

    it('rate-limits auth.login by IP to prevent brute force', async () => {
      await setup({ maxRequests: 2, auth: createAuth() });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Two login attempts exhaust IP-based limit
      await sendRequest(ws, { type: 'auth.login', token: 'wrong' });
      await sendRequest(ws, { type: 'auth.login', token: 'wrong' });

      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'user-1',
      });
      expect(resp['code']).toBe('RATE_LIMITED');
    });
  });

  // ── No rate limit configured ──────────────────────────────────

  describe('rate limiting disabled', () => {
    it('allows unlimited requests when rateLimit is not configured', async () => {
      store = await Store.start({ name: `rl-test-${++storeCounter}` });
      await store.defineBucket('items', {
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
        // No rateLimit config
      });

      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Send many requests — none should be rate limited
      for (let i = 0; i < 20; i++) {
        const resp = await sendRequest(ws, {
          type: 'store.all',
          bucket: 'items',
        });
        expect(resp['type']).toBe('result');
      }
    });
  });

  // ── Stats ─────────────────────────────────────────────────────

  describe('stats', () => {
    it('reports rateLimitEnabled: true when configured', async () => {
      await setup();
      const stats = await server!.getStats();
      expect(stats.rateLimitEnabled).toBe(true);
    });

    it('reports rateLimitEnabled: false when not configured', async () => {
      store = await Store.start({ name: `rl-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });
      const stats = await server!.getStats();
      expect(stats.rateLimitEnabled).toBe(false);
    });
  });

  // ── Mixed operations ──────────────────────────────────────────

  describe('mixed operations', () => {
    it('rate limits all operation types uniformly', async () => {
      await setup({ maxRequests: 3 });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Mix of different store operations
      const r1 = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { name: 'a' },
      });
      expect(r1['type']).toBe('result');

      const r2 = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(r2['type']).toBe('result');

      const r3 = await sendRequest(ws, {
        type: 'store.count',
        bucket: 'items',
      });
      expect(r3['type']).toBe('result');

      // 4th request — any type — should be rejected
      const r4 = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(r4['code']).toBe('RATE_LIMITED');
    });
  });

  // ── Window reset ──────────────────────────────────────────────

  describe('window reset', () => {
    it('allows requests again after the rate limit window expires', async () => {
      await setup({ maxRequests: 2, windowMs: 200 });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Exhaust the limit
      await sendRequest(ws, { type: 'store.all', bucket: 'items' });
      await sendRequest(ws, { type: 'store.all', bucket: 'items' });

      const rejected = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(rejected['code']).toBe('RATE_LIMITED');

      // Wait for the window to expire
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Should be allowed again
      const allowed = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(allowed['type']).toBe('result');
    });
  });
});
