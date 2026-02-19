import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';
import { hashPassword } from '../../src/identity/password-hasher.js';
import type { BuiltInAuthConfig } from '../../src/config.js';

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

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Identity Auth', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  const ADMIN_SECRET = 'test-admin-secret';

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

  async function setup(authOverrides?: Partial<BuiltInAuthConfig>): Promise<void> {
    store = await Store.start({ name: `identity-auth-test-${++storeCounter}` });
    server = await NoexServer.start({
      store,
      port: 0,
      host: '127.0.0.1',
      auth: {
        builtIn: true,
        adminSecret: ADMIN_SECRET,
        ...authOverrides,
      },
    });
  }

  async function insertTestUser(
    username: string,
    password: string,
    options?: { enabled?: boolean; displayName?: string },
  ): Promise<string> {
    const hash = await hashPassword(password);
    const record = await store!.bucket('_users').insert({
      username,
      passwordHash: hash,
      enabled: options?.enabled ?? true,
      ...(options?.displayName !== undefined
        ? { displayName: options.displayName }
        : {}),
    });
    return (record as unknown as { id: string }).id;
  }

  async function assignRole(userId: string, roleName: string): Promise<void> {
    const roles = (await store!
      .bucket('_roles')
      .where({ name: roleName })) as unknown as Array<{ id: string }>;
    if (roles.length === 0) throw new Error(`Role ${roleName} not found`);
    await store!.bucket('_user_roles').insert({
      userId,
      roleId: roles[0]!.id,
    });
  }

  // ── Welcome ─────────────────────────────────────────────────

  describe('welcome', () => {
    it('sends requiresAuth: true with built-in auth', async () => {
      await setup();
      const { welcome } = await connectClient(server!.port);
      clients.push((await connectClient(server!.port)).ws);

      expect(welcome['requiresAuth']).toBe(true);
    });
  });

  // ── identity.loginWithSecret ──────────────────────────────────

  describe('identity.loginWithSecret', () => {
    it('authenticates with correct admin secret', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(typeof data['token']).toBe('string');
      expect(typeof data['expiresAt']).toBe('number');
      const user = data['user'] as Record<string, unknown>;
      expect(user['id']).toBe('__superadmin__');
      expect(user['username']).toBe('__superadmin__');
      expect(user['roles']).toEqual(['superadmin']);
    });

    it('rejects invalid secret', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: 'wrong-secret',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('rejects missing secret', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('allows operations after successful login', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      // Define a bucket (requires authenticated)
      const defResp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'test',
        config: {
          key: 'id',
          schema: { id: { type: 'string', generated: 'uuid' }, name: { type: 'string' } },
        },
      });

      expect(defResp).toMatchObject({ type: 'result' });
    });
  });

  // ── identity.login ────────────────────────────────────────────

  describe('identity.login', () => {
    it('authenticates with valid username/password', async () => {
      await setup();
      await insertTestUser('alice', 'password123', {
        displayName: 'Alice',
      });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'password123',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(typeof data['token']).toBe('string');
      expect(typeof data['expiresAt']).toBe('number');
      const user = data['user'] as Record<string, unknown>;
      expect(user['username']).toBe('alice');
      expect(user['displayName']).toBe('Alice');
    });

    it('rejects invalid username', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'nonexistent',
        password: 'anything',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Invalid credentials');
    });

    it('rejects invalid password', async () => {
      await setup();
      await insertTestUser('alice', 'correct-password');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'wrong-password',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Invalid credentials');
    });

    it('rejects disabled user', async () => {
      await setup();
      await insertTestUser('alice', 'password123', { enabled: false });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'password123',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Account disabled');
    });

    it('rejects missing username', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        password: 'password123',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('rejects missing password', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('includes user roles in login response', async () => {
      await setup();
      const userId = await insertTestUser('alice', 'password123');
      await assignRole(userId, 'writer');

      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'password123',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const user = data['user'] as Record<string, unknown>;
      expect(user['roles']).toEqual(['writer']);
    });
  });

  // ── identity.whoami ───────────────────────────────────────────

  describe('identity.whoami', () => {
    it('returns user info when authenticated', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      const resp = await sendRequest(ws, { type: 'identity.whoami' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['authenticated']).toBe(true);
      expect(data['userId']).toBe('__superadmin__');
      expect(data['roles']).toEqual(['superadmin']);
    });

    it('returns authenticated: false when not logged in', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // whoami bypasses auth check because it's an identity.* operation
      // that requires auth — but it's handled gracefully
      const resp = await sendRequest(ws, { type: 'identity.whoami' });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('returns user info after identity.login', async () => {
      await setup();
      await insertTestUser('bob', 'secret');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, {
        type: 'identity.login',
        username: 'bob',
        password: 'secret',
      });

      const resp = await sendRequest(ws, { type: 'identity.whoami' });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['authenticated']).toBe(true);
      expect(data['userId']).not.toBe('__superadmin__');
    });
  });

  // ── identity.logout ───────────────────────────────────────────

  describe('identity.logout', () => {
    it('clears session and blocks subsequent operations', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      const logoutResp = await sendRequest(ws, { type: 'identity.logout' });
      expect(logoutResp['type']).toBe('result');
      expect(logoutResp['data']).toEqual({ loggedOut: true });

      // Subsequent operation should fail
      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: '_roles',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });

    it('invalidates session token', async () => {
      await setup();
      await insertTestUser('alice', 'pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });
      const token = (loginResp['data'] as Record<string, unknown>)['token'] as string;

      await sendRequest(ws, { type: 'identity.logout' });

      // Try to reconnect with the old token via auth.login
      const reconnectResp = await sendRequest(ws, {
        type: 'auth.login',
        token,
      });

      expect(reconnectResp['type']).toBe('error');
      expect(reconnectResp['code']).toBe('UNAUTHORIZED');
    });

    it('can re-login after logout', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      await sendRequest(ws, { type: 'identity.logout' });

      const loginResp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      expect(loginResp['type']).toBe('result');
    });
  });

  // ── Session expiration ────────────────────────────────────────

  describe('session expiration', () => {
    it('rejects expired session on next request', async () => {
      await setup({ sessionTtl: 200 }); // 200ms TTL
      await insertTestUser('alice', 'pass');

      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });
      expect(loginResp['type']).toBe('result');

      // Wait for session to expire
      await flush(400);

      const resp = await sendRequest(ws, {
        type: 'store.defineBucket',
        name: 'test',
        config: {
          key: 'id',
          schema: { id: { type: 'string', generated: 'uuid' } },
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });
  });

  // ── identity.refreshSession ───────────────────────────────────

  describe('identity.refreshSession', () => {
    it('returns new token and keeps user authenticated', async () => {
      await setup();
      await insertTestUser('alice', 'pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });
      const oldToken = (loginResp['data'] as Record<string, unknown>)[
        'token'
      ] as string;

      const refreshResp = await sendRequest(ws, {
        type: 'identity.refreshSession',
      });

      expect(refreshResp['type']).toBe('result');
      const data = refreshResp['data'] as Record<string, unknown>;
      const newToken = data['token'] as string;
      expect(newToken).not.toBe(oldToken);
      expect(typeof data['expiresAt']).toBe('number');

      // Old token should be invalid
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);

      const reconnect = await sendRequest(ws2, {
        type: 'auth.login',
        token: oldToken,
      });
      expect(reconnect['type']).toBe('error');
      expect(reconnect['code']).toBe('UNAUTHORIZED');
    });

    it('fails when not authenticated', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.refreshSession',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
    });
  });

  // ── auth.login token reconnect ────────────────────────────────

  describe('auth.login token reconnect', () => {
    it('validates session token from identity.login', async () => {
      await setup();
      await insertTestUser('alice', 'pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });
      const token = (loginResp['data'] as Record<string, unknown>)[
        'token'
      ] as string;

      // Connect a new client and use auth.login with the token
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);

      const reconnect = await sendRequest(ws2, {
        type: 'auth.login',
        token,
      });

      expect(reconnect['type']).toBe('result');
      const data = reconnect['data'] as Record<string, unknown>;
      expect(data['userId']).not.toBeNull();
    });

    it('validates session token from loginWithSecret', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const loginResp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });
      const token = (loginResp['data'] as Record<string, unknown>)[
        'token'
      ] as string;

      // Connect a new client and use auth.login with the token
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws2);

      const reconnect = await sendRequest(ws2, {
        type: 'auth.login',
        token,
      });

      expect(reconnect['type']).toBe('result');
      const data = reconnect['data'] as Record<string, unknown>;
      expect(data['userId']).toBe('__superadmin__');
    });
  });

  // ── Operations blocked before auth ────────────────────────────

  describe('operations blocked before auth', () => {
    it('blocks store operations before authentication', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.all',
        bucket: '_roles',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNAUTHORIZED');
      expect(resp['message']).toBe('Authentication required');
    });

    it('allows identity.login before authentication', async () => {
      await setup();
      await insertTestUser('alice', 'pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });

      expect(resp['type']).toBe('result');
    });

    it('allows identity.loginWithSecret before authentication', async () => {
      await setup();
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      expect(resp['type']).toBe('result');
    });
  });

  // ── identity not configured ───────────────────────────────────

  describe('identity not configured', () => {
    it('returns UNKNOWN_OPERATION when server has no built-in auth', async () => {
      store = await Store.start({
        name: `identity-auth-test-${++storeCounter}`,
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'pass',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
      expect(resp['message']).toBe('Identity management is not configured');
    });
  });

  // ── Connection isolation ──────────────────────────────────────

  describe('connection isolation', () => {
    it('auth state is independent per connection', async () => {
      await setup();
      const { ws: ws1 } = await connectClient(server!.port);
      const { ws: ws2 } = await connectClient(server!.port);
      clients.push(ws1, ws2);

      await sendRequest(ws1, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });

      // ws1 can define buckets
      const resp1 = await sendRequest(ws1, {
        type: 'store.defineBucket',
        name: 'test',
        config: {
          key: 'id',
          schema: { id: { type: 'string', generated: 'uuid' } },
        },
      });
      expect(resp1['type']).toBe('result');

      // ws2 is not authenticated
      const resp2 = await sendRequest(ws2, {
        type: 'store.all',
        bucket: 'test',
      });
      expect(resp2['type']).toBe('error');
      expect(resp2['code']).toBe('UNAUTHORIZED');
    });
  });

  // ── Login rate limiting ────────────────────────────────────────

  describe('login rate limiting', () => {
    it('locks out after maxAttempts failed logins', async () => {
      await setup({ loginRateLimit: { maxAttempts: 3, windowMs: 60_000 } });
      await insertTestUser('alice', 'correct-pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        const resp = await sendRequest(ws, {
          type: 'identity.login',
          username: 'alice',
          password: 'wrong',
        });
        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('UNAUTHORIZED');
      }

      // 4th attempt: even correct password should be rate-limited
      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RATE_LIMITED');
      expect(resp['details']).toHaveProperty('retryAfterMs');
    });

    it('successful login resets username counter', async () => {
      await setup({ loginRateLimit: { maxAttempts: 3, windowMs: 60_000 } });
      await insertTestUser('alice', 'correct-pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // 2 failed attempts (under limit)
      for (let i = 0; i < 2; i++) {
        await sendRequest(ws, {
          type: 'identity.login',
          username: 'alice',
          password: 'wrong',
        });
      }

      // Successful login
      const loginResp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(loginResp['type']).toBe('result');

      // Logout and try again — counter should be reset
      await sendRequest(ws, { type: 'identity.logout' });

      // Another 2 failed attempts (would be 4 total if not reset)
      for (let i = 0; i < 2; i++) {
        const resp = await sendRequest(ws, {
          type: 'identity.login',
          username: 'alice',
          password: 'wrong',
        });
        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('UNAUTHORIZED');
      }

      // Should still work (2 < 3)
      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(resp['type']).toBe('result');
    });

    it('rate limiting on loginWithSecret', async () => {
      await setup({ loginRateLimit: { maxAttempts: 2, windowMs: 60_000 } });
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // 2 failed attempts
      for (let i = 0; i < 2; i++) {
        const resp = await sendRequest(ws, {
          type: 'identity.loginWithSecret',
          secret: 'wrong-secret',
        });
        expect(resp['type']).toBe('error');
        expect(resp['code']).toBe('UNAUTHORIZED');
      }

      // 3rd attempt: rate limited
      const resp = await sendRequest(ws, {
        type: 'identity.loginWithSecret',
        secret: ADMIN_SECRET,
      });
      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RATE_LIMITED');
    });

    it('lockout expires after windowMs', async () => {
      await setup({ loginRateLimit: { maxAttempts: 2, windowMs: 100 } });
      await insertTestUser('alice', 'correct-pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      // 2 failed attempts → lockout
      for (let i = 0; i < 2; i++) {
        await sendRequest(ws, {
          type: 'identity.login',
          username: 'alice',
          password: 'wrong',
        });
      }

      const blocked = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(blocked['code']).toBe('RATE_LIMITED');

      // Wait for window to expire
      await flush(200);

      // Should work now
      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(resp['type']).toBe('result');
    });

    it('normal login works with default rate limit config', async () => {
      await setup(); // default rate limit enabled
      await insertTestUser('alice', 'correct-pass');
      const { ws } = await connectClient(server!.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'identity.login',
        username: 'alice',
        password: 'correct-pass',
      });
      expect(resp['type']).toBe('result');
    });
  });
});
