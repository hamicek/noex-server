import type { ClientRequest } from '../protocol/types.js';
import type { AuthConfig, AuthSession } from '../config.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── Mutable auth state (subset of ConnectionState) ──────────────

export interface AuthState {
  session: AuthSession | null;
  authenticated: boolean;
}

// ── Auth request dispatcher ──────────────────────────────────────

export async function handleAuthRequest(
  request: ClientRequest,
  state: AuthState,
  auth: AuthConfig | null,
): Promise<unknown> {
  if (auth === null) {
    throw new NoexServerError(
      ErrorCode.UNKNOWN_OPERATION,
      'Authentication is not configured',
    );
  }

  switch (request.type) {
    case 'auth.login':
      return handleLogin(request, state, auth);
    case 'auth.logout':
      return handleLogout(state);
    case 'auth.whoami':
      return handleWhoami(state);
    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown auth operation "${request.type}"`,
      );
  }
}

// ── auth.login ───────────────────────────────────────────────────

async function handleLogin(
  request: ClientRequest,
  state: AuthState,
  auth: AuthConfig,
): Promise<unknown> {
  const token = request['token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      'Missing or invalid "token": expected non-empty string',
    );
  }

  const session = await auth.validate(token);
  if (session === null) {
    throw new NoexServerError(
      ErrorCode.UNAUTHORIZED,
      'Invalid token',
    );
  }

  state.session = session;
  state.authenticated = true;

  return {
    userId: session.userId,
    roles: session.roles,
    expiresAt: session.expiresAt ?? null,
  };
}

// ── auth.logout ──────────────────────────────────────────────────

function handleLogout(state: AuthState): { loggedOut: true } {
  state.session = null;
  state.authenticated = false;
  return { loggedOut: true };
}

// ── auth.whoami ──────────────────────────────────────────────────

function handleWhoami(state: AuthState): unknown {
  if (!state.authenticated || state.session === null) {
    return { authenticated: false };
  }

  if (state.session.expiresAt !== undefined && state.session.expiresAt < Date.now()) {
    state.session = null;
    state.authenticated = false;
    return { authenticated: false };
  }

  return {
    authenticated: true,
    userId: state.session.userId,
    roles: state.session.roles,
    expiresAt: state.session.expiresAt ?? null,
  };
}
