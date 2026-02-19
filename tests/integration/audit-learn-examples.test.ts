/**
 * Tests for code examples in docs/learn/08-authentication/04-audit-logging.md
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';
import type { AuthConfig, AuthSession, AuditConfig, AuditEntry } from '../../src/config.js';

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

// ── Tests ────────────────────────────────────────────────────────

describe('Learn: Audit Logging examples', () => {
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

  // ── "Server Setup" example — admin + write tiers ────────────

  it('logs admin and write operations when tiers configured', async () => {
    store = await Store.start({ name: `audit-learn-${++storeCounter}` });
    store.defineBucket('tasks', {
      key: 'id',
      schema: {
        id:    { type: 'string', generated: 'uuid' },
        title: { type: 'string', required: true },
        done:  { type: 'boolean', default: false },
      },
    });

    const auth: AuthConfig = {
      validate: async (token): Promise<AuthSession | null> => {
        if (token === 'admin-token') {
          return { userId: 'admin-1', roles: ['admin'] };
        }
        if (token === 'user-token') {
          return { userId: 'user-1', roles: ['writer'] };
        }
        return null;
      },
    };

    server = await NoexServer.start({
      store,
      auth,
      audit: { tiers: ['admin', 'write'] },
      port: 0,
      host: '127.0.0.1',
    });

    const { ws } = await connectClient(server.port);
    clients.push(ws);

    // Login as admin
    const loginResp = await sendRequest(ws, { type: 'auth.login', token: 'admin-token' });
    expect(loginResp['type']).toBe('result');

    // Insert a task (write tier)
    const insertResp = await sendRequest(ws, {
      type: 'store.insert',
      bucket: 'tasks',
      data: { title: 'Write docs' },
    });
    expect(insertResp['type']).toBe('result');

    // Query audit — should have the insert
    const auditResp = await sendRequest(ws, {
      type: 'audit.query',
      operation: 'store.insert',
    });
    expect(auditResp['type']).toBe('result');

    const data = auditResp['data'] as { entries: Array<Record<string, unknown>> };
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
    expect(data.entries[0]['operation']).toBe('store.insert');
    expect(data.entries[0]['resource']).toBe('tasks');
    expect(data.entries[0]['result']).toBe('success');
    expect(data.entries[0]['userId']).toBe('admin-1');
  });

  // ── Filtering example ───────────────────────────────────────

  it('supports all filter fields on audit.query', async () => {
    store = await Store.start({ name: `audit-learn-${++storeCounter}` });
    store.defineBucket('tasks', {
      key: 'id',
      schema: {
        id:    { type: 'string', generated: 'uuid' },
        title: { type: 'string', required: true },
      },
    });

    const auth: AuthConfig = {
      validate: async (token): Promise<AuthSession | null> => {
        if (token === 'admin-token') {
          return { userId: 'admin-1', roles: ['admin'] };
        }
        return null;
      },
    };

    server = await NoexServer.start({
      store,
      auth,
      audit: { tiers: ['admin', 'write'] },
      port: 0,
      host: '127.0.0.1',
    });

    const { ws } = await connectClient(server.port);
    clients.push(ws);

    await sendRequest(ws, { type: 'auth.login', token: 'admin-token' });

    // Generate some entries
    await sendRequest(ws, { type: 'store.insert', bucket: 'tasks', data: { title: 'A' } });
    await sendRequest(ws, { type: 'store.insert', bucket: 'tasks', data: { title: 'B' } });
    await sendRequest(ws, { type: 'server.stats' });

    // Filter by operation + limit
    const resp = await sendRequest(ws, {
      type: 'audit.query',
      operation: 'store.insert',
      limit: 1,
    });
    expect(resp['type']).toBe('result');

    const data = resp['data'] as { entries: Array<Record<string, unknown>> };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]['operation']).toBe('store.insert');
  });

  // ── Access control — non-admin cannot query ─────────────────

  it('denies audit.query to non-admin users', async () => {
    store = await Store.start({ name: `audit-learn-${++storeCounter}` });
    store.defineBucket('tasks', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        title: { type: 'string', required: true },
      },
    });

    const auth: AuthConfig = {
      validate: async (token): Promise<AuthSession | null> => {
        if (token === 'writer-token') {
          return { userId: 'user-1', roles: ['writer'] };
        }
        return null;
      },
    };

    server = await NoexServer.start({
      store,
      auth,
      audit: { tiers: ['admin'] },
      port: 0,
      host: '127.0.0.1',
    });

    const { ws } = await connectClient(server.port);
    clients.push(ws);

    await sendRequest(ws, { type: 'auth.login', token: 'writer-token' });

    const resp = await sendRequest(ws, { type: 'audit.query' });
    expect(resp['type']).toBe('error');
    expect(resp['code']).toBe('FORBIDDEN');
  });

  // ── onEntry callback ───────────────────────────────────────

  it('onEntry captures entries externally', async () => {
    const collected: AuditEntry[] = [];

    store = await Store.start({ name: `audit-learn-${++storeCounter}` });
    store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    const auth: AuthConfig = {
      validate: async (token): Promise<AuthSession | null> => {
        if (token === 'admin') return { userId: 'admin-1', roles: ['admin'] };
        return null;
      },
    };

    const audit: AuditConfig = {
      tiers: ['admin', 'write'],
      onEntry: (entry) => collected.push(entry),
    };

    server = await NoexServer.start({
      store,
      auth,
      audit,
      port: 0,
      host: '127.0.0.1',
    });

    const { ws } = await connectClient(server.port);
    clients.push(ws);

    await sendRequest(ws, { type: 'auth.login', token: 'admin' });
    await sendRequest(ws, { type: 'store.insert', bucket: 'items', data: { name: 'Widget' } });

    // Verify onEntry received the insert
    const insertEntry = collected.find((e) => e.operation === 'store.insert');
    expect(insertEntry).toBeDefined();
    expect(insertEntry!.userId).toBe('admin-1');
    expect(insertEntry!.resource).toBe('items');
    expect(insertEntry!.result).toBe('success');

    // Also verify via audit.query
    const resp = await sendRequest(ws, { type: 'audit.query', operation: 'store.insert' });
    expect(resp['type']).toBe('result');
    const data = resp['data'] as { entries: Array<Record<string, unknown>> };
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
  });

  // ── Ring buffer maxEntries ──────────────────────────────────

  it('respects maxEntries configuration', async () => {
    store = await Store.start({ name: `audit-learn-${++storeCounter}` });
    store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    const auth: AuthConfig = {
      validate: async (token): Promise<AuthSession | null> => {
        if (token === 'admin') return { userId: 'admin-1', roles: ['admin'] };
        return null;
      },
    };

    server = await NoexServer.start({
      store,
      auth,
      audit: { tiers: ['admin', 'write'], maxEntries: 5 },
      port: 0,
      host: '127.0.0.1',
    });

    const { ws } = await connectClient(server.port);
    clients.push(ws);

    await sendRequest(ws, { type: 'auth.login', token: 'admin' });

    // Generate more than 5 entries
    for (let i = 0; i < 8; i++) {
      await sendRequest(ws, { type: 'store.insert', bucket: 'items', data: { name: `Item ${i}` } });
    }

    const resp = await sendRequest(ws, { type: 'audit.query' });
    const data = resp['data'] as { entries: Array<Record<string, unknown>> };

    // Ring buffer capped at 5
    expect(data.entries.length).toBeLessThanOrEqual(5);
  });
});
