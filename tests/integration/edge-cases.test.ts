import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
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

function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for push on ${subscriptionId}`));
    }, timeoutMs);
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

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Edge Cases', () => {
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

  // ── Expired token at login time ─────────────────────────────────

  describe('expired token at login', () => {
    it('rejects login with an already-expired token', async () => {
      const expiredSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 10_000,
      };

      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async (token) =>
            token === 'expired' ? expiredSession : null,
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'expired',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Token has expired');
    });

    it('allows login with a non-expired token after rejecting an expired one', async () => {
      const expired: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 10_000,
      };
      const valid: AuthSession = {
        userId: 'user-2',
        roles: ['admin'],
      };

      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth: {
          validate: async (token) => {
            if (token === 'expired') return expired;
            if (token === 'valid') return valid;
            return null;
          },
        },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const fail = await sendRequest(ws, {
        type: 'auth.login',
        token: 'expired',
      });
      expect(fail['code']).toBe('UNAUTHORIZED');

      const ok = await sendRequest(ws, {
        type: 'auth.login',
        token: 'valid',
      });
      expect(ok['type']).toBe('result');

      const storeResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'data',
      });
      expect(storeResp['type']).toBe('result');
    });
  });

  // ── Subscription limits ─────────────────────────────────────────

  describe('subscription limits', () => {
    it('enforces maxSubscriptionsPerConnection for store subscriptions', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        connectionLimits: { maxSubscriptionsPerConnection: 3 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Create 3 subscriptions — should succeed
      for (let i = 0; i < 3; i++) {
        const resp = await sendRequest(ws, {
          type: 'store.subscribe',
          query: 'all-items',
        });
        expect(resp['type']).toBe('result');
      }

      // 4th subscription should be rejected
      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RATE_LIMITED');
      expect(resp['message']).toContain('Subscription limit');
    });

    it('enforces combined store + rules subscription limit', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      engine = await RuleEngine.start({ name: `edge-rules-${counter}` });

      server = await NoexServer.start({
        store,
        rules: engine,
        port: 0,
        host: '127.0.0.1',
        connectionLimits: { maxSubscriptionsPerConnection: 3 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // 2 store subscriptions
      for (let i = 0; i < 2; i++) {
        const resp = await sendRequest(ws, {
          type: 'store.subscribe',
          query: 'all-items',
        });
        expect(resp['type']).toBe('result');
      }

      // 1 rules subscription
      const rulesResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'test.*',
      });
      expect(rulesResp['type']).toBe('result');

      // 4th (mixed) — should be rejected
      const overflow = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'other.*',
      });
      expect(overflow['type']).toBe('error');
      expect(overflow['code']).toBe('RATE_LIMITED');
    });

    it('allows new subscriptions after unsubscribing', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        connectionLimits: { maxSubscriptionsPerConnection: 2 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Create 2 subscriptions
      const sub1 = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(sub1['type']).toBe('result');

      const sub2 = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(sub2['type']).toBe('result');

      // 3rd fails
      const fail = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(fail['code']).toBe('RATE_LIMITED');

      // Unsubscribe one
      const subId1 = (sub1['data'] as Record<string, unknown>)['subscriptionId'] as string;
      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId: subId1,
      });

      // Now we can subscribe again
      const sub3 = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(sub3['type']).toBe('result');
    });

    it('subscription limits are per-connection, not global', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        connectionLimits: { maxSubscriptionsPerConnection: 2 },
      });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws);

      // Both connections can independently create 2 subscriptions each
      for (let i = 0; i < 2; i++) {
        const r1 = await sendRequest(c1.ws, {
          type: 'store.subscribe',
          query: 'all-items',
        });
        expect(r1['type']).toBe('result');

        const r2 = await sendRequest(c2.ws, {
          type: 'store.subscribe',
          query: 'all-items',
        });
        expect(r2['type']).toBe('result');
      }

      // c1 is at limit
      const overflow = await sendRequest(c1.ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(overflow['code']).toBe('RATE_LIMITED');
    });
  });

  // ── Subscription cleanup on disconnect ──────────────────────────

  describe('subscription cleanup on disconnect', () => {
    it('cleans up store subscriptions when client disconnects', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      // Client subscribes then disconnects
      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const sub = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      expect(sub['type']).toBe('result');

      await closeClient(ws);
      await flush(200);

      // After disconnect, a new client should still work fine
      const { ws: ws2 } = await connectClient(server.port);
      clients.push(ws2);

      const resp = await sendRequest(ws2, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 42 },
      });
      expect(resp['type']).toBe('result');
    });

    it('push messages are not sent to disconnected clients', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      // Client 1 subscribes and then disconnects
      const c1 = await connectClient(server.port);
      clients.push(c1.ws);

      await sendRequest(c1.ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      await closeClient(c1.ws);
      await flush(200);

      // Client 2 connects and subscribes
      const c2 = await connectClient(server.port);
      clients.push(c2.ws);

      const sub = await sendRequest(c2.ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      const subId = (sub['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Trigger a mutation — only client 2 should get push
      const pushPromise = waitForPush(c2.ws, subId);
      await sendRequest(c2.ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { value: 99 },
      });

      const push = await pushPromise;
      expect(push['type']).toBe('push');
      expect(push['subscriptionId']).toBe(subId);
    });
  });

  // ── Concurrent requests ─────────────────────────────────────────

  describe('concurrent requests', () => {
    it('handles multiple concurrent requests from the same client', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
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
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Send 10 insert requests concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        sendRequest(ws, {
          type: 'store.insert',
          bucket: 'items',
          data: { name: `item-${i}` },
        }),
      );

      const results = await Promise.all(promises);

      for (const r of results) {
        expect(r['type']).toBe('result');
      }

      // All 10 items should exist
      const all = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect((all['data'] as unknown[]).length).toBe(10);
    });

    it('handles interleaved requests from multiple clients', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
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
      });

      const c1 = await connectClient(server.port);
      const c2 = await connectClient(server.port);
      const c3 = await connectClient(server.port);
      clients.push(c1.ws, c2.ws, c3.ws);

      const allPromises = [c1, c2, c3].flatMap((c, ci) =>
        Array.from({ length: 5 }, (_, i) =>
          sendRequest(c.ws, {
            type: 'store.insert',
            bucket: 'items',
            data: { name: `c${ci}-item-${i}` },
          }),
        ),
      );

      const results = await Promise.all(allPromises);

      for (const r of results) {
        expect(r['type']).toBe('result');
      }

      const all = await sendRequest(c1.ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect((all['data'] as unknown[]).length).toBe(15);
    });
  });

  // ── Rules without engine configured ─────────────────────────────

  describe('rules edge cases', () => {
    it('returns RULES_NOT_AVAILABLE for all rules operations when not configured', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const operations = [
        { type: 'rules.emit', topic: 'test', data: {} },
        { type: 'rules.setFact', key: 'k', value: 'v' },
        { type: 'rules.getFact', key: 'k' },
        { type: 'rules.deleteFact', key: 'k' },
        { type: 'rules.queryFacts', pattern: '*' },
        { type: 'rules.getAllFacts' },
        { type: 'rules.subscribe', pattern: '*' },
        { type: 'rules.unsubscribe', subscriptionId: 'sub-1' },
        { type: 'rules.stats' },
      ];

      for (const op of operations) {
        const resp = await sendRequest(ws, op);
        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('RULES_NOT_AVAILABLE');
      }
    });
  });

  // ── Validation edge cases ───────────────────────────────────────

  describe('validation edge cases', () => {
    it('rejects store.insert with missing data', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
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
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects store.get with missing key', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'items',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects store.subscribe with missing query name', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects store.transaction with non-array operations', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: 'not-an-array',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects store.transaction with empty operations', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [],
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects store.unsubscribe with unknown subscriptionId', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId: 'nonexistent',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('returns null for store.get on nonexistent key', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: { id: { type: 'string', generated: 'uuid' } },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'items',
        key: 'does-not-exist',
      });
      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });

    it('returns BUCKET_NOT_DEFINED for undefined bucket', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

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

  // ── Large messages ──────────────────────────────────────────────

  describe('large message handling', () => {
    it('handles large payloads within the limit', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('docs', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          content: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Create a ~100KB string
      const largeContent = 'x'.repeat(100_000);

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'docs',
        data: { content: largeContent },
      });
      expect(resp['type']).toBe('result');

      const record = resp['data'] as Record<string, unknown>;
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'docs',
        key: record['id'],
      });
      expect(getResp['type']).toBe('result');
      expect((getResp['data'] as Record<string, unknown>)['content']).toBe(largeContent);
    });
  });

  // ── Server stats accuracy ───────────────────────────────────────

  describe('server stats accuracy', () => {
    it('accurately tracks subscription counts in stats', async () => {
      store = await Store.start({ name: `edge-${++counter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      store.defineQuery('all-items', async (ctx) => ctx.bucket('items').all());

      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      await flush();

      // Create 2 subscriptions
      const sub1 = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });
      const sub2 = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-items',
      });

      await flush();

      const stats = await server.getStats();
      expect(stats.connections.totalStoreSubscriptions).toBe(2);

      // Unsubscribe one
      const subId = (sub1['data'] as Record<string, unknown>)['subscriptionId'] as string;
      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId: subId,
      });
      await flush();

      const stats2 = await server.getStats();
      expect(stats2.connections.totalStoreSubscriptions).toBe(1);
    });
  });
});
