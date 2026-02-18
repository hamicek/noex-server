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

describe('Integration: Admin Store Operations', () => {
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
    store = await Store.start({ name: `admin-store-test-${++storeCounter}` });
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

  // ── store.defineBucket ──────────────────────────────────────────

  describe('store.defineBucket', () => {
    it('creates a bucket and allows CRUD', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'users',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            name: { type: 'string', required: true },
            email: { type: 'string' },
          },
          indexes: ['email'],
        },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('users');
      expect(data['created']).toBe(true);

      // Verify CRUD works on the new bucket
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', email: 'alice@test.com' },
      });
      expect(insertResp['type']).toBe('result');
      const inserted = insertResp['data'] as Record<string, unknown>;
      expect(inserted['name']).toBe('Alice');
      expect(typeof inserted['id']).toBe('string');
    });

    it('returns ALREADY_EXISTS for duplicate bucket', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'posts',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            title: { type: 'string', required: true },
          },
        },
      });

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'posts',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            title: { type: 'string', required: true },
          },
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('returns VALIDATION_ERROR for missing name', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        config: { key: 'id', schema: {} },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR for missing config', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'test',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── store.dropBucket ────────────────────────────────────────────

  describe('store.dropBucket', () => {
    it('drops an existing bucket', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'temp',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            value: { type: 'string' },
          },
        },
      });

      const resp = await sendRequest(ws, {
        type: 'store.dropBucket',
        name: 'temp',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('temp');
      expect(data['dropped']).toBe(true);
    });

    it('cannot insert into a dropped bucket', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'ephemeral',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            data: { type: 'string' },
          },
        },
      });

      await sendRequest(ws, {
        type: 'store.dropBucket',
        name: 'ephemeral',
      });

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'ephemeral',
        data: { data: 'test' },
      });

      expect(insertResp['type']).toBe('error');
      expect(insertResp['code']).toBe('BUCKET_NOT_DEFINED');
    });

    it('returns BUCKET_NOT_DEFINED for non-existent bucket', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.dropBucket',
        name: 'no-such-bucket',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });
  });

  // ── store.updateBucket ──────────────────────────────────────────

  describe('store.updateBucket', () => {
    it('adds new fields to an existing bucket', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'profiles',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            name: { type: 'string', required: true },
          },
        },
      });

      // Insert a record before update
      const insertBefore = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'profiles',
        data: { name: 'Alice' },
      });
      expect(insertBefore['type']).toBe('result');

      // Update schema
      const updateResp = await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'profiles',
        updates: {
          addFields: {
            phone: { type: 'string' },
            age: { type: 'number', min: 0 },
          },
        },
      });

      expect(updateResp['type']).toBe('result');
      const data = updateResp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('profiles');
      expect(data['updated']).toBe(true);

      // Verify new field works in insert
      const insertAfter = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'profiles',
        data: { name: 'Bob', phone: '+420123456789', age: 30 },
      });
      expect(insertAfter['type']).toBe('result');
      const inserted = insertAfter['data'] as Record<string, unknown>;
      expect(inserted['phone']).toBe('+420123456789');
      expect(inserted['age']).toBe(30);
    });

    it('preserves existing data after update', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'items',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            title: { type: 'string', required: true },
          },
        },
      });

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { title: 'Original' },
      });
      const key = (insertResp['data'] as Record<string, unknown>)['id'] as string;

      // Update schema
      await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'items',
        updates: {
          addFields: { description: { type: 'string' } },
        },
      });

      // Verify original data is still there
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'items',
        key,
      });
      expect(getResp['type']).toBe('result');
      const record = getResp['data'] as Record<string, unknown>;
      expect(record['title']).toBe('Original');
    });

    it('returns BUCKET_NOT_DEFINED for non-existent bucket', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'nonexistent',
        updates: { addFields: { x: { type: 'string' } } },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });

    it('adds indexes', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'indexed',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            name: { type: 'string', required: true },
            email: { type: 'string' },
          },
        },
      });

      await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'indexed',
        updates: { addIndexes: ['email'] },
      });

      // Insert some data and query by indexed field
      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'indexed',
        data: { name: 'Alice', email: 'alice@test.com' },
      });

      const whereResp = await sendRequest(ws, {
        type: 'store.where',
        bucket: 'indexed',
        filter: { email: 'alice@test.com' },
      });
      expect(whereResp['type']).toBe('result');
      const results = whereResp['data'] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]!['name']).toBe('Alice');
    });
  });

  // ── store.getBucketSchema ───────────────────────────────────────

  describe('store.getBucketSchema', () => {
    it('returns bucket config', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'docs',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            content: { type: 'string', required: true },
          },
          indexes: ['content'],
        },
      });

      const resp = await sendRequest(ws, {
        type: 'store.getBucketSchema',
        name: 'docs',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['name']).toBe('docs');

      const config = data['config'] as Record<string, unknown>;
      expect(config['key']).toBe('id');

      const schema = config['schema'] as Record<string, unknown>;
      expect(schema['id']).toBeDefined();
      expect(schema['content']).toBeDefined();

      const indexes = config['indexes'] as string[];
      expect(indexes).toContain('content');
    });

    it('reflects schema changes after updateBucket', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'evolving',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            name: { type: 'string' },
          },
        },
      });

      await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'evolving',
        updates: {
          addFields: { email: { type: 'string', format: 'email' } },
        },
      });

      const resp = await sendRequest(ws, {
        type: 'store.getBucketSchema',
        name: 'evolving',
      });

      expect(resp['type']).toBe('result');
      const config = (resp['data'] as Record<string, unknown>)['config'] as Record<string, unknown>;
      const schema = config['schema'] as Record<string, unknown>;
      expect(schema['email']).toBeDefined();
      expect((schema['email'] as Record<string, unknown>)['format']).toBe('email');
    });

    it('returns BUCKET_NOT_DEFINED for non-existent bucket', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'store.getBucketSchema',
        name: 'ghost',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
    });
  });

  // ── Tier enforcement ────────────────────────────────────────────

  describe('tier enforcement', () => {
    it('writer cannot defineBucket', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'forbidden',
        config: {
          key: 'id',
          schema: { id: { type: 'string', generated: 'uuid' } },
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot defineBucket', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'forbidden',
        config: {
          key: 'id',
          schema: { id: { type: 'string', generated: 'uuid' } },
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot dropBucket', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.dropBucket',
        name: 'anything',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot updateBucket', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.updateBucket',
        name: 'anything',
        updates: { addFields: { x: { type: 'string' } } },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot getBucketSchema', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'store.getBucketSchema',
        name: 'anything',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot dropBucket', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'store.dropBucket',
        name: 'anything',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── No auth mode ───────────────────────────────────────────────

  describe('no auth mode', () => {
    it('admin operations work without auth configured', async () => {
      store = await Store.start({ name: `admin-store-noauth-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'open',
        config: {
          key: 'id',
          schema: {
            id: { type: 'string', generated: 'uuid' },
            value: { type: 'string' },
          },
        },
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['created']).toBe(true);
    });
  });
});
