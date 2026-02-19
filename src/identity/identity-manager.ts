import type { Store } from '@hamicek/noex-store';
import type {
  IdentityConfig,
  RolePermission,
  RoleRecord,
  UserRecord,
  UserRoleRecord,
  LoginResult,
} from './identity-types.js';
import {
  SUPERADMIN_USER_ID,
  SUPERADMIN_USERNAME,
} from './identity-types.js';
import type { AuthSession } from '../config.js';
import { ensureSystemBuckets } from './system-buckets.js';
import { SessionManager } from './session-manager.js';
import { verifyPassword } from './password-hasher.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── System Role Definitions ──────────────────────────────────────
//
// Permissions for system roles map to operation tiers + identity operations.
// superadmin bypasses all checks, so it has no explicit permissions — the
// permission engine short-circuits on superadmin.

const SYSTEM_ROLE_DEFINITIONS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly RolePermission[];
}> = [
  {
    name: 'superadmin',
    description: 'Full access to everything including identity management',
    permissions: [{ allow: '*' }],
  },
  {
    name: 'admin',
    description: 'Structural operations, data mutations, and reads',
    permissions: [
      { allow: ['store.*', 'rules.*', 'procedures.*', 'server.*', 'audit.*'] },
      { allow: ['identity.createUser', 'identity.getUser', 'identity.updateUser', 'identity.deleteUser', 'identity.listUsers'] },
      { allow: ['identity.enableUser', 'identity.disableUser', 'identity.resetPassword'] },
      { allow: ['identity.listRoles', 'identity.assignRole', 'identity.removeRole', 'identity.getUserRoles'] },
      { allow: ['identity.grant', 'identity.revoke', 'identity.getAcl'] },
    ],
  },
  {
    name: 'writer',
    description: 'Data mutations and reads',
    permissions: [
      { allow: ['store.insert', 'store.update', 'store.delete', 'store.clear', 'store.transaction'] },
      { allow: ['store.get', 'store.all', 'store.where', 'store.findOne', 'store.count'] },
      { allow: ['store.first', 'store.last', 'store.paginate'] },
      { allow: ['store.sum', 'store.avg', 'store.min', 'store.max'] },
      { allow: ['store.subscribe', 'store.unsubscribe', 'store.buckets', 'store.stats'] },
      { allow: ['rules.emit', 'rules.setFact', 'rules.deleteFact'] },
      { allow: ['rules.getFact', 'rules.queryFacts', 'rules.getAllFacts'] },
      { allow: ['rules.subscribe', 'rules.unsubscribe', 'rules.stats'] },
      { allow: ['procedures.call', 'procedures.get'] },
    ],
  },
  {
    name: 'reader',
    description: 'Read-only access',
    permissions: [
      { allow: ['store.get', 'store.all', 'store.where', 'store.findOne', 'store.count'] },
      { allow: ['store.first', 'store.last', 'store.paginate'] },
      { allow: ['store.sum', 'store.avg', 'store.min', 'store.max'] },
      { allow: ['store.subscribe', 'store.unsubscribe', 'store.buckets', 'store.stats'] },
      { allow: ['rules.getFact', 'rules.queryFacts', 'rules.getAllFacts'] },
      { allow: ['rules.subscribe', 'rules.unsubscribe', 'rules.stats'] },
      { allow: ['procedures.get'] },
    ],
  },
];

// ── IdentityManager ──────────────────────────────────────────────

export class IdentityManager {
  readonly #store: Store;
  readonly #config: IdentityConfig;
  readonly #sessions: SessionManager;

  private constructor(store: Store, config: IdentityConfig) {
    this.#store = store;
    this.#config = config;
    this.#sessions = new SessionManager(store, config.sessionTtlMs);
  }

  /** The store instance used by this manager. */
  get store(): Store {
    return this.#store;
  }

  /** The identity configuration. */
  get config(): IdentityConfig {
    return this.#config;
  }

  /**
   * Creates and initializes an IdentityManager.
   *
   * 1. Creates all system buckets (idempotent).
   * 2. Ensures system roles exist (idempotent).
   */
  static async start(store: Store, config: IdentityConfig): Promise<IdentityManager> {
    await ensureSystemBuckets(store);
    await ensureSystemRoles(store);
    return new IdentityManager(store, config);
  }

  /** Graceful shutdown — currently a no-op but reserved for future cleanup. */
  async stop(): Promise<void> {
    // Future: unsubscribe from cache invalidation, etc.
  }

  // ── Auth ────────────────────────────────────────────────────────

  /**
   * Authenticate with username and password.
   *
   * 1. Look up user by username.
   * 2. Verify password.
   * 3. Create session in _sessions.
   * 4. Return token + user info + roles.
   */
  async login(
    username: string,
    password: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const users = (await this.#store
      .bucket('_users')
      .where({ username })) as unknown as UserRecord[];

    if (users.length === 0) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Invalid credentials');
    }

    const user = users[0]!;

    if (!user.enabled) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Account disabled');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Invalid credentials');
    }

    const roles = await this.#getUserRoleNames(user.id);
    const session = await this.#sessions.createSession(user.id, meta);

    return {
      token: session.id,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        username: user.username,
        ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
        roles,
      },
    };
  }

  /**
   * Bootstrap login with the admin secret.
   * Creates a real session for the virtual superadmin user.
   */
  async loginWithSecret(
    secret: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    if (secret !== this.#config.adminSecret) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Invalid secret');
    }

    const session = await this.#sessions.createSession(SUPERADMIN_USER_ID, meta);

    return {
      token: session.id,
      expiresAt: session.expiresAt,
      user: {
        id: SUPERADMIN_USER_ID,
        username: SUPERADMIN_USERNAME,
        roles: ['superadmin'],
      },
    };
  }

  /** Delete a session (logout). */
  async logout(sessionToken: string): Promise<void> {
    await this.#sessions.deleteSession(sessionToken);
  }

  /**
   * Validate a session token and return an AuthSession for the connection.
   * Used by the synthetic `validate` function in built-in mode and for
   * `auth.login` token-based reconnect.
   */
  async validateSession(token: string): Promise<AuthSession | null> {
    const session = await this.#sessions.validateSession(token);
    if (session === null) return null;

    const roles = await this.#getUserRoleNames(session.userId);

    return {
      userId: session.userId,
      roles,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Refresh a session — delete the old one, create a new one.
   * Returns a new LoginResult with fresh token and expiry.
   */
  async refreshSession(sessionToken: string): Promise<LoginResult> {
    const oldSession = await this.#sessions.validateSession(sessionToken);
    if (oldSession === null) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Invalid or expired session');
    }

    const userId = oldSession.userId;
    await this.#sessions.deleteSession(sessionToken);

    const isSuperadmin = userId === SUPERADMIN_USER_ID;
    let userInfo: { id: string; username: string; displayName?: string };

    if (isSuperadmin) {
      userInfo = { id: SUPERADMIN_USER_ID, username: SUPERADMIN_USERNAME };
    } else {
      const user = (await this.#store
        .bucket('_users')
        .get(userId)) as unknown as UserRecord | undefined;

      if (user === undefined || !user.enabled) {
        throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'User not found or disabled');
      }

      userInfo = {
        id: user.id,
        username: user.username,
        ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
      };
    }

    const roles = await this.#getUserRoleNames(userId);
    const newSession = await this.#sessions.createSession(userId);

    return {
      token: newSession.id,
      expiresAt: newSession.expiresAt,
      user: {
        ...userInfo,
        roles,
      },
    };
  }

  /** Delete all sessions for a user. */
  async deleteUserSessions(userId: string): Promise<void> {
    await this.#sessions.deleteUserSessions(userId);
  }

  // ── Private ─────────────────────────────────────────────────────

  async #getUserRoleNames(userId: string): Promise<string[]> {
    if (userId === SUPERADMIN_USER_ID) {
      return ['superadmin'];
    }

    const userRoles = (await this.#store
      .bucket('_user_roles')
      .where({ userId })) as unknown as UserRoleRecord[];

    if (userRoles.length === 0) return [];

    const roleIds = new Set(userRoles.map((ur) => ur.roleId));
    const allRoles = (await this.#store.bucket('_roles').all()) as unknown as RoleRecord[];

    return allRoles.filter((r) => roleIds.has(r.id)).map((r) => r.name);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function ensureSystemRoles(store: Store): Promise<void> {
  const rolesBucket = store.bucket('_roles');

  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    const existing = await rolesBucket.where({ name: def.name }) as unknown as RoleRecord[];
    if (existing.length > 0) {
      continue;
    }

    await rolesBucket.insert({
      name: def.name,
      description: def.description,
      system: true,
      permissions: def.permissions as unknown as Record<string, unknown>[],
    });
  }
}
