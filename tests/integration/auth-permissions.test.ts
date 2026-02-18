import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';
import type { AuthConfig, AuthSession, PermissionConfig } from '../../src/config.js';

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
  editor: { userId: 'editor-1', roles: ['writer', 'editor'] },
  viewer: { userId: 'viewer-1', roles: ['reader', 'viewer'] },
};

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Declarative Permission Rules', () => {
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

  async function setup(permissions: PermissionConfig): Promise<void> {
    store = await Store.start({ name: `perms-test-${++storeCounter}` });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    await store.defineBucket('posts', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        title: { type: 'string', required: true },
      },
    });
    await store.defineBucket('secrets', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        value: { type: 'string', required: true },
      },
    });

    const auth: AuthConfig = {
      validate: async (token) => sessions[token] ?? null,
      permissions,
    };

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

  // ── Bucket-restricted rules ─────────────────────────────────

  describe('bucket-restricted rules', () => {
    const permissions: PermissionConfig = {
      default: 'deny',
      rules: [
        { role: 'admin', allow: '*' },
        { role: 'editor', allow: ['store.insert', 'store.update', 'store.delete', 'store.get', 'store.all', 'store.where'], buckets: ['users', 'posts'] },
        { role: 'viewer', allow: ['store.get', 'store.all', 'store.where'], buckets: ['users', 'posts'] },
      ],
    };

    it('editor can insert into allowed bucket', async () => {
      await setup(permissions);
      const ws = await connect('editor');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });
      expect(resp['type']).toBe('result');
    });

    it('editor cannot insert into restricted bucket', async () => {
      await setup(permissions);
      const ws = await connect('editor');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'secrets',
        data: { value: 'top-secret' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('viewer can read from allowed bucket', async () => {
      await setup(permissions);
      const ws = await connect('viewer');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('result');
    });

    it('viewer cannot read from restricted bucket', async () => {
      await setup(permissions);
      const ws = await connect('viewer');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'secrets',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('viewer cannot write even to allowed bucket', async () => {
      await setup(permissions);
      const ws = await connect('viewer');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('admin can access everything with wildcard', async () => {
      await setup(permissions);
      const ws = await connect('admin');

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'secrets',
        data: { value: 'classified' },
      });
      expect(insertResp['type']).toBe('result');

      const statsResp = await sendRequest(ws, { type: 'server.stats' });
      expect(statsResp['type']).toBe('result');
    });
  });

  // ── Default behavior ────────────────────────────────────────

  describe('default behavior', () => {
    it('default deny blocks operations without matching rules', async () => {
      await setup({
        default: 'deny',
        rules: [
          { role: 'admin', allow: '*' },
          { role: 'editor', allow: 'store.get', buckets: ['users'] },
        ],
      });
      const ws = await connect('editor');

      // Allowed — rule matches
      const getResp = await sendRequest(ws, {
        type: 'store.get',
        bucket: 'users',
        key: 'nonexistent',
      });
      expect(getResp['type']).toBe('result');

      // Denied — no matching rule, default deny
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });
      expect(insertResp['type']).toBe('error');
      expect(insertResp['code']).toBe('FORBIDDEN');
    });

    it('default allow permits operations without matching rules', async () => {
      await setup({
        default: 'allow',
        rules: [],
      });
      const ws = await connect('editor');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Custom check override ───────────────────────────────────

  describe('custom check override', () => {
    it('check returning true allows access regardless of rules', async () => {
      await setup({
        default: 'deny',
        rules: [],
        check: () => true,
      });
      const ws = await connect('editor');

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'secrets',
        data: { value: 'allowed-by-check' },
      });
      expect(resp['type']).toBe('result');
    });

    it('check returning false denies access regardless of rules', async () => {
      await setup({
        default: 'allow',
        rules: [{ role: 'editor', allow: '*' }],
        check: () => false,
      });
      const ws = await connect('editor');

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('check returning undefined falls through to rules', async () => {
      await setup({
        default: 'deny',
        rules: [
          { role: 'editor', allow: 'store.insert', buckets: ['users'] },
        ],
        check: () => undefined,
      });
      const ws = await connect('editor');

      // Allowed — rule matches after check fallthrough
      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Charlie' },
      });
      expect(insertResp['type']).toBe('result');

      // Denied — no rule matches, default deny
      const deleteResp = await sendRequest(ws, {
        type: 'store.delete',
        bucket: 'users',
        key: 'nonexistent',
      });
      expect(deleteResp['type']).toBe('error');
      expect(deleteResp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Combined with tiers ─────────────────────────────────────

  describe('combined with tiers', () => {
    it('tier check runs before permissions — reader blocked from write even if rule allows', async () => {
      await setup({
        default: 'allow',
        rules: [{ role: 'viewer', allow: '*' }],
      });
      const ws = await connect('viewer');

      // Tier check blocks write for 'reader' role (built-in)
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Dave' },
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
      expect(resp['message']).toContain('requires write');
    });
  });

  // ── Wildcard patterns ───────────────────────────────────────

  describe('wildcard patterns', () => {
    it('store.* matches all store operations', async () => {
      await setup({
        default: 'deny',
        rules: [{ role: 'editor', allow: 'store.*', buckets: ['users'] }],
      });
      const ws = await connect('editor');

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Eve' },
      });
      expect(insertResp['type']).toBe('result');

      const allResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(allResp['type']).toBe('result');

      // But not posts
      const postsResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'posts',
      });
      expect(postsResp['type']).toBe('error');
      expect(postsResp['code']).toBe('FORBIDDEN');
    });
  });

  // ── Backward compatibility ──────────────────────────────────

  describe('backward compatibility', () => {
    it('old-style check function still works', async () => {
      await setup({
        check: (session, _op, resource) => {
          // Only allow access to 'users' bucket
          return resource === 'users';
        },
      });
      const ws = await connect('editor');

      const usersResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(usersResp['type']).toBe('result');

      const secretsResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'secrets',
      });
      expect(secretsResp['type']).toBe('error');
      expect(secretsResp['code']).toBe('FORBIDDEN');
    });
  });
});
