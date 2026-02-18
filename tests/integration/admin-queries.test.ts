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

async function login(
  ws: WebSocket,
  token: string,
): Promise<Record<string, unknown>> {
  return sendRequest(ws, { type: 'auth.login', token });
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

describe('Integration: Admin Query Operations', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    clients.length = 0;

    if (server?.isRunning) await server.stop();
    server = undefined;

    if (store) await store.stop();
    store = undefined;
  });

  async function setup(): Promise<void> {
    store = await Store.start({ name: `admin-query-test-${++storeCounter}` });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        role: { type: 'string' },
        active: { type: 'boolean' },
        age: { type: 'number' },
      },
    });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth,
    });
  }

  async function connect(token: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const resp = await login(ws, token);
    expect(resp['type']).toBe('result');
    return ws;
  }

  // ── store.defineQuery ───────────────────────────────────────────

  describe('store.defineQuery', () => {
    it('defines a declarative query', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'all-users',
        config: { bucket: 'users' },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('all-users');
      expect(data['defined']).toBe(true);
    });

    it('defined query can be subscribed to', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'active-users',
        config: {
          bucket: 'users',
          filter: { active: true },
          sort: { name: 'asc' },
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'active-users',
      });

      expect(subResp['type']).toBe('result');
      const subData = subResp['data'] as Record<string, unknown>;
      expect(subData['subscriptionId']).toBeDefined();
      expect(subData['data']).toEqual([]);
    });

    it('defined query returns initial data on subscribe', async () => {
      await setup();
      const ws = await connect('admin');

      // Insert data first
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', role: 'admin', active: true },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob', role: 'user', active: false },
      });

      // Define query for active users
      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'active-only',
        config: {
          bucket: 'users',
          filter: { active: true },
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'active-only',
      });

      expect(subResp['type']).toBe('result');
      const subData = subResp['data'] as Record<string, unknown>;
      const results = subData['data'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Alice');
    });

    it('reactive push after insert', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'all-users-reactive',
        config: { bucket: 'users' },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'all-users-reactive',
      });
      const subData = subResp['data'] as Record<string, unknown>;
      const subscriptionId = subData['subscriptionId'] as string;

      // Set up push listener BEFORE insert
      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Charlie', role: 'user', active: true },
      });

      const push = await pushPromise;
      expect(push['type']).toBe('push');
      const pushData = push['data'] as Array<Record<string, unknown>>;
      expect(pushData).toHaveLength(1);
      expect(pushData[0]!['name']).toBe('Charlie');
    });

    it('query with sort and limit', async () => {
      await setup();
      const ws = await connect('admin');

      // Insert multiple users
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Charlie', role: 'user', active: true, age: 30 },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', role: 'admin', active: true, age: 25 },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob', role: 'user', active: true, age: 35 },
      });

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'top-2-by-name',
        config: {
          bucket: 'users',
          sort: { name: 'asc' },
          limit: 2,
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'top-2-by-name',
      });

      const subData = subResp['data'] as Record<string, unknown>;
      const results = subData['data'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(2);
      expect(results[0]!['name']).toBe('Alice');
      expect(results[1]!['name']).toBe('Bob');
    });

    it('query with fields projection', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', role: 'admin', active: true, age: 25 },
      });

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'names-only',
        config: {
          bucket: 'users',
          fields: ['name', 'role'],
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'names-only',
      });

      const subData = subResp['data'] as Record<string, unknown>;
      const results = subData['data'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Alice');
      expect(results[0]!['role']).toBe('admin');
      expect(results[0]!['age']).toBeUndefined();
      expect(results[0]!['active']).toBeUndefined();
    });

    it('query with aggregate count', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', active: true },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob', active: true },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Charlie', active: false },
      });

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'active-count',
        config: {
          bucket: 'users',
          filter: { active: true },
          aggregate: { function: 'count' },
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'active-count',
      });

      const subData = subResp['data'] as Record<string, unknown>;
      expect(subData['data']).toBe(2);
    });

    it('parametrized query', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', role: 'admin', active: true },
      });
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob', role: 'user', active: true },
      });

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'users-by-role',
        config: {
          bucket: 'users',
          filter: { role: '{{ params.role }}' },
        },
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'users-by-role',
        params: { role: 'admin' },
      });

      const subData = subResp['data'] as Record<string, unknown>;
      const results = subData['data'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Alice');
    });

    it('returns ALREADY_EXISTS for duplicate query name', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'dup-query',
        config: { bucket: 'users' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'dup-query',
        config: { bucket: 'users' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('returns BUCKET_NOT_DEFINED for non-existent bucket', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'ghost-query',
        config: { bucket: 'nonexistent' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });

    it('returns VALIDATION_ERROR for missing name', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        config: { bucket: 'users' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR for missing config', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'bad-query',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.undefineQuery ─────────────────────────────────────────

  describe('store.undefineQuery', () => {
    it('removes an existing query', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'temp-query',
        config: { bucket: 'users' },
      });

      const resp = await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'temp-query',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('temp-query');
      expect(data['undefined']).toBe(true);
    });

    it('subscribe fails after undefine', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'doomed-query',
        config: { bucket: 'users' },
      });

      await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'doomed-query',
      });

      const subResp = await sendRequest(ws, {
        type: 'store.subscribe',
        query: 'doomed-query',
      });

      expect(subResp['type']).toBe('error');
      expect(subResp['code']).toBe('QUERY_NOT_DEFINED');
    });

    it('returns QUERY_NOT_DEFINED for non-existent query', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'no-such-query',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('QUERY_NOT_DEFINED');
    });
  });

  // ── store.listQueries ──────────────────────────────────────────

  describe('store.listQueries', () => {
    it('returns empty list when no queries defined', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.listQueries',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const queries = data['queries'] as Array<Record<string, unknown>>;
      expect(queries).toEqual([]);
    });

    it('returns defined queries', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'q1',
        config: { bucket: 'users', filter: { active: true } },
      });
      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'q2',
        config: { bucket: 'users', sort: { name: 'asc' }, limit: 5 },
      });

      const resp = await sendRequest(ws, {
        type: 'store.listQueries',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const queries = data['queries'] as Array<Record<string, unknown>>;
      expect(queries).toHaveLength(2);

      const names = queries.map((q) => q['name']);
      expect(names).toContain('q1');
      expect(names).toContain('q2');

      const q1 = queries.find((q) => q['name'] === 'q1')!;
      expect(q1['type']).toBe('declarative');
      expect(q1['config']).toBeDefined();
      expect((q1['config'] as Record<string, unknown>)['bucket']).toBe('users');
    });

    it('reflects removals', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'to-remove',
        config: { bucket: 'users' },
      });

      await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'to-remove',
      });

      const resp = await sendRequest(ws, {
        type: 'store.listQueries',
      });

      const data = resp['data'] as Record<string, unknown>;
      const queries = data['queries'] as Array<Record<string, unknown>>;
      expect(queries).toEqual([]);
    });
  });

  // ── Tier enforcement ────────────────────────────────────────────

  describe('tier enforcement', () => {
    it('writer cannot defineQuery', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'forbidden',
        config: { bucket: 'users' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot defineQuery', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'forbidden',
        config: { bucket: 'users' },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot undefineQuery', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'anything',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot listQueries', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.listQueries',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── No auth mode ───────────────────────────────────────────────

  describe('no auth mode', () => {
    it('query operations work without auth configured', async () => {
      store = await Store.start({ name: `admin-query-noauth-${++storeCounter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'string' },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // defineQuery
      const defResp = await sendRequest(ws, {
        type: 'store.defineQuery',
        name: 'all-items',
        config: { bucket: 'items' },
      });
      expect(defResp['type']).toBe('result');
      expect((defResp['data'] as Record<string, unknown>)['defined']).toBe(true);

      // listQueries
      const listResp = await sendRequest(ws, {
        type: 'store.listQueries',
      });
      expect(listResp['type']).toBe('result');
      const queries = (listResp['data'] as Record<string, unknown>)['queries'] as unknown[];
      expect(queries).toHaveLength(1);

      // undefineQuery
      const undefResp = await sendRequest(ws, {
        type: 'store.undefineQuery',
        name: 'all-items',
      });
      expect(undefResp['type']).toBe('result');
      expect((undefResp['data'] as Record<string, unknown>)['undefined']).toBe(true);
    });
  });
});
