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

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForSystemMessage(
  ws: WebSocket,
  event: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'system' && msg['event'] === event) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────

const sessions: Record<string, AuthSession> = {
  admin:   { userId: 'admin-1',   roles: ['admin'] },
  writer:  { userId: 'writer-1',  roles: ['writer'] },
  writer2: { userId: 'writer-2',  roles: ['writer'] },
  reader:  { userId: 'reader-1',  roles: ['reader'] },
};

const auth: AuthConfig = {
  validate: async (token) => sessions[token] ?? null,
};

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Session Revocation', () => {
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

  async function setup(
    opts?: { blacklistTtlMs?: number },
  ): Promise<void> {
    store = await Store.start({ name: `revoke-test-${++storeCounter}` });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth,
      revocation: opts,
    });
  }

  async function connect(token: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const resp = await login(ws, token);
    expect(resp['type']).toBe('result');
    return ws;
  }

  // ── revokeSession disconnects the client ──────────────────────

  describe('revokeSession', () => {
    it('disconnects all connections of a user', async () => {
      await setup();
      const ws = await connect('writer');
      const closePromise = waitForClose(ws);
      const sysPromise = waitForSystemMessage(ws, 'session_revoked');

      const count = server!.revokeSession('writer-1');
      expect(count).toBe(1);

      const sysMsg = await sysPromise;
      expect(sysMsg['event']).toBe('session_revoked');
      expect(sysMsg['reason']).toBe('Session revoked by administrator');

      const { code, reason } = await closePromise;
      expect(code).toBe(4002);
      expect(reason).toBe('session_revoked');
    });

    it('disconnects multiple connections of the same user', async () => {
      await setup();
      const ws1 = await connect('writer');
      const ws2 = await connect('writer');
      const close1 = waitForClose(ws1);
      const close2 = waitForClose(ws2);

      const count = server!.revokeSession('writer-1');
      expect(count).toBe(2);

      const [r1, r2] = await Promise.all([close1, close2]);
      expect(r1.code).toBe(4002);
      expect(r2.code).toBe(4002);
    });

    it('returns 0 when user has no connections', async () => {
      await setup();
      const count = server!.revokeSession('nobody');
      expect(count).toBe(0);
    });

    it('does not affect other users', async () => {
      await setup();
      const writerWs = await connect('writer');
      const readerWs = await connect('reader');
      const writerClose = waitForClose(writerWs);

      server!.revokeSession('writer-1');
      await writerClose;

      // Reader should still be able to make requests
      const resp = await sendRequest(readerWs, { type: 'store.buckets' });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Blacklist blocks re-login ─────────────────────────────────

  describe('blacklist blocks re-login', () => {
    it('revoked user cannot log in again', async () => {
      await setup();
      const ws1 = await connect('writer');
      const closePromise = waitForClose(ws1);

      server!.revokeSession('writer-1');
      await closePromise;

      // Try to login again with the same userId
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const resp = await login(ws2, 'writer');
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('SESSION_REVOKED');
    });

    it('blacklist expires after TTL', async () => {
      await setup({ blacklistTtlMs: 200 });
      const ws1 = await connect('writer');
      const closePromise = waitForClose(ws1);

      server!.revokeSession('writer-1');
      await closePromise;

      // Wait for blacklist to expire
      await new Promise((r) => setTimeout(r, 250));

      // Should be able to login again
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const resp = await login(ws2, 'writer');
      expect(resp['type']).toBe('result');
    });
  });

  // ── revokeSessions with filter ────────────────────────────────

  describe('revokeSessions', () => {
    it('revokes by userId', async () => {
      await setup();
      const ws = await connect('writer');
      const closePromise = waitForClose(ws);

      const count = server!.revokeSessions({ userId: 'writer-1' });
      expect(count).toBe(1);

      const { code } = await closePromise;
      expect(code).toBe(4002);
    });

    it('revokes by role', async () => {
      await setup();
      const ws1 = await connect('writer');
      const ws2 = await connect('writer2');
      const readerWs = await connect('reader');
      const close1 = waitForClose(ws1);
      const close2 = waitForClose(ws2);

      const count = server!.revokeSessions({ role: 'writer' });
      expect(count).toBe(2);

      const [r1, r2] = await Promise.all([close1, close2]);
      expect(r1.code).toBe(4002);
      expect(r2.code).toBe(4002);

      // Reader still works
      const resp = await sendRequest(readerWs, { type: 'store.buckets' });
      expect(resp['type']).toBe('result');
    });

    it('revokes by userId and role combined', async () => {
      await setup();
      const ws1 = await connect('writer');
      const ws2 = await connect('writer2');
      const close1 = waitForClose(ws1);

      const count = server!.revokeSessions({
        userId: 'writer-1',
        role: 'writer',
      });
      expect(count).toBe(1);
      await close1;

      // writer2 should still work
      const resp = await sendRequest(ws2, { type: 'store.buckets' });
      expect(resp['type']).toBe('result');
    });

    it('revoked-by-role users are blacklisted', async () => {
      await setup();
      const ws = await connect('writer');
      const closePromise = waitForClose(ws);

      server!.revokeSessions({ role: 'writer' });
      await closePromise;

      // Try to re-login
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);
      const resp = await login(ws2, 'writer');
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('SESSION_REVOKED');
    });

    it('returns 0 when no connections match', async () => {
      await setup();
      const count = server!.revokeSessions({ role: 'nonexistent' });
      expect(count).toBe(0);
    });
  });

  // ── Unauthenticated connections are unaffected ─────────────────

  describe('unauthenticated connections', () => {
    it('revokeSession does not affect unauthenticated connections', async () => {
      await setup();

      // Connect but don't login
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const count = server!.revokeSession('writer-1');
      expect(count).toBe(0);

      // The unauthenticated connection should still work for login
      const resp = await login(ws, 'admin');
      expect(resp['type']).toBe('result');
    });
  });
});
