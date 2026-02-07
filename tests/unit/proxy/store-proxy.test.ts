import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import type { ClientRequest } from '../../../src/protocol/types.js';
import { handleStoreRequest, mapStoreError } from '../../../src/proxy/store-proxy.js';
import { NoexServerError } from '../../../src/errors.js';
import { ErrorCode } from '../../../src/protocol/codes.js';

// ── Test Helpers ──────────────────────────────────────────────────

let store: Store;

function request(
  type: string,
  payload: Record<string, unknown> = {},
): ClientRequest {
  return { id: 1, type, ...payload } as ClientRequest;
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(async () => {
  store = await Store.start({ name: 'test-store' });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
      role: { type: 'string', default: 'user' },
      age: { type: 'number' },
    },
  });

  await store.defineBucket('items', {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      title: { type: 'string', required: true },
      price: { type: 'number', default: 0 },
    },
  });
});

afterEach(async () => {
  await store.stop();
});

// ── Tests ─────────────────────────────────────────────────────────

describe('store-proxy', () => {
  // ── store.insert ─────────────────────────────────────────────

  describe('store.insert', () => {
    it('inserts a record and returns it with metadata', async () => {
      const result = await handleStoreRequest(
        request('store.insert', { bucket: 'users', data: { name: 'Alice' } }),
        store,
      ) as Record<string, unknown>;

      expect(result['name']).toBe('Alice');
      expect(result['role']).toBe('user');
      expect(typeof result['id']).toBe('string');
      expect(result['_version']).toBe(1);
      expect(typeof result['_createdAt']).toBe('number');
    });

    it('throws VALIDATION_ERROR when bucket is missing', async () => {
      await expect(
        handleStoreRequest(request('store.insert', { data: { name: 'A' } }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"bucket"'),
      });
    });

    it('throws VALIDATION_ERROR when data is missing', async () => {
      await expect(
        handleStoreRequest(request('store.insert', { bucket: 'users' }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"data"'),
      });
    });

    it('throws VALIDATION_ERROR for store schema violations', async () => {
      await expect(
        handleStoreRequest(
          request('store.insert', { bucket: 'users', data: { age: 25 } }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('throws BUCKET_NOT_DEFINED for unknown bucket', async () => {
      await expect(
        handleStoreRequest(
          request('store.insert', { bucket: 'nonexistent', data: { x: 1 } }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.BUCKET_NOT_DEFINED,
      });
    });
  });

  // ── store.get ────────────────────────────────────────────────

  describe('store.get', () => {
    it('returns a record by key', async () => {
      const inserted = await store.bucket('users').insert({ name: 'Bob' }) as Record<string, unknown>;
      const result = await handleStoreRequest(
        request('store.get', { bucket: 'users', key: inserted['id'] }),
        store,
      ) as Record<string, unknown>;

      expect(result['name']).toBe('Bob');
      expect(result['id']).toBe(inserted['id']);
    });

    it('returns null for non-existent key', async () => {
      const result = await handleStoreRequest(
        request('store.get', { bucket: 'users', key: 'no-such-key' }),
        store,
      );

      expect(result).toBeNull();
    });

    it('throws VALIDATION_ERROR when key is missing', async () => {
      await expect(
        handleStoreRequest(request('store.get', { bucket: 'users' }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"key"'),
      });
    });
  });

  // ── store.update ─────────────────────────────────────────────

  describe('store.update', () => {
    it('updates a record and returns the new version', async () => {
      const inserted = await store.bucket('users').insert({ name: 'Carol' }) as Record<string, unknown>;

      const result = await handleStoreRequest(
        request('store.update', {
          bucket: 'users',
          key: inserted['id'],
          data: { name: 'Caroline' },
        }),
        store,
      ) as Record<string, unknown>;

      expect(result['name']).toBe('Caroline');
      expect(result['_version']).toBe(2);
    });

    it('throws VALIDATION_ERROR when key is missing', async () => {
      await expect(
        handleStoreRequest(
          request('store.update', { bucket: 'users', data: { name: 'X' } }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('throws VALIDATION_ERROR when data is missing', async () => {
      await expect(
        handleStoreRequest(
          request('store.update', { bucket: 'users', key: 'k1' }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ── store.delete ─────────────────────────────────────────────

  describe('store.delete', () => {
    it('deletes a record and returns { deleted: true }', async () => {
      const inserted = await store.bucket('users').insert({ name: 'Dave' }) as Record<string, unknown>;

      const result = await handleStoreRequest(
        request('store.delete', { bucket: 'users', key: inserted['id'] }),
        store,
      );

      expect(result).toEqual({ deleted: true });

      const check = await store.bucket('users').get(inserted['id']);
      expect(check).toBeUndefined();
    });

    it('throws VALIDATION_ERROR when key is missing', async () => {
      await expect(
        handleStoreRequest(request('store.delete', { bucket: 'users' }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ── store.all ────────────────────────────────────────────────

  describe('store.all', () => {
    it('returns all records in a bucket', async () => {
      await store.bucket('users').insert({ name: 'Eve' });
      await store.bucket('users').insert({ name: 'Frank' });

      const result = await handleStoreRequest(
        request('store.all', { bucket: 'users' }),
        store,
      ) as unknown[];

      expect(result).toHaveLength(2);
    });

    it('returns empty array for empty bucket', async () => {
      const result = await handleStoreRequest(
        request('store.all', { bucket: 'users' }),
        store,
      ) as unknown[];

      expect(result).toEqual([]);
    });

    it('throws VALIDATION_ERROR when bucket is missing', async () => {
      await expect(
        handleStoreRequest(request('store.all'), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ── store.where ──────────────────────────────────────────────

  describe('store.where', () => {
    it('filters records by criteria', async () => {
      await store.bucket('users').insert({ name: 'Grace', role: 'admin' });
      await store.bucket('users').insert({ name: 'Henry', role: 'user' });
      await store.bucket('users').insert({ name: 'Iris', role: 'admin' });

      const result = await handleStoreRequest(
        request('store.where', { bucket: 'users', filter: { role: 'admin' } }),
        store,
      ) as Record<string, unknown>[];

      expect(result).toHaveLength(2);
      expect(result.every((r) => r['role'] === 'admin')).toBe(true);
    });

    it('throws VALIDATION_ERROR when filter is missing', async () => {
      await expect(
        handleStoreRequest(request('store.where', { bucket: 'users' }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"filter"'),
      });
    });
  });

  // ── store.findOne ────────────────────────────────────────────

  describe('store.findOne', () => {
    it('returns the first matching record', async () => {
      await store.bucket('users').insert({ name: 'Jane', role: 'admin' });

      const result = await handleStoreRequest(
        request('store.findOne', { bucket: 'users', filter: { role: 'admin' } }),
        store,
      ) as Record<string, unknown>;

      expect(result['name']).toBe('Jane');
    });

    it('returns null when no record matches', async () => {
      const result = await handleStoreRequest(
        request('store.findOne', { bucket: 'users', filter: { role: 'superadmin' } }),
        store,
      );

      expect(result).toBeNull();
    });

    it('throws VALIDATION_ERROR when filter is missing', async () => {
      await expect(
        handleStoreRequest(request('store.findOne', { bucket: 'users' }), store),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ── store.count ──────────────────────────────────────────────

  describe('store.count', () => {
    it('returns total count without filter', async () => {
      await store.bucket('users').insert({ name: 'A' });
      await store.bucket('users').insert({ name: 'B' });

      const result = await handleStoreRequest(
        request('store.count', { bucket: 'users' }),
        store,
      );

      expect(result).toBe(2);
    });

    it('returns filtered count', async () => {
      await store.bucket('users').insert({ name: 'C', role: 'admin' });
      await store.bucket('users').insert({ name: 'D', role: 'user' });
      await store.bucket('users').insert({ name: 'E', role: 'admin' });

      const result = await handleStoreRequest(
        request('store.count', { bucket: 'users', filter: { role: 'admin' } }),
        store,
      );

      expect(result).toBe(2);
    });
  });

  // ── store.first / store.last ─────────────────────────────────

  describe('store.first', () => {
    it('returns first N records', async () => {
      await store.bucket('users').insert({ name: 'A' });
      await store.bucket('users').insert({ name: 'B' });
      await store.bucket('users').insert({ name: 'C' });

      const result = await handleStoreRequest(
        request('store.first', { bucket: 'users', n: 2 }),
        store,
      ) as unknown[];

      expect(result).toHaveLength(2);
    });

    it('throws VALIDATION_ERROR for non-integer n', async () => {
      await expect(
        handleStoreRequest(
          request('store.first', { bucket: 'users', n: 1.5 }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"n"'),
      });
    });

    it('throws VALIDATION_ERROR for zero n', async () => {
      await expect(
        handleStoreRequest(
          request('store.first', { bucket: 'users', n: 0 }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  describe('store.last', () => {
    it('returns last N records', async () => {
      await store.bucket('users').insert({ name: 'X' });
      await store.bucket('users').insert({ name: 'Y' });
      await store.bucket('users').insert({ name: 'Z' });

      const result = await handleStoreRequest(
        request('store.last', { bucket: 'users', n: 2 }),
        store,
      ) as unknown[];

      expect(result).toHaveLength(2);
    });
  });

  // ── store.paginate ───────────────────────────────────────────

  describe('store.paginate', () => {
    it('returns paginated results', async () => {
      await store.bucket('users').insert({ name: 'P1' });
      await store.bucket('users').insert({ name: 'P2' });
      await store.bucket('users').insert({ name: 'P3' });

      const result = await handleStoreRequest(
        request('store.paginate', { bucket: 'users', limit: 2 }),
        store,
      ) as Record<string, unknown>;

      const records = result['records'] as unknown[];
      expect(records).toHaveLength(2);
      expect(result['hasMore']).toBe(true);
      expect(result['nextCursor']).toBeDefined();
    });

    it('supports cursor-based pagination', async () => {
      await store.bucket('users').insert({ name: 'Q1' });
      await store.bucket('users').insert({ name: 'Q2' });
      await store.bucket('users').insert({ name: 'Q3' });

      const page1 = await handleStoreRequest(
        request('store.paginate', { bucket: 'users', limit: 2 }),
        store,
      ) as Record<string, unknown>;

      const page2 = await handleStoreRequest(
        request('store.paginate', {
          bucket: 'users',
          limit: 2,
          after: page1['nextCursor'],
        }),
        store,
      ) as Record<string, unknown>;

      const records2 = page2['records'] as unknown[];
      expect(records2).toHaveLength(1);
      expect(page2['hasMore']).toBe(false);
    });

    it('throws VALIDATION_ERROR when limit is missing', async () => {
      await expect(
        handleStoreRequest(
          request('store.paginate', { bucket: 'users' }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"limit"'),
      });
    });
  });

  // ── store.clear ──────────────────────────────────────────────

  describe('store.clear', () => {
    it('clears all records and returns { cleared: true }', async () => {
      await store.bucket('users').insert({ name: 'ToDelete' });
      await store.bucket('users').insert({ name: 'AlsoDelete' });

      const result = await handleStoreRequest(
        request('store.clear', { bucket: 'users' }),
        store,
      );

      expect(result).toEqual({ cleared: true });

      const remaining = await store.bucket('users').all();
      expect(remaining).toHaveLength(0);
    });
  });

  // ── Aggregations ─────────────────────────────────────────────

  describe('store.sum', () => {
    it('sums a numeric field', async () => {
      await store.bucket('items').insert({ title: 'A', price: 10 });
      await store.bucket('items').insert({ title: 'B', price: 20 });
      await store.bucket('items').insert({ title: 'C', price: 30 });

      const result = await handleStoreRequest(
        request('store.sum', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBe(60);
    });

    it('throws VALIDATION_ERROR when field is missing', async () => {
      await expect(
        handleStoreRequest(
          request('store.sum', { bucket: 'items' }),
          store,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining('"field"'),
      });
    });
  });

  describe('store.avg', () => {
    it('calculates average of a numeric field', async () => {
      await store.bucket('items').insert({ title: 'A', price: 10 });
      await store.bucket('items').insert({ title: 'B', price: 20 });

      const result = await handleStoreRequest(
        request('store.avg', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBe(15);
    });
  });

  describe('store.min', () => {
    it('returns minimum of a numeric field', async () => {
      await store.bucket('items').insert({ title: 'A', price: 10 });
      await store.bucket('items').insert({ title: 'B', price: 5 });

      const result = await handleStoreRequest(
        request('store.min', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBe(5);
    });

    it('returns null for empty bucket', async () => {
      const result = await handleStoreRequest(
        request('store.min', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBeNull();
    });
  });

  describe('store.max', () => {
    it('returns maximum of a numeric field', async () => {
      await store.bucket('items').insert({ title: 'A', price: 10 });
      await store.bucket('items').insert({ title: 'B', price: 50 });

      const result = await handleStoreRequest(
        request('store.max', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBe(50);
    });

    it('returns null for empty bucket', async () => {
      const result = await handleStoreRequest(
        request('store.max', { bucket: 'items', field: 'price' }),
        store,
      );

      expect(result).toBeNull();
    });
  });

  // ── store.buckets / store.stats ──────────────────────────────

  describe('store.buckets', () => {
    it('returns bucket info', async () => {
      const result = await handleStoreRequest(
        request('store.buckets'),
        store,
      ) as Record<string, unknown>;

      expect(result['count']).toBe(2);
      const names = result['names'] as string[];
      expect(names).toContain('users');
      expect(names).toContain('items');
    });
  });

  describe('store.stats', () => {
    it('returns full store statistics', async () => {
      await store.bucket('users').insert({ name: 'Stat' });

      const result = await handleStoreRequest(
        request('store.stats'),
        store,
      ) as Record<string, unknown>;

      expect(result['name']).toBe('test-store');
      expect(result['buckets']).toBeDefined();
      expect(result['records']).toBeDefined();
    });
  });

  // ── Unknown operation ────────────────────────────────────────

  describe('unknown operation', () => {
    it('throws UNKNOWN_OPERATION for unrecognized store operation', async () => {
      await expect(
        handleStoreRequest(request('store.nonexistent'), store),
      ).rejects.toMatchObject({
        code: ErrorCode.UNKNOWN_OPERATION,
        message: expect.stringContaining('store.nonexistent'),
      });
    });
  });

  // ── mapStoreError ────────────────────────────────────────────

  describe('mapStoreError', () => {
    it('passes through NoexServerError unchanged', () => {
      const original = new NoexServerError(ErrorCode.PARSE_ERROR, 'test');
      expect(mapStoreError(original)).toBe(original);
    });

    it('maps generic Error to INTERNAL_ERROR', () => {
      const error = mapStoreError(new Error('boom'));
      expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(error.message).toBe('boom');
    });

    it('maps non-Error values to INTERNAL_ERROR', () => {
      const error = mapStoreError('string error');
      expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });
});
