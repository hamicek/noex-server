import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';
import type { AuthConfig, AuthSession, AuditConfig } from '../../src/config.js';

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

describe('Integration: Audit Log', () => {
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

  async function setup(audit?: AuditConfig): Promise<void> {
    store = await Store.start({ name: `audit-test-${++storeCounter}` });
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth,
      audit: audit ?? {},
    });
  }

  async function connect(token: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const resp = await login(ws, token);
    expect(resp['type']).toBe('result');
    return ws;
  }

  // ── Admin operations generate audit entries ───────────────────

  describe('admin operations are audited', () => {
    it('server.stats generates an audit entry', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, { type: 'server.stats' });

      const resp = await sendRequest(ws, { type: 'audit.query' });
      expect(resp['type']).toBe('result');
      const data = resp['data'] as { entries: unknown[] };
      expect(data.entries.length).toBeGreaterThanOrEqual(1);

      const entries = data.entries as Array<Record<string, unknown>>;
      const statsEntry = entries.find((e) => e['operation'] === 'server.stats');
      expect(statsEntry).toBeDefined();
      expect(statsEntry!['result']).toBe('success');
      expect(statsEntry!['userId']).toBe('admin-1');
    });

    it('server.connections generates an audit entry', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, { type: 'server.connections' });

      const resp = await sendRequest(ws, { type: 'audit.query' });
      const data = resp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;
      const connEntry = entries.find(
        (e) => e['operation'] === 'server.connections',
      );
      expect(connEntry).toBeDefined();
      expect(connEntry!['result']).toBe('success');
    });
  });

  // ── Write operations are NOT audited by default ───────────────

  describe('write operations are not audited by default', () => {
    it('store.insert does not generate audit entry', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });

      const resp = await sendRequest(ws, { type: 'audit.query' });
      const data = resp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;
      const insertEntry = entries.find(
        (e) => e['operation'] === 'store.insert',
      );
      expect(insertEntry).toBeUndefined();
    });
  });

  // ── Custom tiers config ───────────────────────────────────────

  describe('custom tiers config', () => {
    it('logs write operations when configured', async () => {
      await setup({ tiers: ['admin', 'write'] });
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });

      const resp = await sendRequest(ws, { type: 'audit.query' });
      const data = resp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;
      const insertEntry = entries.find(
        (e) => e['operation'] === 'store.insert',
      );
      expect(insertEntry).toBeDefined();
      expect(insertEntry!['result']).toBe('success');
      expect(insertEntry!['resource']).toBe('users');
    });
  });

  // ── Failed operations are audited ─────────────────────────────

  describe('failed operations are audited', () => {
    it('forbidden operation generates error audit entry', async () => {
      await setup();
      const ws = await connect('writer');

      // writer can't access server.stats (admin tier)
      const resp = await sendRequest(ws, { type: 'server.stats' });
      expect(resp['type']).toBe('error');

      // Login as admin to query audit
      const adminWs = await connect('admin');
      const auditResp = await sendRequest(adminWs, { type: 'audit.query' });
      const data = auditResp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;

      const errorEntry = entries.find(
        (e) =>
          e['operation'] === 'server.stats' && e['result'] === 'error',
      );
      expect(errorEntry).toBeDefined();
      expect(errorEntry!['userId']).toBe('writer-1');
      expect(typeof errorEntry!['error']).toBe('string');
    });
  });

  // ── audit.query filtering ─────────────────────────────────────

  describe('audit.query filtering', () => {
    it('filters by userId', async () => {
      await setup();
      const adminWs = await connect('admin');

      // Generate some entries
      await sendRequest(adminWs, { type: 'server.stats' });
      await sendRequest(adminWs, { type: 'server.connections' });

      const resp = await sendRequest(adminWs, {
        type: 'audit.query',
        userId: 'admin-1',
      });
      const data = resp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries.every((e) => e['userId'] === 'admin-1')).toBe(true);
    });

    it('filters by operation', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, { type: 'server.stats' });
      await sendRequest(ws, { type: 'server.connections' });
      await sendRequest(ws, { type: 'server.stats' });

      const resp = await sendRequest(ws, {
        type: 'audit.query',
        operation: 'server.stats',
      });
      const data = resp['data'] as { entries: unknown[] };
      const entries = data.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries.every((e) => e['operation'] === 'server.stats')).toBe(
        true,
      );
    });

    it('respects limit', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, { type: 'server.stats' });
      await sendRequest(ws, { type: 'server.stats' });
      await sendRequest(ws, { type: 'server.stats' });

      const resp = await sendRequest(ws, {
        type: 'audit.query',
        limit: 2,
      });
      const data = resp['data'] as { entries: unknown[] };
      expect(data.entries).toHaveLength(2);
    });
  });

  // ── audit.query requires admin ─────────────────────────────────

  describe('audit.query access control', () => {
    it('writer cannot query audit log', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, { type: 'audit.query' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot query audit log', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, { type: 'audit.query' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── audit.query validation ─────────────────────────────────────

  describe('audit.query validation', () => {
    it('rejects invalid limit', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'audit.query',
        limit: -1,
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects non-number from', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'audit.query',
        from: 'yesterday',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── No audit config → audit.query fails ──────────────────────

  describe('no audit config', () => {
    it('audit.query returns error when audit not configured', async () => {
      store = await Store.start({ name: `audit-noconfig-${++storeCounter}` });
      await store.defineBucket('users', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        auth,
      });
      const ws = await connect('admin');

      const resp = await sendRequest(ws, { type: 'audit.query' });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });
  });

  // ── onEntry callback ──────────────────────────────────────────

  describe('onEntry callback', () => {
    it('calls onEntry for each audited operation', async () => {
      const received: unknown[] = [];
      await setup({
        onEntry: (e) => received.push(e),
      });
      const ws = await connect('admin');

      await sendRequest(ws, { type: 'server.stats' });

      // Give the callback a moment
      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThanOrEqual(1);
      const e = received.find(
        (x) => (x as Record<string, unknown>)['operation'] === 'server.stats',
      ) as Record<string, unknown>;
      expect(e).toBeDefined();
      expect(e['result']).toBe('success');
    });
  });
});
