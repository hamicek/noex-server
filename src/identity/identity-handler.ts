import type { ClientRequest } from '../protocol/types.js';
import type { AuthSession } from '../config.js';
import type { IdentityManager } from './identity-manager.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── Mutable auth state (subset of ConnectionState) ──────────────

export interface IdentityAuthState {
  session: AuthSession | null;
  authenticated: boolean;
  sessionToken: string | null;
}

// ── Identity request dispatcher ─────────────────────────────────

export async function handleIdentityRequest(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  switch (request.type) {
    case 'identity.login':
      return handleLogin(request, state, manager);
    case 'identity.loginWithSecret':
      return handleLoginWithSecret(request, state, manager);
    case 'identity.logout':
      return handleLogout(state, manager);
    case 'identity.whoami':
      return handleWhoami(state);
    case 'identity.refreshSession':
      return handleRefreshSession(state, manager);
    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown identity operation "${request.type}"`,
      );
  }
}

// ── identity.login ──────────────────────────────────────────────

async function handleLogin(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  const username = request['username'];
  const password = request['password'];

  if (typeof username !== 'string' || username.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      'Missing or invalid "username": expected non-empty string',
    );
  }

  if (typeof password !== 'string' || password.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      'Missing or invalid "password": expected non-empty string',
    );
  }

  const result = await manager.login(username, password);

  state.session = {
    userId: result.user.id,
    roles: result.user.roles,
    expiresAt: result.expiresAt,
  };
  state.authenticated = true;
  state.sessionToken = result.token;

  return result;
}

// ── identity.loginWithSecret ────────────────────────────────────

async function handleLoginWithSecret(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  const secret = request['secret'];

  if (typeof secret !== 'string' || secret.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      'Missing or invalid "secret": expected non-empty string',
    );
  }

  const result = await manager.loginWithSecret(secret);

  state.session = {
    userId: result.user.id,
    roles: result.user.roles,
    expiresAt: result.expiresAt,
  };
  state.authenticated = true;
  state.sessionToken = result.token;

  return result;
}

// ── identity.logout ─────────────────────────────────────────────

async function handleLogout(
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<{ loggedOut: true }> {
  if (state.sessionToken !== null) {
    await manager.logout(state.sessionToken);
  }

  state.session = null;
  state.authenticated = false;
  state.sessionToken = null;

  return { loggedOut: true };
}

// ── identity.whoami ─────────────────────────────────────────────

function handleWhoami(state: IdentityAuthState): unknown {
  if (!state.authenticated || state.session === null) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    userId: state.session.userId,
    roles: state.session.roles,
    expiresAt: state.session.expiresAt ?? null,
  };
}

// ── identity.refreshSession ─────────────────────────────────────

async function handleRefreshSession(
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  if (state.sessionToken === null || !state.authenticated) {
    throw new NoexServerError(
      ErrorCode.UNAUTHORIZED,
      'No active session to refresh',
    );
  }

  const result = await manager.refreshSession(state.sessionToken);

  state.session = {
    userId: result.user.id,
    roles: result.user.roles,
    expiresAt: result.expiresAt,
  };
  state.sessionToken = result.token;

  return result;
}
