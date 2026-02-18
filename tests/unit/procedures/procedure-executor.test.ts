import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { executeStep, executeSteps } from '../../../src/procedures/procedure-executor.js';
import type { ExecutionContext, ProcedureStep } from '../../../src/procedures/procedure-types.js';

// ── Helpers ──────────────────────────────────────────────────────

let store: Store;
let engine: RuleEngine;
let storeCounter = 0;

function ctx(
  input: Record<string, unknown> = {},
  results: Record<string, unknown> = {},
): ExecutionContext {
  return {
    input,
    results: new Map(Object.entries(results)),
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────

beforeEach(async () => {
  store = await Store.start({ name: `exec-test-${++storeCounter}` });
  engine = await RuleEngine.start({ name: `exec-rules-${storeCounter}` });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      total: { type: 'number', default: 0 },
      status: { type: 'string', default: 'pending' },
    },
  });

  await store.defineBucket('items', {
    key: 'id',
    schema: {
      id: { type: 'string', generated: 'uuid' },
      orderId: { type: 'string', required: true },
      name: { type: 'string', required: true },
      price: { type: 'number', required: true },
      active: { type: 'boolean', default: true },
    },
  });
});

afterEach(async () => {
  await engine.stop();
  await store.stop();
});

// ── Tests ────────────────────────────────────────────────────────

describe('procedure-executor', () => {
  // ── store.get ───────────────────────────────────────────────

  describe('store.get', () => {
    it('loads a record and stores under "as"', async () => {
      const order = await store.bucket('orders').insert({ status: 'new' });
      const c = ctx({ orderId: order.id });

      await executeStep(
        { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
        c, store, null,
      );

      expect(c.results.get('order')).toMatchObject({ id: order.id, status: 'new' });
    });

    it('stores null for non-existent record', async () => {
      const c = ctx({ orderId: 'non-existent' });

      await executeStep(
        { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
        c, store, null,
      );

      expect(c.results.get('order')).toBeNull();
    });
  });

  // ── store.where ─────────────────────────────────────────────

  describe('store.where', () => {
    it('filters records', async () => {
      const order = await store.bucket('orders').insert({ status: 'new' });
      await store.bucket('items').insert({ orderId: order.id, name: 'A', price: 10 });
      await store.bucket('items').insert({ orderId: order.id, name: 'B', price: 20 });
      await store.bucket('items').insert({ orderId: 'other', name: 'C', price: 30 });

      const c = ctx({ orderId: order.id });

      await executeStep(
        { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
        c, store, null,
      );

      const items = c.results.get('items') as unknown[];
      expect(items).toHaveLength(2);
    });
  });

  // ── store.findOne ───────────────────────────────────────────

  describe('store.findOne', () => {
    it('finds one matching record', async () => {
      await store.bucket('orders').insert({ status: 'paid' });
      await store.bucket('orders').insert({ status: 'pending' });

      const c = ctx();

      await executeStep(
        { action: 'store.findOne', bucket: 'orders', filter: { status: 'paid' }, as: 'paidOrder' },
        c, store, null,
      );

      expect(c.results.get('paidOrder')).toMatchObject({ status: 'paid' });
    });

    it('stores null when no match', async () => {
      const c = ctx();

      await executeStep(
        { action: 'store.findOne', bucket: 'orders', filter: { status: 'nonexistent' }, as: 'result' },
        c, store, null,
      );

      expect(c.results.get('result')).toBeNull();
    });
  });

  // ── store.insert ────────────────────────────────────────────

  describe('store.insert', () => {
    it('inserts a record', async () => {
      const c = ctx({ name: 'Widget', price: 99 });

      await executeStep(
        { action: 'store.insert', bucket: 'items', data: { orderId: 'ord-1', name: '{{ input.name }}', price: '{{ input.price }}' }, as: 'inserted' },
        c, store, null,
      );

      const inserted = c.results.get('inserted') as Record<string, unknown>;
      expect(inserted).toMatchObject({ orderId: 'ord-1', name: 'Widget', price: 99 });
      expect(inserted['id']).toBeDefined();
    });

    it('works without "as"', async () => {
      const c = ctx();

      await executeStep(
        { action: 'store.insert', bucket: 'items', data: { orderId: 'ord-1', name: 'X', price: 5 } },
        c, store, null,
      );

      // No result stored, but no error
      expect(c.results.size).toBe(0);

      // Record should exist in store
      const all = await store.bucket('items').all();
      expect(all).toHaveLength(1);
    });
  });

  // ── store.update ────────────────────────────────────────────

  describe('store.update', () => {
    it('updates a record', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending', total: 0 });
      const c = ctx({ orderId: order.id }, { newTotal: 150 });

      await executeStep(
        { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { total: '{{ newTotal }}', status: 'calculated' }, as: 'updated' },
        c, store, null,
      );

      const updated = c.results.get('updated') as Record<string, unknown>;
      expect(updated).toMatchObject({ total: 150, status: 'calculated' });
    });
  });

  // ── store.delete ────────────────────────────────────────────

  describe('store.delete', () => {
    it('deletes a record', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending' });
      const c = ctx({ orderId: order.id });

      await executeStep(
        { action: 'store.delete', bucket: 'orders', key: '{{ input.orderId }}' },
        c, store, null,
      );

      const result = await store.bucket('orders').get(order.id);
      expect(result).toBeUndefined();
    });
  });

  // ── store.count ─────────────────────────────────────────────

  describe('store.count', () => {
    it('counts all records', async () => {
      await store.bucket('orders').insert({ status: 'a' });
      await store.bucket('orders').insert({ status: 'b' });
      await store.bucket('orders').insert({ status: 'c' });

      const c = ctx();

      await executeStep(
        { action: 'store.count', bucket: 'orders', as: 'count' },
        c, store, null,
      );

      expect(c.results.get('count')).toBe(3);
    });

    it('counts filtered records', async () => {
      await store.bucket('orders').insert({ status: 'paid' });
      await store.bucket('orders').insert({ status: 'paid' });
      await store.bucket('orders').insert({ status: 'pending' });

      const c = ctx();

      await executeStep(
        { action: 'store.count', bucket: 'orders', filter: { status: 'paid' }, as: 'count' },
        c, store, null,
      );

      expect(c.results.get('count')).toBe(2);
    });
  });

  // ── aggregate ───────────────────────────────────────────────

  describe('aggregate', () => {
    it('sums values', async () => {
      const c = ctx({}, {
        items: [{ price: 100 }, { price: 50 }, { price: 25.50 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
        c, store, null,
      );

      expect(c.results.get('total')).toBe(175.50);
    });

    it('computes average', async () => {
      const c = ctx({}, {
        items: [{ price: 10 }, { price: 20 }, { price: 30 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'avg', as: 'avg' },
        c, store, null,
      );

      expect(c.results.get('avg')).toBe(20);
    });

    it('computes min', async () => {
      const c = ctx({}, {
        items: [{ price: 50 }, { price: 10 }, { price: 30 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'min', as: 'min' },
        c, store, null,
      );

      expect(c.results.get('min')).toBe(10);
    });

    it('computes max', async () => {
      const c = ctx({}, {
        items: [{ price: 50 }, { price: 10 }, { price: 30 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'max', as: 'max' },
        c, store, null,
      );

      expect(c.results.get('max')).toBe(50);
    });

    it('counts items', async () => {
      const c = ctx({}, {
        items: [{ price: 50 }, { price: 10 }, { price: 30 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'count', as: 'count' },
        c, store, null,
      );

      expect(c.results.get('count')).toBe(3);
    });

    it('returns 0 for empty array sum', async () => {
      const c = ctx({}, { items: [] });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
        c, store, null,
      );

      expect(c.results.get('total')).toBe(0);
    });

    it('returns 0 for empty array avg', async () => {
      const c = ctx({}, { items: [] });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'avg', as: 'avg' },
        c, store, null,
      );

      expect(c.results.get('avg')).toBe(0);
    });

    it('throws when source is not an array', async () => {
      const c = ctx({}, { items: 'not-array' });

      await expect(
        executeStep(
          { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
          c, store, null,
        ),
      ).rejects.toThrow('not an array');
    });

    it('skips non-numeric values in aggregation', async () => {
      const c = ctx({}, {
        items: [{ price: 10 }, { price: 'invalid' }, { price: 30 }],
      });

      await executeStep(
        { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
        c, store, null,
      );

      expect(c.results.get('total')).toBe(40);
    });
  });

  // ── rules.emit ──────────────────────────────────────────────

  describe('rules.emit', () => {
    it('emits an event', async () => {
      const events: Array<{ topic: string; data: unknown }> = [];
      engine.subscribe('order.*', (event, topic) => events.push({ topic, data: event }));

      const c = ctx({ orderId: 'ord-1' });

      await executeStep(
        { action: 'rules.emit', topic: 'order.created', data: { orderId: '{{ input.orderId }}' } },
        c, store, engine,
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.topic).toBe('order.created');
    });

    it('emits without data', async () => {
      const events: unknown[] = [];
      engine.subscribe('ping', () => events.push(true));

      const c = ctx();

      await executeStep(
        { action: 'rules.emit', topic: 'ping' },
        c, store, engine,
      );

      expect(events).toHaveLength(1);
    });

    it('throws when rules engine is not configured', async () => {
      const c = ctx();

      await expect(
        executeStep(
          { action: 'rules.emit', topic: 'test' },
          c, store, null,
        ),
      ).rejects.toThrow('rule engine is not configured');
    });
  });

  // ── rules.setFact / rules.getFact ───────────────────────────

  describe('rules.setFact / rules.getFact', () => {
    it('sets and gets a fact', async () => {
      const c = ctx();

      await executeStep(
        { action: 'rules.setFact', key: 'user:1:active', value: true },
        c, store, engine,
      );

      await executeStep(
        { action: 'rules.getFact', key: 'user:1:active', as: 'isActive' },
        c, store, engine,
      );

      expect(c.results.get('isActive')).toBe(true);
    });

    it('resolves references in key and value', async () => {
      const c = ctx({ userId: '1' }, { status: 'active' });

      await executeStep(
        { action: 'rules.setFact', key: 'user:{{ input.userId }}:status', value: '{{ status }}' },
        c, store, engine,
      );

      const fact = engine.getFact('user:1:status');
      expect(fact).toBe('active');
    });

    it('stores null for non-existent fact', async () => {
      const c = ctx();

      await executeStep(
        { action: 'rules.getFact', key: 'non-existent', as: 'result' },
        c, store, engine,
      );

      expect(c.results.get('result')).toBeNull();
    });

    it('throws when rules engine is not configured', async () => {
      const c = ctx();

      await expect(
        executeStep(
          { action: 'rules.setFact', key: 'k', value: true },
          c, store, null,
        ),
      ).rejects.toThrow('rule engine is not configured');
    });
  });

  // ── if/then/else ────────────────────────────────────────────

  describe('if/then/else', () => {
    it('executes then branch when condition is true', async () => {
      const c = ctx({}, { total: 1500 });

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'total', operator: 'gte', value: 1000 },
          then: [
            { action: 'rules.emit', topic: 'big.order' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );

      // No error — we just check it doesn't throw
    });

    it('executes else branch when condition is false', async () => {
      const events: string[] = [];
      engine.subscribe('*', (_event, topic) => events.push(topic));

      const c = ctx({}, { total: 500 });

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'total', operator: 'gte', value: 1000 },
          then: [
            { action: 'rules.emit', topic: 'big.order' } as ProcedureStep,
          ],
          else: [
            { action: 'rules.emit', topic: 'small.order' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );

      expect(events).toContain('small.order');
      expect(events).not.toContain('big.order');
    });

    it('supports eq operator', async () => {
      const c = ctx({}, { status: 'paid' });

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'status', operator: 'eq', value: 'paid' },
          then: [
            { action: 'rules.emit', topic: 'matched' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );
    });

    it('supports neq operator', async () => {
      const c = ctx({}, { status: 'pending' });
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'status', operator: 'neq', value: 'paid' },
          then: [
            { action: 'rules.emit', topic: 'not-paid' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );

      expect(events).toContain('not-paid');
    });

    it('supports exists operator', async () => {
      const c = ctx({}, { order: { id: '1' } });
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'order', operator: 'exists' },
          then: [
            { action: 'rules.emit', topic: 'found' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );

      expect(events).toContain('found');
    });

    it('supports not_exists operator', async () => {
      const c = ctx({}, {});
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'missing', operator: 'not_exists' },
          then: [
            { action: 'rules.emit', topic: 'not-found' } as ProcedureStep,
          ],
        },
        c, store, engine,
      );

      expect(events).toContain('not-found');
    });

    it('supports numeric comparisons (gt, lt, lte)', async () => {
      const c = ctx({}, { count: 5 });
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'count', operator: 'gt', value: 3 },
          then: [{ action: 'rules.emit', topic: 'gt-3' } as ProcedureStep],
        },
        c, store, engine,
      );

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'count', operator: 'lt', value: 10 },
          then: [{ action: 'rules.emit', topic: 'lt-10' } as ProcedureStep],
        },
        c, store, engine,
      );

      await executeStep(
        {
          action: 'if',
          condition: { ref: 'count', operator: 'lte', value: 5 },
          then: [{ action: 'rules.emit', topic: 'lte-5' } as ProcedureStep],
        },
        c, store, engine,
      );

      expect(events).toContain('gt-3');
      expect(events).toContain('lt-10');
      expect(events).toContain('lte-5');
    });
  });

  // ── transform ───────────────────────────────────────────────

  describe('transform', () => {
    it('plucks values from array of objects', async () => {
      const c = ctx({}, {
        items: [{ name: 'A', price: 10 }, { name: 'B', price: 20 }],
      });

      await executeStep(
        { action: 'transform', source: 'items', operation: 'pluck', args: 'name', as: 'names' },
        c, store, null,
      );

      expect(c.results.get('names')).toEqual(['A', 'B']);
    });

    it('picks fields from object', async () => {
      const c = ctx({}, {
        order: { id: '1', total: 500, status: 'paid', createdAt: 123 },
      });

      await executeStep(
        { action: 'transform', source: 'order', operation: 'pick', args: ['id', 'total'], as: 'summary' },
        c, store, null,
      );

      expect(c.results.get('summary')).toEqual({ id: '1', total: 500 });
    });

    it('filters array by criteria', async () => {
      const c = ctx({}, {
        items: [
          { name: 'A', active: true },
          { name: 'B', active: false },
          { name: 'C', active: true },
        ],
      });

      await executeStep(
        { action: 'transform', source: 'items', operation: 'filter', args: { active: true }, as: 'active' },
        c, store, null,
      );

      const active = c.results.get('active') as unknown[];
      expect(active).toHaveLength(2);
    });

    it('maps over array adding fields', async () => {
      const c = ctx({}, {
        items: [{ name: 'A' }, { name: 'B' }],
      });

      await executeStep(
        { action: 'transform', source: 'items', operation: 'map', args: { processed: true }, as: 'mapped' },
        c, store, null,
      );

      const mapped = c.results.get('mapped') as Array<Record<string, unknown>>;
      expect(mapped).toHaveLength(2);
      expect(mapped[0]).toMatchObject({ name: 'A', processed: true });
      expect(mapped[1]).toMatchObject({ name: 'B', processed: true });
    });

    it('throws when pluck source is not an array', async () => {
      const c = ctx({}, { items: 'not-array' });

      await expect(
        executeStep(
          { action: 'transform', source: 'items', operation: 'pluck', args: 'name', as: 'r' },
          c, store, null,
        ),
      ).rejects.toThrow('not an array');
    });

    it('throws when pick source is not an object', async () => {
      const c = ctx({}, { items: [1, 2, 3] });

      await expect(
        executeStep(
          { action: 'transform', source: 'items', operation: 'pick', args: ['x'], as: 'r' },
          c, store, null,
        ),
      ).rejects.toThrow('not an object');
    });
  });

  // ── return ──────────────────────────────────────────────────

  describe('return', () => {
    it('sets return value and stops execution', async () => {
      const c = ctx({}, { total: 150 });

      await executeStep(
        { action: 'return', value: { success: true, total: '{{ total }}' } },
        c, store, null,
      );

      expect(c.returnValue).toEqual({ success: true, total: 150 });
      expect(c.returned).toBe(true);
    });

    it('stops subsequent steps from executing', async () => {
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      const c = ctx();
      const steps: ProcedureStep[] = [
        { action: 'return', value: 'done' },
        { action: 'rules.emit', topic: 'should.not.fire' },
      ];

      await executeSteps(steps, c, store, engine);

      expect(c.returnValue).toBe('done');
      expect(events).toHaveLength(0);
    });
  });

  // ── executeSteps ────────────────────────────────────────────

  describe('executeSteps', () => {
    it('executes steps in sequence', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending', total: 0 });
      await store.bucket('items').insert({ orderId: order.id, name: 'A', price: 100 });
      await store.bucket('items').insert({ orderId: order.id, name: 'B', price: 50 });

      const c = ctx({ orderId: order.id });
      const steps: ProcedureStep[] = [
        { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
        { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
        { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
        { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { total: '{{ total }}', status: 'calculated' } },
      ];

      await executeSteps(steps, c, store, null);

      expect(c.results.get('total')).toBe(150);
      const updated = await store.bucket('orders').get(order.id);
      expect(updated).toMatchObject({ total: 150, status: 'calculated' });
    });

    it('skips steps after return', async () => {
      const c = ctx();
      const steps: ProcedureStep[] = [
        { action: 'store.count', bucket: 'orders', as: 'count' },
        { action: 'return', value: '{{ count }}' },
        { action: 'store.insert', bucket: 'orders', data: { status: 'should-not-insert' } },
      ];

      await executeSteps(steps, c, store, null);

      expect(c.returned).toBe(true);
      const all = await store.bucket('orders').all();
      expect(all).toHaveLength(0);
    });
  });
});
