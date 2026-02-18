import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import {
  ProcedureEngine,
  ProcedureAlreadyExistsError,
  ProcedureNotFoundError,
  ProcedureValidationError,
} from '../../../src/procedures/procedure-engine.js';
import { ProcedureInputError } from '../../../src/procedures/procedure-engine.js';

// ── Setup ────────────────────────────────────────────────────────

let store: Store;
let engine: RuleEngine;
let proc: ProcedureEngine;
let storeCounter = 0;

beforeEach(async () => {
  store = await Store.start({ name: `engine-test-${++storeCounter}` });
  engine = await RuleEngine.start({ name: `engine-rules-${storeCounter}` });
  proc = new ProcedureEngine(store, engine);

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
    },
  });
});

afterEach(async () => {
  await engine.stop();
  await store.stop();
});

// ── Tests ────────────────────────────────────────────────────────

describe('ProcedureEngine', () => {
  // ── register ────────────────────────────────────────────────

  describe('register', () => {
    it('registers a procedure', () => {
      proc.register({
        name: 'test-proc',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      expect(proc.get('test-proc')).toBeDefined();
    });

    it('throws on duplicate name', () => {
      proc.register({
        name: 'dup',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      expect(() => proc.register({
        name: 'dup',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      })).toThrow(ProcedureAlreadyExistsError);
    });

    it('validates procedure config', () => {
      expect(() => proc.register({
        name: '',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      })).toThrow(ProcedureValidationError);
    });
  });

  // ── unregister ──────────────────────────────────────────────

  describe('unregister', () => {
    it('removes a registered procedure', () => {
      proc.register({
        name: 'to-remove',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      expect(proc.unregister('to-remove')).toBe(true);
      expect(proc.get('to-remove')).toBeUndefined();
    });

    it('returns false for non-existent procedure', () => {
      expect(proc.unregister('nonexistent')).toBe(false);
    });
  });

  // ── update ──────────────────────────────────────────────────

  describe('update', () => {
    it('updates procedure config', () => {
      proc.register({
        name: 'updatable',
        description: 'Original',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      proc.update('updatable', { description: 'Updated' });
      const p = proc.get('updatable')!;
      expect(p.description).toBe('Updated');
    });

    it('preserves name on update', () => {
      proc.register({
        name: 'original',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      proc.update('original', { name: 'different' } as Record<string, unknown>);
      expect(proc.get('original')).toBeDefined();
      expect(proc.get('different')).toBeUndefined();
    });

    it('throws for non-existent procedure', () => {
      expect(() => proc.update('nonexistent', { description: 'x' })).toThrow(ProcedureNotFoundError);
    });

    it('validates updated config', () => {
      proc.register({
        name: 'valid',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      expect(() => proc.update('valid', { steps: [] })).toThrow(ProcedureValidationError);
    });
  });

  // ── get ─────────────────────────────────────────────────────

  describe('get', () => {
    it('returns procedure config', () => {
      proc.register({
        name: 'gettable',
        description: 'Test',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      const p = proc.get('gettable');
      expect(p).toBeDefined();
      expect(p!.name).toBe('gettable');
      expect(p!.description).toBe('Test');
    });

    it('returns undefined for non-existent', () => {
      expect(proc.get('nonexistent')).toBeUndefined();
    });
  });

  // ── list ────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty list initially', () => {
      expect(proc.list()).toEqual([]);
    });

    it('lists registered procedures', () => {
      proc.register({
        name: 'proc-a',
        description: 'Procedure A',
        steps: [
          { action: 'store.get', bucket: 'orders', key: 'k', as: 'r' },
          { action: 'store.count', bucket: 'orders', as: 'c' },
        ],
      });
      proc.register({
        name: 'proc-b',
        steps: [{ action: 'store.get', bucket: 'orders', key: 'k', as: 'r' }],
      });

      const list = proc.list();
      expect(list).toHaveLength(2);
      expect(list).toContainEqual({ name: 'proc-a', description: 'Procedure A', stepsCount: 2 });
      expect(list).toContainEqual({ name: 'proc-b', description: undefined, stepsCount: 1 });
    });
  });

  // ── call ────────────────────────────────────────────────────

  describe('call', () => {
    it('executes a simple procedure', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending', total: 0 });

      proc.register({
        name: 'get-order',
        input: { orderId: { type: 'string' } },
        steps: [
          { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
        ],
      });

      const result = await proc.call('get-order', { orderId: order.id });
      expect(result.success).toBe(true);
      expect(result.results['order']).toMatchObject({ id: order.id, status: 'pending' });
    });

    it('executes a multi-step procedure', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending', total: 0 });
      await store.bucket('items').insert({ orderId: order.id, name: 'A', price: 100 });
      await store.bucket('items').insert({ orderId: order.id, name: 'B', price: 50.50 });

      proc.register({
        name: 'calculate-invoice',
        input: { orderId: { type: 'string' } },
        steps: [
          { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
          { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
          { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
          { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { total: '{{ total }}', status: 'calculated' } },
        ],
      });

      const result = await proc.call('calculate-invoice', { orderId: order.id });
      expect(result.success).toBe(true);
      expect(result.results['total']).toBe(150.50);

      const updated = await store.bucket('orders').get(order.id);
      expect(updated).toMatchObject({ total: 150.50, status: 'calculated' });
    });

    it('supports return value', async () => {
      proc.register({
        name: 'count-orders',
        steps: [
          { action: 'store.count', bucket: 'orders', as: 'count' },
          { action: 'return', value: { orderCount: '{{ count }}' } },
        ],
      });

      await store.bucket('orders').insert({ status: 'a' });
      await store.bucket('orders').insert({ status: 'b' });

      const result = await proc.call('count-orders', {});
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ orderCount: 2 });
    });

    it('emits rules events during execution', async () => {
      const events: Array<{ topic: string }> = [];
      engine.subscribe('invoice.*', (_event, topic) => events.push({ topic }));

      proc.register({
        name: 'emit-test',
        steps: [
          { action: 'rules.emit', topic: 'invoice.created', data: { amount: 100 } },
        ],
      });

      await proc.call('emit-test', {});
      expect(events).toHaveLength(1);
      expect(events[0]!.topic).toBe('invoice.created');
    });

    it('executes conditional branches', async () => {
      const events: string[] = [];
      engine.subscribe('*', (_e, topic) => events.push(topic));

      proc.register({
        name: 'conditional',
        input: { amount: { type: 'number' } },
        steps: [
          {
            action: 'if',
            condition: { ref: 'input.amount', operator: 'gte', value: 1000 },
            then: [{ action: 'rules.emit', topic: 'big.order' }],
            else: [{ action: 'rules.emit', topic: 'small.order' }],
          },
        ],
      });

      await proc.call('conditional', { amount: 5000 });
      expect(events).toContain('big.order');

      events.length = 0;
      await proc.call('conditional', { amount: 50 });
      expect(events).toContain('small.order');
    });

    it('throws for non-existent procedure', async () => {
      await expect(proc.call('nonexistent', {})).rejects.toThrow(ProcedureNotFoundError);
    });

    it('validates input types', async () => {
      proc.register({
        name: 'typed-input',
        input: {
          orderId: { type: 'string', required: true },
          count: { type: 'number' },
        },
        steps: [{ action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'r' }],
      });

      await expect(
        proc.call('typed-input', { orderId: 123 as unknown as string }),
      ).rejects.toThrow(ProcedureInputError);

      await expect(
        proc.call('typed-input', { count: 5 }),
      ).rejects.toThrow(ProcedureInputError);
    });

    it('applies default input values', async () => {
      proc.register({
        name: 'defaults',
        input: {
          status: { type: 'string', required: false, default: 'pending' },
        },
        steps: [
          { action: 'store.insert', bucket: 'orders', data: { status: '{{ input.status }}' }, as: 'result' },
        ],
      });

      const result = await proc.call('defaults', {});
      expect(result.success).toBe(true);
      expect((result.results['result'] as Record<string, unknown>)['status']).toBe('pending');
    });

    it('executes with timeout (does not timeout for fast procedures)', async () => {
      proc.register({
        name: 'fast',
        timeoutMs: 5000,
        steps: [{ action: 'store.count', bucket: 'orders', as: 'count' }],
      });

      const result = await proc.call('fast', {});
      expect(result.success).toBe(true);
    });
  });

  // ── call with transaction ───────────────────────────────────

  describe('call with transaction', () => {
    it('executes steps in transaction', async () => {
      const order = await store.bucket('orders').insert({ status: 'pending', total: 0 });

      proc.register({
        name: 'tx-proc',
        input: { orderId: { type: 'string' } },
        transaction: true,
        steps: [
          { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { status: 'processed', total: 100 } },
        ],
      });

      const result = await proc.call('tx-proc', { orderId: order.id });
      expect(result.success).toBe(true);

      const updated = await store.bucket('orders').get(order.id);
      expect(updated).toMatchObject({ status: 'processed', total: 100 });
    });
  });

  // ── constructor config ──────────────────────────────────────

  describe('constructor config', () => {
    it('works without rules engine', async () => {
      const procNoRules = new ProcedureEngine(store);

      procNoRules.register({
        name: 'no-rules',
        steps: [{ action: 'store.count', bucket: 'orders', as: 'count' }],
      });

      const result = await procNoRules.call('no-rules', {});
      expect(result.success).toBe(true);
    });

    it('respects custom limits', () => {
      const limitedProc = new ProcedureEngine(store, null, { maxSteps: 2 });

      expect(() => limitedProc.register({
        name: 'too-many',
        steps: [
          { action: 'store.get', bucket: 'b', key: 'k', as: 'r1' },
          { action: 'store.get', bucket: 'b', key: 'k', as: 'r2' },
          { action: 'store.get', bucket: 'b', key: 'k', as: 'r3' },
        ],
      })).toThrow(ProcedureValidationError);
    });
  });
});
