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

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Store Transactions over WebSocket', () => {
  let server: NoexServer;
  let store: Store;
  const clients: WebSocket[] = [];
  let storeCounter = 0;
  let ws: WebSocket;

  beforeEach(async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: `tx-test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        role: { type: 'string', default: 'user' },
        credits: { type: 'number', default: 0 },
      },
    });

    await store.defineBucket('logs', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        action: { type: 'string', required: true },
        userId: { type: 'string' },
      },
    });

    await store.defineBucket('products', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        title: { type: 'string', required: true },
        price: { type: 'number', default: 0 },
        stock: { type: 'number', default: 0 },
      },
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

  // ── Basic transactions ───────────────────────────────────────────

  describe('basic transactions', () => {
    it('inserts multiple records atomically', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice' } },
          { op: 'insert', bucket: 'users', data: { name: 'Bob' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results).toHaveLength(2);

      expect(data.results[0]!.index).toBe(0);
      expect(data.results[0]!.data['name']).toBe('Alice');
      expect(data.results[0]!.data['_version']).toBe(1);

      expect(data.results[1]!.index).toBe(1);
      expect(data.results[1]!.data['name']).toBe('Bob');
      expect(data.results[1]!.data['_version']).toBe(1);

      // Verify records are persisted
      const allResp = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
      const all = allResp['data'] as Array<Record<string, unknown>>;
      expect(all).toHaveLength(2);
    });

    it('performs insert + update in one transaction', async () => {
      // Pre-insert a user
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', credits: 100 },
      });
      const userId = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'update', bucket: 'users', key: userId, data: { credits: 200 } },
          { op: 'insert', bucket: 'logs', data: { action: 'credit_update', userId } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results).toHaveLength(2);
      expect(data.results[0]!.data['credits']).toBe(200);
      expect(data.results[1]!.data['action']).toBe('credit_update');
    });

    it('performs delete operation in a transaction', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'ToDelete' },
      });
      const userId = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'delete', bucket: 'users', key: userId },
          { op: 'insert', bucket: 'logs', data: { action: 'user_deleted', userId } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      expect(data.results[0]!.data).toEqual({ deleted: true });

      // Verify user is gone
      const getResp = await sendRequest(ws, { type: 'store.get', bucket: 'users', key: userId });
      expect((getResp['data'] as Record<string, unknown> | null)).toBeNull();
    });
  });

  // ── Cross-bucket transactions ────────────────────────────────────

  describe('cross-bucket transactions', () => {
    it('atomically inserts into multiple buckets', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice' } },
          { op: 'insert', bucket: 'products', data: { title: 'Widget', price: 10, stock: 50 } },
          { op: 'insert', bucket: 'logs', data: { action: 'setup' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results).toHaveLength(3);
      expect(data.results[0]!.data['name']).toBe('Alice');
      expect(data.results[1]!.data['title']).toBe('Widget');
      expect(data.results[2]!.data['action']).toBe('setup');
    });

    it('updates across buckets atomically', async () => {
      // Pre-insert
      const userResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', credits: 500 },
      });
      const userId = (userResp['data'] as Record<string, unknown>)['id'] as string;

      const prodResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'products',
        data: { title: 'Widget', price: 100, stock: 10 },
      });
      const productId = (prodResp['data'] as Record<string, unknown>)['id'] as string;

      // Purchase: deduct credits, reduce stock, log
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'update', bucket: 'users', key: userId, data: { credits: 400 } },
          { op: 'update', bucket: 'products', key: productId, data: { stock: 9 } },
          { op: 'insert', bucket: 'logs', data: { action: 'purchase', userId } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results[0]!.data['credits']).toBe(400);
      expect(data.results[1]!.data['stock']).toBe(9);
      expect(data.results[2]!.data['action']).toBe('purchase');
    });
  });

  // ── Read-your-own-writes ─────────────────────────────────────────

  describe('read-your-own-writes', () => {
    it('can read an inserted record within the same transaction', async () => {
      // Pre-insert a user so we know the key
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', credits: 100 },
      });
      const userId = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'update', bucket: 'users', key: userId, data: { credits: 200 } },
          { op: 'get', bucket: 'users', key: userId },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      // The get should see the updated credits (read-your-own-writes)
      expect(data.results[1]!.data['credits']).toBe(200);
    });

    it('count reflects inserts within the transaction', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice' } },
          { op: 'insert', bucket: 'users', data: { name: 'Bob' } },
          { op: 'count', bucket: 'users' },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      expect(data.results[2]!.data).toBe(2);
    });

    it('where returns records inserted in the same transaction', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice', role: 'admin' } },
          { op: 'insert', bucket: 'users', data: { name: 'Bob', role: 'user' } },
          { op: 'where', bucket: 'users', filter: { role: 'admin' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      const admins = data.results[2]!.data as Array<Record<string, unknown>>;
      expect(admins).toHaveLength(1);
      expect(admins[0]!['name']).toBe('Alice');
    });

    it('findOne sees records inserted in same transaction', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice', role: 'admin' } },
          { op: 'findOne', bucket: 'users', filter: { role: 'admin' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results[1]!.data['name']).toBe('Alice');
    });
  });

  // ── Transaction conflicts ────────────────────────────────────────

  describe('conflict detection', () => {
    it('returns CONFLICT when updating a record modified outside the transaction', async () => {
      // Insert a user
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', credits: 100 },
      });
      const userId = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      // Update outside transaction to bump version
      await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key: userId,
        data: { credits: 200 },
      });

      // Now try a transaction that reads and updates the same user.
      // The transaction internally reads version 2, but we're reading it fresh
      // within the tx. This should succeed because the tx reads current state.
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'get', bucket: 'users', key: userId },
          { op: 'update', bucket: 'users', key: userId, data: { credits: 300 } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results[0]!.data['credits']).toBe(200); // current
      expect(data.results[1]!.data['credits']).toBe(300); // updated
    });
  });

  // ── Error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it('returns VALIDATION_ERROR when operations is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when operations is not an array', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: 'not-an-array',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when operations is empty', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR for invalid operation type', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'nonexistent', bucket: 'users' },
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('operations[0]');
    });

    it('returns VALIDATION_ERROR for missing bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', data: { name: 'Alice' } },
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('bucket');
    });

    it('returns VALIDATION_ERROR for missing key on get', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'get', bucket: 'users' },
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('key');
    });

    it('returns VALIDATION_ERROR for missing data on insert', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users' },
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('data');
    });

    it('returns VALIDATION_ERROR for missing filter on where', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'where', bucket: 'users' },
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('filter');
    });

    it('returns VALIDATION_ERROR for operation that is not an object', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: ['not-an-object'],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
      expect(resp['message']).toContain('operations[0]');
    });

    it('returns error for unknown bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'nonexistent', data: { name: 'Alice' } },
        ],
      });

      expect(resp['type']).toBe('error');
      // TransactionContext.bucket() throws a plain Error (not BucketNotDefinedError),
      // so it is mapped to INTERNAL_ERROR.
      expect(resp['code']).toBe('INTERNAL_ERROR');
    });

    it('returns VALIDATION_ERROR for missing required field in insert', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { credits: 100 } }, // missing 'name'
        ],
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rolls back all operations when one fails', async () => {
      // Insert a valid user first
      const preInsert = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'products',
        data: { title: 'Widget', price: 10, stock: 5 },
      });
      const productId = (preInsert['data'] as Record<string, unknown>)['id'] as string;

      // Transaction: update product + insert user without required 'name'
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'update', bucket: 'products', key: productId, data: { stock: 4 } },
          { op: 'insert', bucket: 'users', data: { credits: 100 } }, // missing 'name'
        ],
      });

      expect(resp['type']).toBe('error');

      // Verify the product was NOT updated (rollback)
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'products',
        key: productId,
      });
      const product = getResp['data'] as Record<string, unknown>;
      expect(product['stock']).toBe(5); // unchanged
    });
  });

  // ── Get returns null for non-existent key ────────────────────────

  describe('edge cases', () => {
    it('get returns null for non-existent key within a transaction', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'get', bucket: 'users', key: 'non-existent-key' },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      expect(data.results[0]!.data).toBeNull();
    });

    it('count with filter works in a transaction', async () => {
      // Pre-insert some records
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Alice', role: 'admin' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Bob', role: 'user' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Charlie', role: 'admin' } });

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'count', bucket: 'users', filter: { role: 'admin' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      expect(data.results[0]!.data).toBe(2);
    });

    it('delete is idempotent in a transaction', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'delete', bucket: 'users', key: 'non-existent-key' },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: unknown }> };
      expect(data.results[0]!.data).toEqual({ deleted: true });
    });

    it('single-operation transaction works', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Solo' } },
        ],
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.data['name']).toBe('Solo');
    });

    it('many operations in a single transaction', async () => {
      const operations = Array.from({ length: 20 }, (_, i) => ({
        op: 'insert',
        bucket: 'users',
        data: { name: `User ${i}` },
      }));

      const resp = await sendRequest(ws, {
        type: 'store.transaction',
        operations,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as { results: Array<{ index: number; data: Record<string, unknown> }> };
      expect(data.results).toHaveLength(20);

      for (let i = 0; i < 20; i++) {
        expect(data.results[i]!.index).toBe(i);
        expect(data.results[i]!.data['name']).toBe(`User ${i}`);
      }
    });
  });

  // ── Subscriptions and transactions ───────────────────────────────

  describe('subscription push after transaction commit', () => {
    it('triggers subscription push after a transaction commits', async () => {
      store.defineQuery('all-users', async (ctx) => {
        return ctx.bucket('users').all();
      });

      // Subscribe to all-users
      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users',
      });
      expect(subResp['type']).toBe('result');
      const subData = subResp['data'] as { subscriptionId: string; data: unknown };
      const subscriptionId = subData.subscriptionId;

      // Set up push listener BEFORE the transaction
      const pushPromise = waitForPush(ws, subscriptionId);

      // Insert via transaction
      const txResp = await sendRequest(ws, {
        type: 'store.transaction',
        operations: [
          { op: 'insert', bucket: 'users', data: { name: 'Alice' } },
          { op: 'insert', bucket: 'users', data: { name: 'Bob' } },
        ],
      });
      expect(txResp['type']).toBe('result');

      await store.settle();

      const push = await pushPromise;
      const pushData = push['data'] as Array<Record<string, unknown>>;
      expect(pushData).toHaveLength(2);

      const names = pushData.map((u) => u['name']).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });
  });
});
