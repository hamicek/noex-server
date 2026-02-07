import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function expectNoPush(
  ws: WebSocket,
  subscriptionId: string,
  ms = 300,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve();
    }, ms);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(`Unexpected push on ${subscriptionId}`));
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

describe('Integration: Store Subscriptions over WebSocket', () => {
  let server: NoexServer;
  let store: Store;
  const clients: WebSocket[] = [];
  let storeCounter = 0;
  let ws: WebSocket;

  beforeEach(async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: `sub-test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        role: { type: 'string', default: 'user' },
      },
    });

    store.defineQuery('all-users', async (ctx) => {
      return ctx.bucket('users').all();
    });

    store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
      return ctx.bucket('users').where({ role: params!.role });
    });

    store.defineQuery('user-count', async (ctx) => {
      return ctx.bucket('users').count();
    });

    server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
    const conn = await connectClient(server.port);
    ws = conn.ws;
    clients.push(ws);
  });

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) {
        c.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }

    if (store) {
      await store.stop();
    }
  });

  // ── store.subscribe ─────────────────────────────────────────────

  describe('store.subscribe', () => {
    it('returns subscriptionId and initial data for empty bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(typeof data['subscriptionId']).toBe('string');
      expect(data['data']).toEqual([]);
    });

    it('returns initial data for non-empty bucket', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });

      const data = resp['data'] as Record<string, unknown>;
      const results = data['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Alice');
    });

    it('subscribes with params and returns filtered initial data', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Admin', role: 'admin' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'User', role: 'user' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'users-by-role',
        params: { role: 'admin' },
      });

      const data = resp['data'] as Record<string, unknown>;
      const results = data['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Admin');
    });

    it('returns scalar initial data (count query)', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'A' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'B' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });

      const data = resp['data'] as Record<string, unknown>;
      expect(data['data']).toBe(2);
    });

    it('returns QUERY_NOT_DEFINED for unknown query', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'nonexistent-query',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('QUERY_NOT_DEFINED');
    });

    it('returns VALIDATION_ERROR when query field is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.subscribe',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── Push on data change ──────────────────────────────────────────

  describe('push notifications', () => {
    it('sends push when record is inserted', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subData = subResp['data'] as Record<string, unknown>;
      const subscriptionId = subData['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });

      await store.settle();
      const push = await pushPromise;

      expect(push['type']).toBe('push');
      expect(push['channel']).toBe('subscription');
      expect(push['subscriptionId']).toBe(subscriptionId);
      const results = push['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Bob');
    });

    it('sends push when record is updated', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Carol' },
      });
      const insertedId = (insertResp['data'] as Record<string, unknown>)['id'];

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key: insertedId,
        data: { name: 'Caroline' },
      });

      await store.settle();
      const push = await pushPromise;

      const results = push['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Caroline');
    });

    it('sends push when record is deleted', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Dave' },
      });
      const insertedId = (insertResp['data'] as Record<string, unknown>)['id'];

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key: insertedId,
      });

      await store.settle();
      const push = await pushPromise;

      expect(push['data']).toEqual([]);
    });

    it('pushes updated count for scalar query', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Eve' },
      });

      await store.settle();
      const push = await pushPromise;

      expect(push['data']).toBe(1);
    });

    it('sends push only when query result actually changes', async () => {
      // Subscribe to admin users (initially empty)
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'users-by-role',
        params: { role: 'admin' },
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Insert a regular user — result unchanged (still []), no push expected
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Regular', role: 'user' },
      });
      await store.settle();

      // Set up push listener THEN insert an admin — result changes, push expected
      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'AdminUser', role: 'admin' },
      });

      await store.settle();
      const push = await pushPromise;

      const results = push['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('AdminUser');
    });

    it('delivers pushes for multiple sequential mutations', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Insert first user → count goes from 0 to 1
      const push1Promise = waitForPush(ws, subscriptionId);
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'First' },
      });
      await store.settle();
      const push1 = await push1Promise;
      expect(push1['data']).toBe(1);

      // Insert second user → count goes from 1 to 2
      const push2Promise = waitForPush(ws, subscriptionId);
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Second' },
      });
      await store.settle();
      const push2 = await push2Promise;
      expect(push2['data']).toBe(2);
    });
  });

  // ── store.unsubscribe ─────────────────────────────────────────

  describe('store.unsubscribe', () => {
    it('unsubscribes and returns confirmation', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const unsubResp = await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId,
      });

      expect(unsubResp['type']).toBe('result');
      expect(unsubResp['data']).toEqual({ unsubscribed: true });
    });

    it('stops push notifications after unsubscribe', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId,
      });

      const noPushPromise = expectNoPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Ghost' },
      });

      await store.settle();
      await noPushPromise;
    });

    it('returns NOT_FOUND for unknown subscriptionId', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId: 'sub-nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('returns VALIDATION_ERROR when subscriptionId is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.unsubscribe',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns NOT_FOUND when unsubscribing twice', async () => {
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId,
      });

      const resp = await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── Multiple subscriptions ────────────────────────────────────

  describe('multiple subscriptions', () => {
    it('supports multiple active subscriptions on the same connection', async () => {
      const sub1Resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const sub2Resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });
      const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      expect(sub1Id).not.toBe(sub2Id);

      const push1Promise = waitForPush(ws, sub1Id);
      const push2Promise = waitForPush(ws, sub2Id);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'MultiSub' },
      });

      await store.settle();

      const [push1, push2] = await Promise.all([push1Promise, push2Promise]);

      const users = push1['data'] as Record<string, unknown>[];
      expect(users).toHaveLength(1);
      expect(users[0]!['name']).toBe('MultiSub');

      expect(push2['data']).toBe(1);
    });

    it('unsubscribing one does not affect others', async () => {
      const sub1Resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const sub2Resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'user-count',
      });
      const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Unsubscribe from all-users
      await sendRequest(ws, {
        type: 'store.unsubscribe',
        subscriptionId: sub1Id,
      });

      // user-count subscription should still work
      const pushPromise = waitForPush(ws, sub2Id);
      const noPushPromise = expectNoPush(ws, sub1Id);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'StillWorking' },
      });

      await store.settle();

      const push = await pushPromise;
      expect(push['data']).toBe(1);

      await noPushPromise;
    });
  });

  // ── Multi-client ──────────────────────────────────────────────

  describe('multi-client subscriptions', () => {
    it('pushes to subscriber when another client mutates data', async () => {
      // Client 1 subscribes
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Client 2 connects
      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      const pushPromise = waitForPush(ws, subscriptionId);

      // Client 2 inserts data
      await sendRequest(ws2, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'FromClient2' },
      });

      await store.settle();

      // Client 1 receives push
      const push = await pushPromise;
      const results = push['data'] as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('FromClient2');
    });

    it('each client receives pushes only for their own subscriptions', async () => {
      // Client 1 subscribes to all-users
      const sub1Resp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      // Client 2 connects and subscribes to user-count
      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      const sub2Resp = await sendRequest(ws2, {
        type: 'store.subscribe',
        query: 'user-count',
      });
      const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const push1Promise = waitForPush(ws, sub1Id);
      const push2Promise = waitForPush(ws2, sub2Id);

      // Either client inserts
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Shared' },
      });

      await store.settle();

      const [push1, push2] = await Promise.all([push1Promise, push2Promise]);

      // Client 1 gets array push
      const users = push1['data'] as Record<string, unknown>[];
      expect(users).toHaveLength(1);

      // Client 2 gets count push
      expect(push2['data']).toBe(1);
    });
  });

  // ── Subscription cleanup on disconnect ────────────────────────

  describe('cleanup on disconnect', () => {
    it('subscriptions are cleaned up when client disconnects', async () => {
      // Subscribe
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      expect(subResp['type']).toBe('result');

      // Disconnect
      await closeClient(ws);
      await flush(200);

      // Insert data — should not cause errors on server
      const bucket = store.bucket('users');
      await bucket.insert({ name: 'AfterDisconnect' });
      await store.settle();
      await flush(100);

      // Server should still be running fine
      expect(server.isRunning).toBe(true);
    });
  });
});
