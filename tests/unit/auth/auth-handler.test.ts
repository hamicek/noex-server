import { describe, it, expect } from 'vitest';
import { handleAuthRequest, type AuthState } from '../../../src/auth/auth-handler.js';
import type { AuthConfig, AuthSession } from '../../../src/config.js';
import type { ClientRequest } from '../../../src/protocol/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createState(overrides?: Partial<AuthState>): AuthState {
  return {
    session: null,
    authenticated: false,
    ...overrides,
  };
}

const validSession: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
  expiresAt: Date.now() + 60_000,
};

function createAuth(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    validate: async () => validSession,
    ...overrides,
  };
}

function req(type: string, extra?: Record<string, unknown>): ClientRequest {
  return { id: 1, type, ...extra } as ClientRequest;
}

// ── Tests ────────────────────────────────────────────────────────

describe('auth-handler', () => {
  // ── auth.login ─────────────────────────────────────────────────

  describe('auth.login', () => {
    it('authenticates with a valid token', async () => {
      const state = createState();
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.login', { token: 'valid-token' }),
        state,
        auth,
      );

      expect(result).toEqual({
        userId: 'user-1',
        roles: ['user'],
        expiresAt: validSession.expiresAt,
      });
      expect(state.authenticated).toBe(true);
      expect(state.session).toBe(validSession);
    });

    it('rejects an invalid token', async () => {
      const state = createState();
      const auth = createAuth({ validate: async () => null });

      await expect(
        handleAuthRequest(req('auth.login', { token: 'bad' }), state, auth),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid token',
      });

      expect(state.authenticated).toBe(false);
      expect(state.session).toBeNull();
    });

    it('rejects missing token', async () => {
      const state = createState();
      const auth = createAuth();

      await expect(
        handleAuthRequest(req('auth.login'), state, auth),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('rejects empty token', async () => {
      const state = createState();
      const auth = createAuth();

      await expect(
        handleAuthRequest(req('auth.login', { token: '' }), state, auth),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('allows re-authentication when already logged in', async () => {
      const newSession: AuthSession = {
        userId: 'user-2',
        roles: ['admin'],
      };
      const state = createState({
        authenticated: true,
        session: validSession,
      });
      const auth = createAuth({ validate: async () => newSession });

      const result = await handleAuthRequest(
        req('auth.login', { token: 'new-token' }),
        state,
        auth,
      );

      expect(result).toMatchObject({ userId: 'user-2', roles: ['admin'] });
      expect(state.session).toBe(newSession);
    });

    it('returns null expiresAt when session has no expiration', async () => {
      const sessionNoExpiry: AuthSession = { userId: 'u1', roles: ['user'] };
      const state = createState();
      const auth = createAuth({ validate: async () => sessionNoExpiry });

      const result = await handleAuthRequest(
        req('auth.login', { token: 'tok' }),
        state,
        auth,
      );

      expect(result).toMatchObject({ expiresAt: null });
    });

    it('rejects login with an already-expired token', async () => {
      const expiredSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 10_000,
      };
      const state = createState();
      const auth = createAuth({ validate: async () => expiredSession });

      await expect(
        handleAuthRequest(req('auth.login', { token: 'expired' }), state, auth),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Token has expired',
      });

      expect(state.authenticated).toBe(false);
      expect(state.session).toBeNull();
    });

    it('accepts login with a far-future expiration', async () => {
      const futureSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() + 3_600_000,
      };
      const state = createState();
      const auth = createAuth({ validate: async () => futureSession });

      const result = await handleAuthRequest(
        req('auth.login', { token: 'valid' }),
        state,
        auth,
      );

      expect(result).toMatchObject({ userId: 'user-1' });
      expect(state.authenticated).toBe(true);
    });
  });

  // ── auth.logout ────────────────────────────────────────────────

  describe('auth.logout', () => {
    it('clears session and authenticated flag', async () => {
      const state = createState({
        authenticated: true,
        session: validSession,
      });
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.logout'),
        state,
        auth,
      );

      expect(result).toEqual({ loggedOut: true });
      expect(state.authenticated).toBe(false);
      expect(state.session).toBeNull();
    });

    it('is idempotent when already logged out', async () => {
      const state = createState();
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.logout'),
        state,
        auth,
      );

      expect(result).toEqual({ loggedOut: true });
      expect(state.authenticated).toBe(false);
    });
  });

  // ── auth.whoami ────────────────────────────────────────────────

  describe('auth.whoami', () => {
    it('returns session info when authenticated', async () => {
      const state = createState({
        authenticated: true,
        session: validSession,
      });
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.whoami'),
        state,
        auth,
      );

      expect(result).toEqual({
        authenticated: true,
        userId: 'user-1',
        roles: ['user'],
        expiresAt: validSession.expiresAt,
      });
    });

    it('returns authenticated: false when not logged in', async () => {
      const state = createState();
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.whoami'),
        state,
        auth,
      );

      expect(result).toEqual({ authenticated: false });
    });

    it('detects expired session and clears state', async () => {
      const expiredSession: AuthSession = {
        userId: 'user-1',
        roles: ['user'],
        expiresAt: Date.now() - 1000,
      };
      const state = createState({
        authenticated: true,
        session: expiredSession,
      });
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.whoami'),
        state,
        auth,
      );

      expect(result).toEqual({ authenticated: false });
      expect(state.authenticated).toBe(false);
      expect(state.session).toBeNull();
    });

    it('returns null expiresAt when session has no expiration', async () => {
      const sessionNoExpiry: AuthSession = { userId: 'u1', roles: ['user'] };
      const state = createState({
        authenticated: true,
        session: sessionNoExpiry,
      });
      const auth = createAuth();

      const result = await handleAuthRequest(
        req('auth.whoami'),
        state,
        auth,
      );

      expect(result).toMatchObject({
        authenticated: true,
        expiresAt: null,
      });
    });
  });

  // ── auth not configured ────────────────────────────────────────

  describe('auth not configured', () => {
    it('throws UNKNOWN_OPERATION for auth.login', async () => {
      const state = createState();

      await expect(
        handleAuthRequest(req('auth.login', { token: 'x' }), state, null),
      ).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
        message: 'Authentication is not configured',
      });
    });

    it('throws UNKNOWN_OPERATION for auth.logout', async () => {
      const state = createState();

      await expect(
        handleAuthRequest(req('auth.logout'), state, null),
      ).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
      });
    });

    it('throws UNKNOWN_OPERATION for auth.whoami', async () => {
      const state = createState();

      await expect(
        handleAuthRequest(req('auth.whoami'), state, null),
      ).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
      });
    });
  });

  // ── unknown auth operation ─────────────────────────────────────

  it('throws UNKNOWN_OPERATION for unknown auth type', async () => {
    const state = createState();
    const auth = createAuth();

    await expect(
      handleAuthRequest(req('auth.refresh'), state, auth),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_OPERATION',
    });
  });
});
