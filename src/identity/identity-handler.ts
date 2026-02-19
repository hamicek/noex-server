import type { ClientRequest } from '../protocol/types.js';
import type { AuthSession } from '../config.js';
import type { IdentityManager } from './identity-manager.js';
import { SUPERADMIN_USER_ID } from './identity-types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── Mutable auth state (subset of ConnectionState) ──────────────

export interface IdentityAuthState {
  session: AuthSession | null;
  authenticated: boolean;
  sessionToken: string | null;
}

// ── Authorization helpers ───────────────────────────────────────

const ADMIN_ROLES = new Set(['superadmin', 'admin']);
const SUPERADMIN_ROLE = 'superadmin';

function requireAuth(state: IdentityAuthState): AuthSession {
  if (!state.authenticated || state.session === null) {
    throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Authentication required');
  }
  return state.session;
}

function requireAdmin(state: IdentityAuthState): AuthSession {
  const session = requireAuth(state);
  if (!session.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new NoexServerError(ErrorCode.FORBIDDEN, 'Admin role required');
  }
  return session;
}

function requireSuperadmin(state: IdentityAuthState): AuthSession {
  const session = requireAuth(state);
  if (!session.roles.includes(SUPERADMIN_ROLE)) {
    throw new NoexServerError(ErrorCode.FORBIDDEN, 'Superadmin role required');
  }
  return session;
}

function requireString(request: ClientRequest, field: string, label?: string): string {
  const value = request[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${label ?? field}": expected non-empty string`,
    );
  }
  return value;
}

// ── Identity request dispatcher ─────────────────────────────────

export async function handleIdentityRequest(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  switch (request.type) {
    // Auth (no role check — login ops bypass auth in connection-server)
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

    // User CRUD (admin)
    case 'identity.createUser':
      return handleCreateUser(request, state, manager);
    case 'identity.getUser':
      return handleGetUser(request, state, manager);
    case 'identity.updateUser':
      return handleUpdateUser(request, state, manager);
    case 'identity.deleteUser':
      return handleDeleteUser(request, state, manager);
    case 'identity.listUsers':
      return handleListUsers(request, state, manager);
    case 'identity.enableUser':
      return handleEnableUser(request, state, manager);
    case 'identity.disableUser':
      return handleDisableUser(request, state, manager);

    // Password operations
    case 'identity.changePassword':
      return handleChangePassword(request, state, manager);
    case 'identity.resetPassword':
      return handleResetPassword(request, state, manager);

    // Role management
    case 'identity.createRole':
      return handleCreateRole(request, state, manager);
    case 'identity.updateRole':
      return handleUpdateRole(request, state, manager);
    case 'identity.deleteRole':
      return handleDeleteRole(request, state, manager);
    case 'identity.listRoles':
      return handleListRoles(state, manager);
    case 'identity.assignRole':
      return handleAssignRole(request, state, manager);
    case 'identity.removeRole':
      return handleRemoveRole(request, state, manager);
    case 'identity.getUserRoles':
      return handleGetUserRoles(request, state, manager);

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
  const username = requireString(request, 'username');
  const password = requireString(request, 'password');

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
  const secret = requireString(request, 'secret');
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

// ── identity.createUser ─────────────────────────────────────────

async function handleCreateUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const username = requireString(request, 'username');
  const password = requireString(request, 'password');

  return manager.createUser({
    username,
    password,
    displayName: typeof request['displayName'] === 'string' ? request['displayName'] : undefined,
    email: typeof request['email'] === 'string' ? request['email'] : undefined,
    enabled: typeof request['enabled'] === 'boolean' ? request['enabled'] : undefined,
    metadata: isPlainObject(request['metadata']) ? request['metadata'] as Record<string, unknown> : undefined,
  });
}

// ── identity.getUser ────────────────────────────────────────────

async function handleGetUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');
  return manager.getUser(userId);
}

// ── identity.updateUser ─────────────────────────────────────────

async function handleUpdateUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  const session = requireAuth(state);
  const userId = requireString(request, 'userId');

  // Users can update their own profile; admin can update anyone
  const isSelf = session.userId === userId;
  if (!isSelf && !session.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new NoexServerError(ErrorCode.FORBIDDEN, 'Admin role required');
  }

  return manager.updateUser(userId, {
    displayName: request['displayName'] !== undefined
      ? (typeof request['displayName'] === 'string' ? request['displayName'] : null)
      : undefined,
    email: request['email'] !== undefined
      ? (typeof request['email'] === 'string' ? request['email'] : null)
      : undefined,
    metadata: request['metadata'] !== undefined
      ? (isPlainObject(request['metadata']) ? request['metadata'] as Record<string, unknown> : null)
      : undefined,
  });
}

// ── identity.deleteUser ─────────────────────────────────────────

async function handleDeleteUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');

  // Prevent deleting the virtual superadmin
  if (userId === SUPERADMIN_USER_ID) {
    throw new NoexServerError(ErrorCode.FORBIDDEN, 'Cannot delete virtual superadmin');
  }

  await manager.deleteUser(userId);
  return { deleted: true };
}

// ── identity.listUsers ──────────────────────────────────────────

async function handleListUsers(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const page = typeof request['page'] === 'number' ? request['page'] : undefined;
  const pageSize = typeof request['pageSize'] === 'number' ? request['pageSize'] : undefined;

  return manager.listUsers({ page, pageSize });
}

// ── identity.enableUser ─────────────────────────────────────────

async function handleEnableUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');
  return manager.enableUser(userId);
}

// ── identity.disableUser ────────────────────────────────────────

async function handleDisableUser(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');

  // Prevent disabling the virtual superadmin
  if (userId === SUPERADMIN_USER_ID) {
    throw new NoexServerError(ErrorCode.FORBIDDEN, 'Cannot disable virtual superadmin');
  }

  return manager.disableUser(userId);
}

// ── identity.changePassword ─────────────────────────────────────

async function handleChangePassword(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  const session = requireAuth(state);

  const userId = requireString(request, 'userId');
  const currentPassword = requireString(request, 'currentPassword');
  const newPassword = requireString(request, 'newPassword');

  // Users can only change their own password
  if (session.userId !== userId) {
    throw new NoexServerError(
      ErrorCode.FORBIDDEN,
      'Can only change your own password (use resetPassword for other users)',
    );
  }

  await manager.changePassword(userId, currentPassword, newPassword);
  return { changed: true };
}

// ── identity.resetPassword ──────────────────────────────────────

async function handleResetPassword(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');
  const newPassword = requireString(request, 'newPassword');

  await manager.resetPassword(userId, newPassword);
  return { reset: true };
}

// ── identity.createRole ──────────────────────────────────────────

async function handleCreateRole(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireSuperadmin(state);

  const name = requireString(request, 'name');

  return manager.createRole({
    name,
    description: typeof request['description'] === 'string' ? request['description'] : undefined,
    permissions: Array.isArray(request['permissions']) ? request['permissions'] : undefined,
  });
}

// ── identity.updateRole ──────────────────────────────────────────

async function handleUpdateRole(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireSuperadmin(state);

  const roleId = requireString(request, 'roleId');

  return manager.updateRole(roleId, {
    description: request['description'] !== undefined
      ? (typeof request['description'] === 'string' ? request['description'] : undefined)
      : undefined,
    permissions: Array.isArray(request['permissions']) ? request['permissions'] : undefined,
  });
}

// ── identity.deleteRole ──────────────────────────────────────────

async function handleDeleteRole(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireSuperadmin(state);

  const roleId = requireString(request, 'roleId');
  await manager.deleteRole(roleId);
  return { deleted: true };
}

// ── identity.listRoles ───────────────────────────────────────────

async function handleListRoles(
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const roles = await manager.listRoles();
  return { roles };
}

// ── identity.assignRole ──────────────────────────────────────────

async function handleAssignRole(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  const session = requireAdmin(state);

  const userId = requireString(request, 'userId');
  const roleName = requireString(request, 'roleName');

  await manager.assignRole(userId, roleName, session.userId);
  return { assigned: true };
}

// ── identity.removeRole ──────────────────────────────────────────

async function handleRemoveRole(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');
  const roleName = requireString(request, 'roleName');

  await manager.removeRole(userId, roleName);
  return { removed: true };
}

// ── identity.getUserRoles ────────────────────────────────────────

async function handleGetUserRoles(
  request: ClientRequest,
  state: IdentityAuthState,
  manager: IdentityManager,
): Promise<unknown> {
  requireAdmin(state);

  const userId = requireString(request, 'userId');
  const roles = await manager.getUserRoles(userId);
  return { roles };
}

// ── Utilities ───────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
