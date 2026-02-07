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

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Fixtures ─────────────────────────────────────────────────────

const validSession: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
};

const adminSession: AuthSession = {
  userId: 'admin-1',
  roles: ['admin'],
};

function createAuth(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    validate: async (token) => {
      if (token === 'valid-user') return validSession;
      if (token === 'valid-admin') return adminSession;
      return null;
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Auth', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }
    server = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  async function setup(authConfig?: AuthConfig): Promise<void> {
    store = await Store.start({ name: `auth-test-${++storeCounter}` });
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
      auth: authConfig,
    });
  }

  // ── Login flow ─────────────────────────────────────────────────

  describe('login flow', () => {
    it('authenticates with a valid token and allows operations', async () => {
      await setup(createAuth());
      const { ws, welcome } = await connectClient(server!.port);
      clients.push(ws);

      expect(welcome['requiresAuth']).toBe(true);

      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'valid-user',
      });

      expect(loginResp['type']).toBe('result');
      expect(loginResp['data']).toMatchObject({
        userId: 'user-1',
        roles: ['user'],
      });

      const insertResp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });

      expect(insertResp['type']).toBe('result');
    });

    it('rejects invalid token', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'invalid-token',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Invalid token');
    });

    it('rejects missing token', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'auth.login' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('blocks store operations before authentication', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Authentication required');
    });

    it('allows re-authentication with a different token', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      const whoami1 = await sendRequest(ws, { type: 'auth.whoami' });
      expect((whoami1['data'] as Record<string, unknown>)['userId']).toBe('user-1');

      await sendRequest(ws, { type: 'auth.login', token: 'valid-admin' });
      const whoami2 = await sendRequest(ws, { type: 'auth.whoami' });
      expect((whoami2['data'] as Record<string, unknown>)['userId']).toBe('admin-1');
    });
  });

  // ── Logout ─────────────────────────────────────────────────────

  describe('logout', () => {
    it('clears session and blocks subsequent operations', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });

      const logoutResp = await sendRequest(ws, { type: 'auth.logout' });
      expect(logoutResp['type']).toBe('result');
      expect(logoutResp['data']).toEqual({ loggedOut: true });

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('can re-login after logout', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      await sendRequest(ws, { type: 'auth.logout' });
      await sendRequest(ws, { type: 'auth.login', token: 'valid-admin' });

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Bob' },
      });

      expect(resp['type']).toBe('result');
    });
  });

  // ── Whoami ─────────────────────────────────────────────────────

  describe('whoami', () => {
    it('returns session info when authenticated', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      const resp = await sendRequest(ws, { type: 'auth.whoami' });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toMatchObject({
        authenticated: true,
        userId: 'user-1',
        roles: ['user'],
      });
    });

    it('returns authenticated: false when not logged in', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'auth.whoami' });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual({ authenticated: false });
    });

    it('returns authenticated: false after logout', async () => {
      await setup(createAuth());
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      await sendRequest(ws, { type: 'auth.logout' });
      const resp = await sendRequest(ws, { type: 'auth.whoami' });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual({ authenticated: false });
    });
  });

  // ── Session expiration ─────────────────────────────────────────

  describe('session expiration', () => {
    it('rejects login with an already-expired token', async () => {
      const expiredSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 1000,
      };

      await setup(
        createAuth({
          validate: async (token) =>
            token === 'expired' ? expiredSession : null,
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'expired',
      });

      expect(loginResp['type']).toBe('error');
      expect(loginResp['code']).toBe('UNAUTHORIZED');
      expect(loginResp['message']).toBe('Token has expired');

      // Client remains unauthenticated — subsequent request gets auth required
      const storeResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(storeResp['code']).toBe('UNAUTHORIZED');
      expect(storeResp['message']).toBe('Authentication required');
    });

    it('detects session expiry between operations', async () => {
      // Session that expires very soon
      const shortLived: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() + 200,
      };

      await setup(
        createAuth({
          validate: async (token) =>
            token === 'short-lived' ? shortLived : null,
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'short-lived',
      });
      expect(loginResp['type']).toBe('result');

      // Wait for session to expire
      await flush(300);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Session expired');
    });

    it('allows re-login after session expiration', async () => {
      const expiredSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 1000,
      };

      await setup(
        createAuth({
          validate: async (token) => {
            if (token === 'expired') return expiredSession;
            if (token === 'valid-user') return validSession;
            return null;
          },
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // Expired login fails
      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'expired',
      });
      expect(loginResp['code']).toBe('UNAUTHORIZED');

      // Fresh login with valid token works
      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      const ok = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(ok['type']).toBe('result');
    });
  });

  // ── Permissions ────────────────────────────────────────────────

  describe('permissions', () => {
    it('allows operation when permission check passes', async () => {
      await setup(
        createAuth({
          permissions: {
            check: () => true,
          },
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice' },
      });

      expect(resp['type']).toBe('result');
    });

    it('denies operation when permission check fails', async () => {
      await setup(
        createAuth({
          permissions: {
            check: (_session, operation) => operation !== 'store.clear',
          },
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      const resp = await sendRequest(ws, {
        type: 'store.clear',
        bucket: 'users',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
      expect(resp['message']).toBe('No permission for store.clear on users');
    });

    it('passes correct session, operation, and resource to check', async () => {
      const calls: Array<{ operation: string; resource: string; userId: string }> = [];

      await setup(
        createAuth({
          permissions: {
            check: (session, operation, resource) => {
              calls.push({
                userId: session.userId,
                operation,
                resource,
              });
              return true;
            },
          },
        }),
      );
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, { type: 'auth.login', token: 'valid-user' });
      await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        userId: 'user-1',
        operation: 'store.all',
        resource: 'users',
      });
    });

    it('grants admin access while denying user', async () => {
      await setup(
        createAuth({
          permissions: {
            check: (session, operation) => {
              if (session.roles.includes('admin')) return true;
              return operation !== 'store.clear';
            },
          },
        }),
      );

      const { ws: userWs } = await connectClient(server!.port);
      clients.push(userWs);
      await sendRequest(userWs, { type: 'auth.login', token: 'valid-user' });

      const { ws: adminWs } = await connectClient(server!.port);
      clients.push(adminWs);
      await sendRequest(adminWs, { type: 'auth.login', token: 'valid-admin' });

      const userClear = await sendRequest(userWs, {
        type: 'store.clear',
        bucket: 'users',
      });
      expect(userClear['code']).toBe('FORBIDDEN');

      const adminClear = await sendRequest(adminWs, {
        type: 'store.clear',
        bucket: 'users',
      });
      expect(adminClear['type']).toBe('result');
    });
  });

  // ── Optional auth ──────────────────────────────────────────────

  describe('optional auth (required: false)', () => {
    it('allows operations without login', async () => {
      await setup(createAuth({ required: false }));
      const { ws, welcome } = await connectClient(server!.port);
      clients.push(ws);

      expect(welcome['requiresAuth']).toBe(false);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'users',
      });

      expect(resp['type']).toBe('result');
    });

    it('supports optional login for permission-based features', async () => {
      await setup(createAuth({ required: false }));
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'valid-user',
      });
      expect(loginResp['type']).toBe('result');

      const whoami = await sendRequest(ws, { type: 'auth.whoami' });
      expect((whoami['data'] as Record<string, unknown>)['authenticated']).toBe(true);
    });
  });

  // ── Auth not configured ────────────────────────────────────────

  describe('auth not configured', () => {
    it('returns UNKNOWN_OPERATION for auth.login', async () => {
      await setup(); // no auth config
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'auth.login',
        token: 'test',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
      expect(resp['message']).toBe('Authentication is not configured');
    });

    it('returns UNKNOWN_OPERATION for auth.whoami', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'auth.whoami' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });

    it('returns UNKNOWN_OPERATION for auth.logout', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, { type: 'auth.logout' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });
  });

  // ── Connection isolation ───────────────────────────────────────

  describe('connection isolation', () => {
    it('auth state is independent per connection', async () => {
      await setup(createAuth());

      const { ws: ws1 } = await connectClient(server!.port);
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws1, ws2);

      await sendRequest(ws1, { type: 'auth.login', token: 'valid-user' });

      const resp1 = await sendRequest(ws1, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp1['type']).toBe('result');

      const resp2 = await sendRequest(ws2, {
        type: 'store.all',
        bucket: 'users',
      });
      expect(resp2['type']).toBe('error');
      expect(resp2['code']).toBe('UNAUTHORIZED');
    });
  });
});
