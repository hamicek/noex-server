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

describe('Integration: Store CRUD over WebSocket', () => {
  let server: NoexServer;
  let store: Store;
  const clients: WebSocket[] = [];
  let storeCounter = 0;
  let ws: WebSocket;

  beforeEach(async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: `crud-test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        email: { type: 'string' },
        role: { type: 'string', default: 'user' },
        age: { type: 'number' },
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

  // ── store.insert ────────────────────────────────────────────────

  describe('store.insert', () => {
    it('inserts a record and returns it with generated fields', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', email: 'alice@example.com' },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('Alice');
      expect(data['email']).toBe('alice@example.com');
      expect(data['role']).toBe('user'); // default
      expect(typeof data['id']).toBe('string');
      expect(data['_version']).toBe(1);
      expect(typeof data['_createdAt']).toBe('number');
    });

    it('returns VALIDATION_ERROR for missing required field', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { age: 25 }, // name is required
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns BUCKET_NOT_DEFINED for unknown bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'nonexistent',
        data: { x: 1 },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });

    it('returns VALIDATION_ERROR when bucket field is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        data: { name: 'Test' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when data field is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.get ──────────────────────────────────────────────────

  describe('store.get', () => {
    it('retrieves an inserted record by key', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(getResp['type']).toBe('result');
      const data = getResp['data'] as Record<string, unknown>;
      expect(data['id']).toBe(inserted['id']);
      expect(data['name']).toBe('Bob');
      expect(data['_version']).toBe(1);
    });

    it('returns null for non-existent key', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: 'does-not-exist',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });

    it('returns VALIDATION_ERROR when key is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.update ───────────────────────────────────────────────

  describe('store.update', () => {
    it('updates a record and increments version', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Carol', role: 'user' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      const updateResp = await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key: inserted['id'],
        data: { name: 'Caroline', role: 'admin' },
      });

      expect(updateResp['type']).toBe('result');
      const updated = updateResp['data'] as Record<string, unknown>;
      expect(updated['name']).toBe('Caroline');
      expect(updated['role']).toBe('admin');
      expect(updated['_version']).toBe(2);
    });

    it('updated record is visible via get', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Dave' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key: inserted['id'],
        data: { name: 'David' },
      });

      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      const data = getResp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('David');
    });

    it('returns VALIDATION_ERROR when key is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        data: { name: 'X' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when data is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key: 'some-key',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.delete ───────────────────────────────────────────────

  describe('store.delete', () => {
    it('deletes a record and returns { deleted: true }', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Eve' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      const deleteResp = await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(deleteResp['type']).toBe('result');
      expect(deleteResp['data']).toEqual({ deleted: true });
    });

    it('deleted record is no longer retrievable', async () => {
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Frank' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key: inserted['id'],
      });

      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(getResp['type']).toBe('result');
      expect(getResp['data']).toBeNull();
    });

    it('returns VALIDATION_ERROR when key is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.all ──────────────────────────────────────────────────

  describe('store.all', () => {
    it('returns all records in a bucket', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Grace' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Henry' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Iris' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as unknown[];
      expect(data).toHaveLength(3);
    });

    it('returns empty array for empty bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual([]);
    });

    it('returns BUCKET_NOT_DEFINED for unknown bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });
  });

  // ── store.where ────────────────────────────────────────────────

  describe('store.where', () => {
    it('filters records by criteria', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Admin1', role: 'admin' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'User1', role: 'user' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Admin2', role: 'admin' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.where',
        bucket: 'users',
        filter: { role: 'admin' },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>[];
      expect(data).toHaveLength(2);
      expect(data.every((r) => r['role'] === 'admin')).toBe(true);
    });

    it('returns empty array when no records match', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'John', role: 'user' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.where',
        bucket: 'users',
        filter: { role: 'superadmin' },
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual([]);
    });

    it('returns VALIDATION_ERROR when filter is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.where',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.findOne ──────────────────────────────────────────────

  describe('store.findOne', () => {
    it('returns the first matching record', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Jane', role: 'admin' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.findOne',
        bucket: 'users',
        filter: { role: 'admin' },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('Jane');
      expect(data['role']).toBe('admin');
    });

    it('returns null when no record matches', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.findOne',
        bucket: 'users',
        filter: { role: 'nonexistent' },
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });

    it('returns VALIDATION_ERROR when filter is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.findOne',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.count ────────────────────────────────────────────────

  describe('store.count', () => {
    it('returns total count without filter', async () => {
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
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'C' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.count',
        bucket: 'users',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(3);
    });

    it('returns filtered count', async () => {
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'X', role: 'admin' },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Y', role: 'user' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.count',
        bucket: 'users',
        filter: { role: 'admin' },
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(1);
    });

    it('returns 0 for empty bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.count',
        bucket: 'users',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(0);
    });
  });

  // ── store.first / store.last ───────────────────────────────────

  describe('store.first', () => {
    it('returns first N records', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'A' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'B' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'C' } });

      const resp = await sendRequest(ws, {
        type: 'store.first',
        bucket: 'users',
        n: 2,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as unknown[];
      expect(data).toHaveLength(2);
    });

    it('returns all when n exceeds total count', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'A' } });

      const resp = await sendRequest(ws, {
        type: 'store.first',
        bucket: 'users',
        n: 100,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as unknown[];
      expect(data).toHaveLength(1);
    });

    it('returns VALIDATION_ERROR for non-positive n', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.first',
        bucket: 'users',
        n: 0,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  describe('store.last', () => {
    it('returns last N records', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'A' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'B' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'C' } });

      const resp = await sendRequest(ws, {
        type: 'store.last',
        bucket: 'users',
        n: 2,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as unknown[];
      expect(data).toHaveLength(2);
    });
  });

  // ── store.paginate ─────────────────────────────────────────────

  describe('store.paginate', () => {
    it('returns first page of results', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P1' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P2' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P3' } });

      const resp = await sendRequest(ws, {
        type: 'store.paginate',
        bucket: 'users',
        limit: 2,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const records = data['records'] as unknown[];
      expect(records).toHaveLength(2);
      expect(data['hasMore']).toBe(true);
      expect(data['nextCursor']).toBeDefined();
    });

    it('supports cursor-based pagination across pages', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P1' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P2' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P3' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P4' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'P5' } });

      // Page 1
      const page1 = await sendRequest(ws, {
        type: 'store.paginate',
        bucket: 'users',
        limit: 2,
      });
      const data1 = page1['data'] as Record<string, unknown>;
      expect((data1['records'] as unknown[]).length).toBe(2);
      expect(data1['hasMore']).toBe(true);

      // Page 2
      const page2 = await sendRequest(ws, {
        type: 'store.paginate',
        bucket: 'users',
        limit: 2,
        after: data1['nextCursor'],
      });
      const data2 = page2['data'] as Record<string, unknown>;
      expect((data2['records'] as unknown[]).length).toBe(2);
      expect(data2['hasMore']).toBe(true);

      // Page 3 (last)
      const page3 = await sendRequest(ws, {
        type: 'store.paginate',
        bucket: 'users',
        limit: 2,
        after: data2['nextCursor'],
      });
      const data3 = page3['data'] as Record<string, unknown>;
      expect((data3['records'] as unknown[]).length).toBe(1);
      expect(data3['hasMore']).toBe(false);
    });

    it('returns VALIDATION_ERROR when limit is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.paginate',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.clear ────────────────────────────────────────────────

  describe('store.clear', () => {
    it('removes all records from a bucket', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'A' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'B' } });

      const clearResp = await sendRequest(ws, {
        type: 'store.clear',
        bucket: 'users',
      });

      expect(clearResp['type']).toBe('result');
      expect(clearResp['data']).toEqual({ cleared: true });

      const allResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect((allResp['data'] as unknown[]).length).toBe(0);
    });

    it('clearing one bucket does not affect another', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'A' } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Widget' } });

      await sendRequest(ws, { type: 'store.clear', bucket: 'users' });

      const usersResp = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
      expect((usersResp['data'] as unknown[]).length).toBe(0);

      const productsResp = await sendRequest(ws, { type: 'store.all', bucket: 'products' });
      expect((productsResp['data'] as unknown[]).length).toBe(1);
    });
  });

  // ── Aggregations ───────────────────────────────────────────────

  describe('store.sum', () => {
    it('sums a numeric field', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'A', price: 10 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'B', price: 20 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'C', price: 30 } });

      const resp = await sendRequest(ws, {
        type: 'store.sum',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(60);
    });

    it('sums with filter', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Cheap', price: 5, stock: 100 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Expensive', price: 50, stock: 10 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Free', price: 0, stock: 100 } });

      const resp = await sendRequest(ws, {
        type: 'store.sum',
        bucket: 'products',
        field: 'price',
        filter: { stock: 100 },
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(5);
    });

    it('returns VALIDATION_ERROR when field is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.sum',
        bucket: 'products',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  describe('store.avg', () => {
    it('calculates average of a numeric field', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'A', price: 10 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'B', price: 20 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'C', price: 30 } });

      const resp = await sendRequest(ws, {
        type: 'store.avg',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(20);
    });
  });

  describe('store.min', () => {
    it('returns minimum of a numeric field', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'A', price: 25 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'B', price: 5 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'C', price: 15 } });

      const resp = await sendRequest(ws, {
        type: 'store.min',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(5);
    });

    it('returns null for empty bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.min',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });
  });

  describe('store.max', () => {
    it('returns maximum of a numeric field', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'A', price: 10 } });
      await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'B', price: 99 } });

      const resp = await sendRequest(ws, {
        type: 'store.max',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBe(99);
    });

    it('returns null for empty bucket', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.max',
        bucket: 'products',
        field: 'price',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });
  });

  // ── store.buckets / store.stats ────────────────────────────────

  describe('store.buckets', () => {
    it('lists all defined buckets', async () => {
      const resp = await sendRequest(ws, { type: 'store.buckets' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['count']).toBe(2);
      const names = data['names'] as string[];
      expect(names).toContain('users');
      expect(names).toContain('products');
    });
  });

  describe('store.stats', () => {
    it('returns store statistics', async () => {
      await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Stat' } });

      const resp = await sendRequest(ws, { type: 'store.stats' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['buckets']).toBeDefined();
      expect(data['records']).toBeDefined();
    });
  });

  // ── Unknown store operation ────────────────────────────────────

  describe('unknown store operation', () => {
    it('returns UNKNOWN_OPERATION for unrecognized store operation', async () => {
      const resp = await sendRequest(ws, {
        type: 'store.nonexistent',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });
  });

  // ── Cross-bucket operations ────────────────────────────────────

  describe('cross-bucket operations', () => {
    it('operations on different buckets are independent', async () => {
      const userResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });
      const productResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'products',
        data: { title: 'Widget', price: 9.99 },
      });

      expect(userResp['type']).toBe('result');
      expect(productResp['type']).toBe('result');

      const usersAll = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
      const productsAll = await sendRequest(ws, { type: 'store.all', bucket: 'products' });

      expect((usersAll['data'] as unknown[]).length).toBe(1);
      expect((productsAll['data'] as unknown[]).length).toBe(1);
    });
  });

  // ── Multi-client data consistency ──────────────────────────────

  describe('multi-client data consistency', () => {
    it('data inserted by one client is visible to another', async () => {
      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      // Client 1 inserts
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'SharedUser' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      // Client 2 reads
      const getResp = await sendRequest(ws2, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(getResp['type']).toBe('result');
      const data = getResp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('SharedUser');
    });

    it('data deleted by one client is reflected for another', async () => {
      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      // Client 1 inserts
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'ToDelete' },
      });
      const inserted = insertResp['data'] as Record<string, unknown>;

      // Client 1 deletes
      await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key: inserted['id'],
      });

      // Client 2 verifies
      const getResp = await sendRequest(ws2, {
        type: 'store.get',
        bucket: 'users',
        key: inserted['id'],
      });

      expect(getResp['type']).toBe('result');
      expect(getResp['data']).toBeNull();
    });

    it('concurrent inserts from multiple clients are all persisted', async () => {
      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      await Promise.all([
        sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'FromClient1' } }),
        sendRequest(ws2, { type: 'store.insert', bucket: 'users', data: { name: 'FromClient2' } }),
      ]);

      const allResp = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
      const data = allResp['data'] as Record<string, unknown>[];
      expect(data).toHaveLength(2);

      const names = data.map((r) => r['name']);
      expect(names).toContain('FromClient1');
      expect(names).toContain('FromClient2');
    });
  });

  // ── Full CRUD Lifecycle ────────────────────────────────────────

  describe('full CRUD lifecycle', () => {
    it('insert → read → update → read → delete → verify deleted', async () => {
      // Insert
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Lifecycle', email: 'life@example.com', role: 'user' },
      });
      expect(insertResp['type']).toBe('result');
      const inserted = insertResp['data'] as Record<string, unknown>;
      const key = inserted['id'] as string;

      // Read
      const getResp1 = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key,
      });
      expect((getResp1['data'] as Record<string, unknown>)['name']).toBe('Lifecycle');

      // Update
      const updateResp = await sendRequest(ws, {
        type: 'store.update',
        bucket: 'users',
        key,
        data: { name: 'Updated', role: 'admin' },
      });
      expect(updateResp['type']).toBe('result');
      const updated = updateResp['data'] as Record<string, unknown>;
      expect(updated['name']).toBe('Updated');
      expect(updated['role']).toBe('admin');
      expect(updated['_version']).toBe(2);

      // Read again
      const getResp2 = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key,
      });
      expect((getResp2['data'] as Record<string, unknown>)['name']).toBe('Updated');
      expect((getResp2['data'] as Record<string, unknown>)['role']).toBe('admin');

      // Delete
      const deleteResp = await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key,
      });
      expect(deleteResp['data']).toEqual({ deleted: true });

      // Verify deleted
      const getResp3 = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key,
      });
      expect(getResp3['data']).toBeNull();
    });
  });
});
