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

async function login(
  ws: WebSocket,
  token: string,
): Promise<Record<string, unknown>> {
  return sendRequest(ws, { type: 'auth.login', token });
}

function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('waitForPush timed out')),
      timeoutMs,
    );
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (
        msg['type'] === 'push' &&
        msg['subscriptionId'] === subscriptionId
      ) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────

const sessions: Record<string, AuthSession> = {
  admin:  { userId: 'admin-1',  roles: ['admin'] },
  writer: { userId: 'writer-1', roles: ['writer'] },
  reader: { userId: 'reader-1', roles: ['reader'] },
};

const auth: AuthConfig = {
  validate: async (token) => sessions[token] ?? null,
};

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Procedures', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  let engine: RuleEngine | undefined;
  const clients: WebSocket[] = [];
  let counter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    clients.length = 0;

    if (server?.isRunning) await server.stop();
    server = undefined;

    if (engine) await engine.stop();
    engine = undefined;

    if (store) await store.stop();
    store = undefined;
  });

  async function setup(opts?: { withAuth?: boolean }): Promise<void> {
    const suffix = ++counter;
    store = await Store.start({ name: `procedures-test-${suffix}` });
    engine = await RuleEngine.start({ name: `procedures-engine-${suffix}` });

    await store.defineBucket('orders', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        status: { type: 'string' },
        total: { type: 'number' },
      },
    });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        orderId: { type: 'string', required: true },
        price: { type: 'number', required: true },
      },
    });

    server = await NoexServer.start({
      store,
      rules: engine,
      port: 0,
      host: '127.0.0.1',
      ...(opts?.withAuth ? { auth } : {}),
    });
  }

  async function connect(token?: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    if (token) {
      const resp = await login(ws, token);
      expect(resp['type']).toBe('result');
    }
    return ws;
  }

  // ── procedures.register ─────────────────────────────────────────

  describe('procedures.register', () => {
    it('registers a procedure and returns confirmation', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'simple-proc',
          description: 'A simple procedure',
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.id }}', as: 'order' },
          ],
          input: { id: { type: 'string' } },
        },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('simple-proc');
      expect(data['registered']).toBe(true);
    });

    it('returns ALREADY_EXISTS for duplicate procedure name', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'dup-proc',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'order' },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'dup-proc',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'y', as: 'order' },
          ],
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('returns VALIDATION_ERROR for missing procedure field', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR for invalid procedure (no steps)', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'bad-proc',
          steps: [],
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── procedures.call ─────────────────────────────────────────────

  describe('procedures.call', () => {
    it('calls a simple get procedure', async () => {
      await setup();
      const ws = await connect();

      // Insert test data
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'orders',
        data: { status: 'pending', total: 0 },
      });
      const insertData = insertResp['data'] as Record<string, unknown>;
      const orderId = insertData['id'] as string;

      // Register procedure
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'get-order',
          input: { orderId: { type: 'string' } },
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
          ],
        },
      });

      // Call it
      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'get-order',
        input: { orderId },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['success']).toBe(true);
      const results = data['results'] as Record<string, unknown>;
      const order = results['order'] as Record<string, unknown>;
      expect(order['id']).toBe(orderId);
      expect(order['status']).toBe('pending');
    });

    it('calls a procedure with aggregation', async () => {
      await setup();
      const ws = await connect();

      // Insert order
      const orderResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'orders',
        data: { status: 'pending', total: 0 },
      });
      const orderId = (orderResp['data'] as Record<string, unknown>)['id'] as string;

      // Insert items
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { orderId, price: 100 },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { orderId, price: 50 },
      });

      // Register procedure
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'calc-total',
          input: { orderId: { type: 'string' } },
          steps: [
            { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
            { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
            { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { total: '{{ total }}', status: 'calculated' } },
          ],
        },
      });

      // Call
      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'calc-total',
        input: { orderId },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['success']).toBe(true);
      const results = data['results'] as Record<string, unknown>;
      expect(results['total']).toBe(150);

      // Verify the order was updated
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'orders',
        key: orderId,
      });
      const order = getResp['data'] as Record<string, unknown>;
      expect(order['total']).toBe(150);
      expect(order['status']).toBe('calculated');
    });

    it('calls a procedure with conditional logic', async () => {
      await setup();
      const ws = await connect();

      // Insert an order
      const orderResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'orders',
        data: { status: 'pending', total: 500 },
      });
      const orderId = (orderResp['data'] as Record<string, unknown>)['id'] as string;

      // Register procedure with if/then
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'check-high-value',
          input: { orderId: { type: 'string' } },
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
            {
              action: 'if',
              condition: { ref: 'order.total', operator: 'gte', value: 100 },
              then: [
                { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { status: 'high-value' } },
              ],
              else: [
                { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { status: 'normal' } },
              ],
            },
          ],
        },
      });

      // Call
      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'check-high-value',
        input: { orderId },
      });

      expect(resp['type']).toBe('result');

      // Verify the order was marked as high-value
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'orders',
        key: orderId,
      });
      const order = getResp['data'] as Record<string, unknown>;
      expect(order['status']).toBe('high-value');
    });

    it('calls a procedure with rules.emit', async () => {
      await setup();
      const ws = await connect();

      // Subscribe to events
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'order.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      // Register procedure that emits event
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'notify-order',
          input: { orderId: { type: 'string' } },
          steps: [
            { action: 'rules.emit', topic: 'order.processed', data: { orderId: '{{ input.orderId }}' } },
          ],
        },
      });

      // Set up push listener BEFORE calling procedure
      const pushPromise = waitForPush(ws, subscriptionId);

      // Call procedure
      await sendRequest(ws, {
        type: 'procedures.call',
        name: 'notify-order',
        input: { orderId: 'ord-123' },
      });

      // Verify event was emitted
      const push = await pushPromise;
      const pushData = push['data'] as Record<string, unknown>;
      expect(pushData['topic']).toBe('order.processed');
    });

    it('calls a procedure with transaction', async () => {
      await setup();
      const ws = await connect();

      // Register procedure with transaction
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'transactional',
          input: { status: { type: 'string' } },
          steps: [
            { action: 'store.insert', bucket: 'orders', data: { status: '{{ input.status }}', total: 0 }, as: 'inserted' },
          ],
          transaction: true,
        },
      });

      // Call
      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'transactional',
        input: { status: 'from-tx' },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['success']).toBe(true);
      const results = data['results'] as Record<string, unknown>;
      const inserted = results['inserted'] as Record<string, unknown>;
      expect(inserted['status']).toBe('from-tx');
    });

    it('returns NOT_FOUND for non-existent procedure', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'ghost-procedure',
        input: {},
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('returns VALIDATION_ERROR for invalid input', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'typed-proc',
          input: { count: { type: 'number', required: true } },
          steps: [
            { action: 'return', value: '{{ input.count }}' },
          ],
        },
      });

      // Call with missing required input
      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'typed-proc',
        input: {},
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns a custom value from a return step', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'return-value',
          input: { x: { type: 'number' } },
          steps: [
            { action: 'return', value: { computed: '{{ input.x }}' } },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'return-value',
        input: { x: 42 },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['success']).toBe(true);
      expect(data['result']).toEqual({ computed: 42 });
    });
  });

  // ── procedures.unregister ───────────────────────────────────────

  describe('procedures.unregister', () => {
    it('removes a registered procedure', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'removable',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'order' },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.unregister',
        name: 'removable',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('removable');
      expect(data['unregistered']).toBe(true);

      // Verify it's gone
      const callResp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'removable',
        input: {},
      });
      expect(callResp['type']).toBe('error');
      expect(callResp['code']).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND for non-existent procedure', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.unregister',
        name: 'ghost',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── procedures.update ───────────────────────────────────────────

  describe('procedures.update', () => {
    it('updates a procedure', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'updatable',
          description: 'Original',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'order' },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.update',
        name: 'updatable',
        updates: {
          description: 'Updated',
        },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('updatable');
      expect(data['updated']).toBe(true);

      // Verify via get
      const getResp = await sendRequest(ws, {
        type: 'procedures.get',
        name: 'updatable',
      });
      const procData = getResp['data'] as Record<string, unknown>;
      expect(procData['description']).toBe('Updated');
    });

    it('returns NOT_FOUND for non-existent procedure', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.update',
        name: 'ghost',
        updates: { description: 'x' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── procedures.get ──────────────────────────────────────────────

  describe('procedures.get', () => {
    it('returns full procedure detail', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'detail-proc',
          description: 'Detailed',
          input: { id: { type: 'string' } },
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.id }}', as: 'order' },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.get',
        name: 'detail-proc',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('detail-proc');
      expect(data['description']).toBe('Detailed');
      expect(data['input']).toEqual({ id: { type: 'string' } });
      expect(Array.isArray(data['steps'])).toBe(true);
    });

    it('returns NOT_FOUND for non-existent procedure', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.get',
        name: 'missing',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── procedures.list ─────────────────────────────────────────────

  describe('procedures.list', () => {
    it('returns summary list of all procedures', async () => {
      await setup();
      const ws = await connect();

      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'proc-a',
          description: 'Procedure A',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'order' },
          ],
        },
      });
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'proc-b',
          description: 'Procedure B',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'o1' },
            { action: 'store.get', bucket: 'orders', key: 'y', as: 'o2' },
          ],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'procedures.list',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const procedures = data['procedures'] as Array<Record<string, unknown>>;
      expect(procedures).toHaveLength(2);

      const names = procedures.map((p) => p['name']);
      expect(names).toContain('proc-a');
      expect(names).toContain('proc-b');

      // Check summary format
      for (const proc of procedures) {
        expect(proc['name']).toBeDefined();
        expect(proc['description']).toBeDefined();
        expect(typeof proc['stepsCount']).toBe('number');
        expect(proc['steps']).toBeUndefined();
      }
    });

    it('returns empty list when no procedures registered', async () => {
      await setup();
      const ws = await connect();

      const resp = await sendRequest(ws, {
        type: 'procedures.list',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['procedures']).toEqual([]);
    });
  });

  // ── Full CRUD cycle ─────────────────────────────────────────────

  describe('full CRUD cycle', () => {
    it('register → get → update → list → call → unregister', async () => {
      await setup();
      const ws = await connect();

      // Register
      const regResp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'lifecycle-proc',
          description: 'Lifecycle test',
          input: { orderId: { type: 'string' } },
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
          ],
        },
      });
      expect(regResp['type']).toBe('result');

      // Get
      const getResp = await sendRequest(ws, {
        type: 'procedures.get',
        name: 'lifecycle-proc',
      });
      expect(getResp['type']).toBe('result');
      expect((getResp['data'] as Record<string, unknown>)['name']).toBe('lifecycle-proc');

      // Update
      const updateResp = await sendRequest(ws, {
        type: 'procedures.update',
        name: 'lifecycle-proc',
        updates: { description: 'Updated lifecycle' },
      });
      expect(updateResp['type']).toBe('result');

      // List
      const listResp = await sendRequest(ws, {
        type: 'procedures.list',
      });
      expect(listResp['type']).toBe('result');
      expect(
        ((listResp['data'] as Record<string, unknown>)['procedures'] as unknown[]).length,
      ).toBe(1);

      // Insert data and call
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'orders',
        data: { status: 'active', total: 100 },
      });
      const orderId = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      const callResp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'lifecycle-proc',
        input: { orderId },
      });
      expect(callResp['type']).toBe('result');
      expect((callResp['data'] as Record<string, unknown>)['success']).toBe(true);

      // Unregister
      const unregResp = await sendRequest(ws, {
        type: 'procedures.unregister',
        name: 'lifecycle-proc',
      });
      expect(unregResp['type']).toBe('result');

      // List again (should be empty)
      const listResp2 = await sendRequest(ws, {
        type: 'procedures.list',
      });
      expect(
        ((listResp2['data'] as Record<string, unknown>)['procedures'] as unknown[]).length,
      ).toBe(0);
    });
  });

  // ── End-to-end: calculate invoice ───────────────────────────────

  describe('end-to-end: calculate invoice', () => {
    it('calculates total from items and updates order', async () => {
      await setup();
      const ws = await connect();

      // Insert order
      const orderResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'orders',
        data: { status: 'pending', total: 0 },
      });
      const orderId = (orderResp['data'] as Record<string, unknown>)['id'] as string;

      // Insert items
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { orderId, price: 100 },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { orderId, price: 50.50 },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { orderId, price: 25 },
      });

      // Register the invoice procedure
      await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'calculate-invoice',
          description: 'Calculate order total from items',
          input: { orderId: { type: 'string', required: true } },
          steps: [
            { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
            { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
            { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
            { action: 'store.update', bucket: 'orders', key: '{{ input.orderId }}', data: { total: '{{ total }}', status: 'calculated' } },
          ],
          transaction: true,
        },
      });

      // Call the procedure
      const callResp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'calculate-invoice',
        input: { orderId },
      });

      expect(callResp['type']).toBe('result');
      const data = callResp['data'] as Record<string, unknown>;
      expect(data['success']).toBe(true);
      const results = data['results'] as Record<string, unknown>;
      expect(results['total']).toBe(175.50);
      const items = results['items'] as unknown[];
      expect(items).toHaveLength(3);

      // Verify the order state
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'orders',
        key: orderId,
      });
      const updatedOrder = getResp['data'] as Record<string, unknown>;
      expect(updatedOrder['total']).toBe(175.50);
      expect(updatedOrder['status']).toBe('calculated');
    });
  });

  // ── Tier enforcement ────────────────────────────────────────────

  describe('tier enforcement', () => {
    it('writer cannot register procedure', async () => {
      await setup({ withAuth: true });
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'forbidden',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'o' },
          ],
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot register procedure', async () => {
      await setup({ withAuth: true });
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'forbidden',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'o' },
          ],
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer can call a procedure', async () => {
      await setup({ withAuth: true });

      // Admin registers procedure
      const adminWs = await connect('admin');
      await sendRequest(adminWs, {
        type: 'procedures.register',
        procedure: {
          name: 'callable',
          steps: [
            { action: 'store.insert', bucket: 'orders', data: { status: 'created', total: 0 }, as: 'order' },
          ],
        },
      });

      // Writer calls it
      const writerWs = await connect('writer');
      const resp = await sendRequest(writerWs, {
        type: 'procedures.call',
        name: 'callable',
        input: {},
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['success']).toBe(true);
    });

    it('reader cannot call a procedure', async () => {
      await setup({ withAuth: true });

      // Admin registers procedure
      const adminWs = await connect('admin');
      await sendRequest(adminWs, {
        type: 'procedures.register',
        procedure: {
          name: 'not-for-readers',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'o' },
          ],
        },
      });

      // Reader tries to call it
      const readerWs = await connect('reader');
      const resp = await sendRequest(readerWs, {
        type: 'procedures.call',
        name: 'not-for-readers',
        input: {},
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader can get a procedure', async () => {
      await setup({ withAuth: true });

      // Admin registers procedure
      const adminWs = await connect('admin');
      await sendRequest(adminWs, {
        type: 'procedures.register',
        procedure: {
          name: 'viewable',
          description: 'Viewable by readers',
          steps: [
            { action: 'store.get', bucket: 'orders', key: 'x', as: 'o' },
          ],
        },
      });

      // Reader can get it
      const readerWs = await connect('reader');
      const resp = await sendRequest(readerWs, {
        type: 'procedures.get',
        name: 'viewable',
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['name']).toBe('viewable');
    });

    it('writer cannot unregister procedure', async () => {
      await setup({ withAuth: true });
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'procedures.unregister',
        name: 'any',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot list procedures', async () => {
      await setup({ withAuth: true });
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'procedures.list',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('admin can perform all procedure operations', async () => {
      await setup({ withAuth: true });
      const ws = await connect('admin');

      // Register
      const regResp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'admin-proc',
          steps: [
            { action: 'store.insert', bucket: 'orders', data: { status: 'admin', total: 0 }, as: 'order' },
          ],
        },
      });
      expect(regResp['type']).toBe('result');

      // List
      const listResp = await sendRequest(ws, {
        type: 'procedures.list',
      });
      expect(listResp['type']).toBe('result');

      // Get
      const getResp = await sendRequest(ws, {
        type: 'procedures.get',
        name: 'admin-proc',
      });
      expect(getResp['type']).toBe('result');

      // Call
      const callResp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'admin-proc',
        input: {},
      });
      expect(callResp['type']).toBe('result');

      // Update
      const updateResp = await sendRequest(ws, {
        type: 'procedures.update',
        name: 'admin-proc',
        updates: { description: 'Updated' },
      });
      expect(updateResp['type']).toBe('result');

      // Unregister
      const unregResp = await sendRequest(ws, {
        type: 'procedures.unregister',
        name: 'admin-proc',
      });
      expect(unregResp['type']).toBe('result');
    });
  });

  // ── No auth mode ───────────────────────────────────────────────

  describe('no auth mode', () => {
    it('procedures work without auth configured', async () => {
      await setup();
      const ws = await connect();

      const regResp = await sendRequest(ws, {
        type: 'procedures.register',
        procedure: {
          name: 'open-proc',
          steps: [
            { action: 'store.insert', bucket: 'orders', data: { status: 'open', total: 0 }, as: 'order' },
          ],
        },
      });
      expect(regResp['type']).toBe('result');

      const callResp = await sendRequest(ws, {
        type: 'procedures.call',
        name: 'open-proc',
        input: {},
      });
      expect(callResp['type']).toBe('result');
      expect((callResp['data'] as Record<string, unknown>)['success']).toBe(true);
    });
  });
});
