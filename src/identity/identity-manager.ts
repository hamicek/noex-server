import type { Store } from '@hamicek/noex-store';
import type {
  IdentityConfig,
  RolePermission,
  RoleRecord,
  RoleInfo,
  UserRecord,
  UserInfo,
  UserRoleRecord,
  AclRecord,
  ResourceOwnerRecord,
  AclResourceType,
  LoginResult,
  CreateUserInput,
  UpdateUserInput,
  CreateRoleInput,
  UpdateRoleInput,
  ListUsersOptions,
  ListUsersResult,
  GrantInput,
  RevokeInput,
  AclEntry,
  OwnerInfo,
  EffectiveAccessResult,
} from './identity-types.js';
import {
  SUPERADMIN_USER_ID,
  SUPERADMIN_USERNAME,
  VALID_ACL_OPERATIONS,
} from './identity-types.js';
import type { AuthSession } from '../config.js';
import { ensureSystemBuckets } from './system-buckets.js';
import { IdentityCache } from './identity-cache.js';
import { SessionManager } from './session-manager.js';
import { hashPassword, verifyPassword } from './password-hasher.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

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
  readonly #cache: IdentityCache;
  readonly #loginLimiter: LoginRateLimiter;

  private constructor(store: Store, config: IdentityConfig, cache: IdentityCache) {
    this.#store = store;
    this.#config = config;
    this.#sessions = new SessionManager(store, config.sessionTtlMs);
    this.#cache = cache;
    this.#loginLimiter = new LoginRateLimiter(
      config.loginRateLimit?.maxAttempts,
      config.loginRateLimit?.windowMs,
    );
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
    const cache = await IdentityCache.start(store);
    return new IdentityManager(store, config, cache);
  }

  /** Graceful shutdown — unsubscribes from cache invalidation. */
  async stop(): Promise<void> {
    await this.#cache.stop();
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
    const userKey = `user:${username}`;
    const ipKey = meta?.ip ? `ip:${meta.ip}` : null;

    this.#loginLimiter.check(userKey);
    if (ipKey !== null) this.#loginLimiter.check(ipKey);

    try {
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

      this.#loginLimiter.reset(userKey);

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
    } catch (error) {
      if (error instanceof NoexServerError && error.code === ErrorCode.UNAUTHORIZED) {
        this.#loginLimiter.recordFailure(userKey);
        if (ipKey !== null) this.#loginLimiter.recordFailure(ipKey);
      }
      throw error;
    }
  }

  /**
   * Bootstrap login with the admin secret.
   * Creates a real session for the virtual superadmin user.
   */
  async loginWithSecret(
    secret: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const ipKey = meta?.ip ? `ip:${meta.ip}` : null;

    if (ipKey !== null) this.#loginLimiter.check(ipKey);

    if (secret !== this.#config.adminSecret) {
      if (ipKey !== null) this.#loginLimiter.recordFailure(ipKey);
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Invalid secret');
    }

    if (ipKey !== null) this.#loginLimiter.reset(ipKey);

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

  // ── User CRUD ─────────────────────────────────────────────────

  /**
   * Create a new user.
   *
   * Validates input, hashes password, and inserts into `_users`.
   * Throws VALIDATION_ERROR for invalid input, ALREADY_EXISTS for duplicate username.
   */
  async createUser(input: CreateUserInput): Promise<UserInfo> {
    const { username, password, displayName, email, enabled, metadata } = input;

    if (typeof username !== 'string' || username.length < 3 || username.length > 64) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Username must be between 3 and 64 characters',
      );
    }

    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    const existing = await this.#store.bucket('_users').where({ username });
    if (existing.length > 0) {
      throw new NoexServerError(
        ErrorCode.ALREADY_EXISTS,
        `User "${username}" already exists`,
      );
    }

    const passwordHash = await hashPassword(password);

    const data: Record<string, unknown> = {
      username,
      passwordHash,
      enabled: enabled ?? true,
    };
    if (displayName !== undefined) data['displayName'] = displayName;
    if (email !== undefined) data['email'] = email;
    if (metadata !== undefined) data['metadata'] = metadata;

    const record = await this.#store.bucket('_users').insert(data);
    return stripPasswordHash(record as unknown as UserRecord);
  }

  /**
   * Get a user by ID. Returns UserInfo (passwordHash stripped).
   * Throws NOT_FOUND if the user does not exist.
   */
  async getUser(userId: string): Promise<UserInfo> {
    const record = (await this.#store
      .bucket('_users')
      .get(userId)) as unknown as UserRecord | undefined;

    if (record === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    return stripPasswordHash(record);
  }

  /**
   * Update user profile fields (not password).
   * Only displayName, email, and metadata can be updated.
   * Throws NOT_FOUND if the user does not exist.
   */
  async updateUser(userId: string, updates: UpdateUserInput): Promise<UserInfo> {
    const existing = (await this.#store
      .bucket('_users')
      .get(userId)) as unknown as UserRecord | undefined;

    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const changes: Record<string, unknown> = {};
    if (updates.displayName !== undefined) changes['displayName'] = updates.displayName;
    if (updates.email !== undefined) changes['email'] = updates.email === null ? '' : updates.email;
    if (updates.metadata !== undefined) changes['metadata'] = updates.metadata === null ? {} : updates.metadata;

    if (Object.keys(changes).length === 0) {
      return stripPasswordHash(existing);
    }

    const updated = await this.#store.bucket('_users').update(userId, changes);
    return stripPasswordHash(updated as unknown as UserRecord);
  }

  /**
   * Hard-delete a user.
   * Deletes all sessions, user-role assignments, and ACL entries for the user.
   * Throws NOT_FOUND if the user does not exist.
   */
  async deleteUser(userId: string): Promise<void> {
    const existing = await this.#store.bucket('_users').get(userId);
    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    // Delete all sessions
    await this.#sessions.deleteUserSessions(userId);

    // Delete all user-role assignments
    const userRoles = await this.#store.bucket('_user_roles').where({ userId });
    for (const ur of userRoles) {
      await this.#store.bucket('_user_roles').delete((ur as unknown as { id: string }).id);
    }

    // Delete all ACL entries where this user is the subject
    const aclEntries = await this.#store.bucket('_acl').where({ subjectId: userId });
    for (const entry of aclEntries) {
      await this.#store.bucket('_acl').delete((entry as unknown as { id: string }).id);
    }

    // Delete all ownership records for this user
    const owned = (await this.#store
      .bucket('_resource_owners')
      .where({ userId })) as unknown as ResourceOwnerRecord[];
    for (const record of owned) {
      await this.#store.bucket('_resource_owners').delete(record.id);
    }

    // Delete the user record
    await this.#store.bucket('_users').delete(userId);
  }

  /**
   * List users with pagination (passwordHash stripped).
   * Uses offset-based pagination via page/pageSize.
   */
  async listUsers(options?: ListUsersOptions): Promise<ListUsersResult> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options?.pageSize ?? DEFAULT_PAGE_SIZE));

    const allUsers = (await this.#store
      .bucket('_users')
      .all()) as unknown as UserRecord[];

    const total = allUsers.length;
    const start = (page - 1) * pageSize;
    const slice = allUsers.slice(start, start + pageSize);

    return {
      users: slice.map(stripPasswordHash),
      total,
      page,
      pageSize,
    };
  }

  /** Enable a user account. Throws NOT_FOUND if the user does not exist. */
  async enableUser(userId: string): Promise<UserInfo> {
    const existing = await this.#store.bucket('_users').get(userId);
    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const updated = await this.#store.bucket('_users').update(userId, { enabled: true });
    return stripPasswordHash(updated as unknown as UserRecord);
  }

  /** Disable a user account. Invalidates all sessions. Throws NOT_FOUND if the user does not exist. */
  async disableUser(userId: string): Promise<UserInfo> {
    const existing = await this.#store.bucket('_users').get(userId);
    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const updated = await this.#store.bucket('_users').update(userId, { enabled: false });
    await this.#sessions.deleteUserSessions(userId);
    return stripPasswordHash(updated as unknown as UserRecord);
  }

  // ── Password Operations ──────────────────────────────────────

  /**
   * Change a user's password. Verifies the current password first.
   * Invalidates all other sessions for the user.
   *
   * Throws UNAUTHORIZED if current password is wrong.
   * Throws NOT_FOUND if the user does not exist.
   * Throws VALIDATION_ERROR if the new password is too short.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    const user = (await this.#store
      .bucket('_users')
      .get(userId)) as unknown as UserRecord | undefined;

    if (user === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      throw new NoexServerError(ErrorCode.UNAUTHORIZED, 'Current password is incorrect');
    }

    const newHash = await hashPassword(newPassword);
    await this.#store.bucket('_users').update(userId, { passwordHash: newHash });

    // Invalidate all sessions for this user (forces re-login)
    await this.#sessions.deleteUserSessions(userId);
  }

  /**
   * Reset a user's password (admin operation — no current password verification).
   * Invalidates all sessions for the user.
   *
   * Throws NOT_FOUND if the user does not exist.
   * Throws VALIDATION_ERROR if the new password is too short.
   */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    const user = await this.#store.bucket('_users').get(userId);
    if (user === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const newHash = await hashPassword(newPassword);
    await this.#store.bucket('_users').update(userId, { passwordHash: newHash });

    // Invalidate all sessions (forces re-login with new password)
    await this.#sessions.deleteUserSessions(userId);
  }

  // ── Role Management ────────────────────────────────────────────

  /**
   * Create a custom role.
   * Validates name uniqueness, prevents names colliding with system roles.
   * Throws VALIDATION_ERROR for invalid input, ALREADY_EXISTS for duplicate name.
   */
  async createRole(input: CreateRoleInput): Promise<RoleInfo> {
    const { name, description, permissions } = input;

    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Role name must be between 1 and 64 characters',
      );
    }

    const existing = await this.#store.bucket('_roles').where({ name });
    if (existing.length > 0) {
      throw new NoexServerError(
        ErrorCode.ALREADY_EXISTS,
        `Role "${name}" already exists`,
      );
    }

    const data: Record<string, unknown> = {
      name,
      system: false,
      permissions: (permissions ?? []) as unknown as Record<string, unknown>[],
    };
    if (description !== undefined) data['description'] = description;

    const record = await this.#store.bucket('_roles').insert(data);
    return stripRoleVersion(record as unknown as RoleRecord);
  }

  /**
   * Update a role's description and/or permissions.
   * System role names cannot be changed, but their permissions and description can be updated.
   * Throws NOT_FOUND if role does not exist.
   */
  async updateRole(roleId: string, updates: UpdateRoleInput): Promise<RoleInfo> {
    const existing = (await this.#store
      .bucket('_roles')
      .get(roleId)) as unknown as RoleRecord | undefined;

    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'Role not found');
    }

    const changes: Record<string, unknown> = {};
    if (updates.description !== undefined) changes['description'] = updates.description;
    if (updates.permissions !== undefined) {
      changes['permissions'] = updates.permissions as unknown as Record<string, unknown>[];
    }

    if (Object.keys(changes).length === 0) {
      return stripRoleVersion(existing);
    }

    const updated = await this.#store.bucket('_roles').update(roleId, changes);
    return stripRoleVersion(updated as unknown as RoleRecord);
  }

  /**
   * Delete a custom role.
   * System roles (superadmin, admin, writer, reader) cannot be deleted.
   * Cascading: removes all user-role assignments referencing this role.
   * Throws FORBIDDEN for system roles, NOT_FOUND if role does not exist.
   */
  async deleteRole(roleId: string): Promise<void> {
    const existing = (await this.#store
      .bucket('_roles')
      .get(roleId)) as unknown as RoleRecord | undefined;

    if (existing === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'Role not found');
    }

    if (existing.system) {
      throw new NoexServerError(ErrorCode.FORBIDDEN, 'Cannot delete system role');
    }

    // Remove all user-role assignments for this role
    const assignments = await this.#store.bucket('_user_roles').where({ roleId });
    for (const ur of assignments) {
      await this.#store.bucket('_user_roles').delete((ur as unknown as { id: string }).id);
    }

    await this.#store.bucket('_roles').delete(roleId);
  }

  /** List all roles. */
  async listRoles(): Promise<RoleInfo[]> {
    const roles = (await this.#store
      .bucket('_roles')
      .all()) as unknown as RoleRecord[];
    return roles.map(stripRoleVersion);
  }

  /**
   * Assign a role to a user by role name.
   * Throws NOT_FOUND if user or role does not exist.
   * Throws ALREADY_EXISTS if the user already has this role.
   */
  async assignRole(userId: string, roleName: string, grantedBy?: string): Promise<void> {
    // Verify user exists
    if (userId !== SUPERADMIN_USER_ID) {
      const user = await this.#store.bucket('_users').get(userId);
      if (user === undefined) {
        throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
      }
    }

    // Look up role by name
    const roles = (await this.#store
      .bucket('_roles')
      .where({ name: roleName })) as unknown as RoleRecord[];

    if (roles.length === 0) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, `Role "${roleName}" not found`);
    }
    const role = roles[0]!;

    // Check for duplicate assignment
    const existing = (await this.#store
      .bucket('_user_roles')
      .where({ userId })) as unknown as UserRoleRecord[];

    if (existing.some((ur) => ur.roleId === role.id)) {
      throw new NoexServerError(
        ErrorCode.ALREADY_EXISTS,
        `User already has role "${roleName}"`,
      );
    }

    const data: Record<string, unknown> = { userId, roleId: role.id };
    if (grantedBy !== undefined) data['grantedBy'] = grantedBy;

    await this.#store.bucket('_user_roles').insert(data);
  }

  /**
   * Remove a role from a user by role name.
   * Throws NOT_FOUND if role does not exist or user does not have the role.
   */
  async removeRole(userId: string, roleName: string): Promise<void> {
    const roles = (await this.#store
      .bucket('_roles')
      .where({ name: roleName })) as unknown as RoleRecord[];

    if (roles.length === 0) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, `Role "${roleName}" not found`);
    }
    const role = roles[0]!;

    const assignments = (await this.#store
      .bucket('_user_roles')
      .where({ userId })) as unknown as UserRoleRecord[];

    const match = assignments.find((ur) => ur.roleId === role.id);
    if (match === undefined) {
      throw new NoexServerError(
        ErrorCode.NOT_FOUND,
        `User does not have role "${roleName}"`,
      );
    }

    await this.#store.bucket('_user_roles').delete(match.id);
  }

  /**
   * Get all roles assigned to a user (full RoleInfo objects).
   * Throws NOT_FOUND if user does not exist.
   */
  async getUserRoles(userId: string): Promise<RoleInfo[]> {
    if (userId === SUPERADMIN_USER_ID) {
      const allRoles = (await this.#store
        .bucket('_roles')
        .all()) as unknown as RoleRecord[];
      const superadminRole = allRoles.find((r) => r.name === 'superadmin');
      return superadminRole ? [stripRoleVersion(superadminRole)] : [];
    }

    const user = await this.#store.bucket('_users').get(userId);
    if (user === undefined) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
    }

    const assignments = (await this.#store
      .bucket('_user_roles')
      .where({ userId })) as unknown as UserRoleRecord[];

    if (assignments.length === 0) return [];

    const roleIds = new Set(assignments.map((ur) => ur.roleId));
    const allRoles = (await this.#store
      .bucket('_roles')
      .all()) as unknown as RoleRecord[];

    return allRoles.filter((r) => roleIds.has(r.id)).map(stripRoleVersion);
  }

  // ── ACL Management ──────────────────────────────────────────────

  /**
   * Grant access to a subject (user or role) on a resource.
   *
   * Authorization: superadmin, admin role, resource owner, or user with
   * ACL `admin` on the resource.
   *
   * If an ACL entry already exists for the same subject + resource,
   * the new operations are merged into it.
   */
  async grant(callerUserId: string, input: GrantInput): Promise<void> {
    const { subjectType, subjectId, resourceType, resourceName, operations } = input;

    this.#validateAclOperations(operations);
    await this.#validateSubject(subjectType, subjectId);
    this.#requireAclPermission(callerUserId, resourceType, resourceName);

    // Look for existing ACL entry
    const existing = await this.#findAclEntry(subjectType, subjectId, resourceType, resourceName);

    if (existing !== null) {
      const merged = Array.from(new Set([...existing.operations, ...operations]));
      await this.#store.bucket('_acl').update(existing.id, { operations: merged });
    } else {
      await this.#store.bucket('_acl').insert({
        subjectType,
        subjectId,
        resourceType,
        resourceName,
        operations: [...operations],
        grantedBy: callerUserId,
      });
    }
  }

  /**
   * Revoke access from a subject on a resource.
   *
   * If `operations` is provided, only those are removed from the entry.
   * If omitted, the entire ACL entry is deleted.
   */
  async revoke(callerUserId: string, input: RevokeInput): Promise<void> {
    const { subjectType, subjectId, resourceType, resourceName, operations } = input;

    this.#requireAclPermission(callerUserId, resourceType, resourceName);

    const existing = await this.#findAclEntry(subjectType, subjectId, resourceType, resourceName);
    if (existing === null) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'ACL entry not found');
    }

    if (operations === undefined || operations.length === 0) {
      await this.#store.bucket('_acl').delete(existing.id);
    } else {
      const remaining = existing.operations.filter((op) => !operations.includes(op));
      if (remaining.length === 0) {
        await this.#store.bucket('_acl').delete(existing.id);
      } else {
        await this.#store.bucket('_acl').update(existing.id, { operations: remaining });
      }
    }
  }

  /**
   * Get all ACL entries for a resource, enriched with subject names
   * and ownership information.
   */
  async getAcl(resourceType: AclResourceType, resourceName: string): Promise<AclEntry[]> {
    const aclRecords = (await this.#store.bucket('_acl').all()) as unknown as AclRecord[];
    const matching = aclRecords.filter(
      (r) => r.resourceType === resourceType && r.resourceName === resourceName,
    );

    // Resolve owner for this resource
    const ownerRecord = await this.#findOwnerRecord(resourceType, resourceName);
    const ownerUserId = ownerRecord?.userId ?? null;

    const entries: AclEntry[] = [];
    for (const record of matching) {
      const subjectName = await this.#resolveSubjectName(record.subjectType, record.subjectId);
      entries.push({
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        subjectName,
        operations: [...record.operations],
        isOwner: record.subjectType === 'user' && record.subjectId === ownerUserId,
      });
    }

    // If the owner has no explicit ACL entry, include them with isOwner: true
    if (ownerUserId !== null && !entries.some((e) => e.subjectType === 'user' && e.subjectId === ownerUserId)) {
      const ownerName = await this.#resolveSubjectName('user', ownerUserId);
      entries.unshift({
        subjectType: 'user',
        subjectId: ownerUserId,
        subjectName: ownerName,
        operations: [],
        isOwner: true,
      });
    }

    return entries;
  }

  /**
   * Get effective access for a user — combines role permissions, ACL entries,
   * and ownership into a single view.
   */
  async getEffectiveAccess(userId: string): Promise<EffectiveAccessResult> {
    const isSuperadmin = userId === SUPERADMIN_USER_ID;
    let username: string;
    let roleNames: string[];

    if (isSuperadmin) {
      username = SUPERADMIN_USERNAME;
      roleNames = ['superadmin'];
    } else {
      const user = (await this.#store
        .bucket('_users')
        .get(userId)) as unknown as UserRecord | undefined;
      if (user === undefined) {
        throw new NoexServerError(ErrorCode.NOT_FOUND, 'User not found');
      }
      username = user.username;
      roleNames = await this.#getUserRoleNames(userId);
    }

    // Collect user ACL entries
    const userAcl = (await this.#store
      .bucket('_acl')
      .where({ subjectType: 'user', subjectId: userId })) as unknown as AclRecord[];

    // Collect role ACL entries
    const roleAcl: AclRecord[] = [];
    const roleIds = this.#cache.getUserRoleIds(userId);
    for (const roleId of roleIds) {
      const entries = (await this.#store
        .bucket('_acl')
        .where({ subjectType: 'role', subjectId: roleId })) as unknown as AclRecord[];
      roleAcl.push(...entries);
    }

    // Collect owned resources
    const owned = (await this.#store
      .bucket('_resource_owners')
      .where({ userId })) as unknown as ResourceOwnerRecord[];

    // Merge into resources map
    const resourceMap = new Map<string, {
      resourceType: AclResourceType;
      resourceName: string;
      operations: Set<string>;
      isOwner: boolean;
    }>();

    const getOrCreate = (type: AclResourceType, name: string) => {
      const key = `${type}:${name}`;
      let entry = resourceMap.get(key);
      if (entry === undefined) {
        entry = { resourceType: type, resourceName: name, operations: new Set(), isOwner: false };
        resourceMap.set(key, entry);
      }
      return entry;
    };

    for (const acl of userAcl) {
      const entry = getOrCreate(acl.resourceType, acl.resourceName);
      for (const op of acl.operations) entry.operations.add(op);
    }

    for (const acl of roleAcl) {
      const entry = getOrCreate(acl.resourceType, acl.resourceName);
      for (const op of acl.operations) entry.operations.add(op);
    }

    for (const own of owned) {
      const entry = getOrCreate(own.resourceType, own.resourceName);
      entry.isOwner = true;
      entry.operations.add('read');
      entry.operations.add('write');
      entry.operations.add('admin');
    }

    const resources = Array.from(resourceMap.values()).map((r) => ({
      resourceType: r.resourceType,
      resourceName: r.resourceName,
      operations: Array.from(r.operations).sort(),
      isOwner: r.isOwner,
    }));

    return {
      user: { id: userId, username, roles: roleNames },
      resources,
    };
  }

  // ── Ownership Management ──────────────────────────────────────────

  /**
   * Set a user as the owner of a resource. Idempotent.
   * Used internally by the server after defineBucket/defineQuery.
   */
  async setOwner(userId: string, resourceType: AclResourceType, resourceName: string): Promise<void> {
    const existing = await this.#findOwnerRecord(resourceType, resourceName);
    if (existing !== null) {
      if (existing.userId === userId) return;
      await this.#store.bucket('_resource_owners').update(existing.id, { userId });
      return;
    }

    await this.#store.bucket('_resource_owners').insert({
      userId,
      resourceType,
      resourceName,
    });
  }

  /**
   * Get the owner of a resource. Returns null if no owner is set.
   */
  async getOwner(resourceType: AclResourceType, resourceName: string): Promise<OwnerInfo | null> {
    const record = await this.#findOwnerRecord(resourceType, resourceName);
    if (record === null) return null;

    const username = await this.#resolveSubjectName('user', record.userId);
    return {
      userId: record.userId,
      username,
      resourceType,
      resourceName,
    };
  }

  /**
   * Transfer ownership to a new user.
   * Only the current owner or a superadmin can transfer.
   */
  async transferOwner(
    callerUserId: string,
    resourceType: AclResourceType,
    resourceName: string,
    newOwnerId: string,
  ): Promise<void> {
    const record = await this.#findOwnerRecord(resourceType, resourceName);
    if (record === null) {
      throw new NoexServerError(ErrorCode.NOT_FOUND, 'Resource has no owner');
    }

    const callerRoles = this.#cache.getUserRoleNames(callerUserId);
    const isSuperadmin = callerRoles.includes('superadmin');
    const isOwner = record.userId === callerUserId;

    if (!isSuperadmin && !isOwner) {
      throw new NoexServerError(
        ErrorCode.FORBIDDEN,
        'Only the owner or superadmin can transfer ownership',
      );
    }

    // Verify new owner exists
    if (newOwnerId !== SUPERADMIN_USER_ID) {
      const user = await this.#store.bucket('_users').get(newOwnerId);
      if (user === undefined) {
        throw new NoexServerError(ErrorCode.NOT_FOUND, 'New owner not found');
      }
    }

    await this.#store.bucket('_resource_owners').update(record.id, { userId: newOwnerId });
  }

  /**
   * Remove ownership and all ACL entries for a resource.
   * Used internally by the server after dropBucket/undefineQuery.
   */
  async removeOwnership(resourceType: AclResourceType, resourceName: string): Promise<void> {
    // Delete ownership record
    const ownerRecord = await this.#findOwnerRecord(resourceType, resourceName);
    if (ownerRecord !== null) {
      await this.#store.bucket('_resource_owners').delete(ownerRecord.id);
    }

    // Delete all ACL entries for this resource
    const allAcl = (await this.#store.bucket('_acl').all()) as unknown as AclRecord[];
    const matching = allAcl.filter(
      (r) => r.resourceType === resourceType && r.resourceName === resourceName,
    );
    for (const entry of matching) {
      await this.#store.bucket('_acl').delete(entry.id);
    }
  }

  // ── Permission Check ─────────────────────────────────────────────

  /**
   * Synchronous permission check using the in-memory cache.
   *
   * Algorithm (first match wins):
   * 1. superadmin → allow
   * 2. User ACL on resource → check
   * 3. Role ACL on resource → check
   * 4. Ownership → allow
   * 5. Role permissions → check
   * 6. Default: deny
   */
  isAllowed(userId: string, operation: string, resource: string): boolean {
    const roleNames = this.#cache.getUserRoleNames(userId);

    // 1. Superadmin bypass
    if (roleNames.includes('superadmin')) return true;

    const resourceType = deriveResourceType(operation);
    const aclOperation = OPERATION_TO_ACL[operation] ?? null;
    const hasSpecificResource = resourceType !== null && resource !== '*';

    // 2. Explicit user ACL on resource
    if (hasSpecificResource && aclOperation !== null) {
      const userAcl = this.#cache.getUserAcl(userId, resourceType, resource);
      if (userAcl !== null && userAcl.includes(aclOperation)) return true;
    }

    // 3. Role ACL on resource
    if (hasSpecificResource && aclOperation !== null) {
      const roleIds = this.#cache.getUserRoleIds(userId);
      for (const roleId of roleIds) {
        const roleAcl = this.#cache.getRoleAcl(roleId, resourceType, resource);
        if (roleAcl !== null && roleAcl.includes(aclOperation)) return true;
      }
    }

    // 4. Ownership — owner has full access to their resource
    if (hasSpecificResource) {
      if (this.#cache.isOwner(userId, resourceType, resource)) return true;
    }

    // 5. Role permissions (from _roles.permissions)
    const roles = this.#cache.getUserRoles(userId);
    for (const role of roles) {
      if (rolePermissionsAllow(role.permissions, operation, resourceType, resource)) {
        return true;
      }
    }

    // 6. Default: deny
    return false;
  }

  // ── Private ─────────────────────────────────────────────────────

  #validateAclOperations(operations: readonly string[]): void {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Operations must be a non-empty array',
      );
    }
    for (const op of operations) {
      if (!VALID_ACL_OPERATIONS.includes(op as typeof VALID_ACL_OPERATIONS[number])) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid ACL operation "${op}". Valid operations: ${VALID_ACL_OPERATIONS.join(', ')}`,
        );
      }
    }
  }

  async #validateSubject(subjectType: string, subjectId: string): Promise<void> {
    if (subjectType === 'user') {
      if (subjectId !== SUPERADMIN_USER_ID) {
        const user = await this.#store.bucket('_users').get(subjectId);
        if (user === undefined) {
          throw new NoexServerError(ErrorCode.NOT_FOUND, 'Subject user not found');
        }
      }
    } else if (subjectType === 'role') {
      const role = await this.#store.bucket('_roles').get(subjectId);
      if (role === undefined) {
        throw new NoexServerError(ErrorCode.NOT_FOUND, 'Subject role not found');
      }
    } else {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid subject type "${subjectType}". Must be "user" or "role"`,
      );
    }
  }

  /**
   * Check that the caller has permission to manage ACL for a resource.
   * Throws FORBIDDEN if not authorized.
   */
  #requireAclPermission(
    callerUserId: string,
    resourceType: AclResourceType,
    resourceName: string,
  ): void {
    const roleNames = this.#cache.getUserRoleNames(callerUserId);

    // Superadmin can manage anything
    if (roleNames.includes('superadmin')) return;

    // Admin role can manage anything
    if (roleNames.includes('admin')) return;

    // Owner can manage ACL for their resource
    if (this.#cache.isOwner(callerUserId, resourceType, resourceName)) return;

    // User with ACL 'admin' on the resource can manage ACL
    const userAcl = this.#cache.getUserAcl(callerUserId, resourceType, resourceName);
    if (userAcl !== null && userAcl.includes('admin')) return;

    throw new NoexServerError(
      ErrorCode.FORBIDDEN,
      'Must be the resource owner, admin, or have admin ACL to manage permissions',
    );
  }

  async #findAclEntry(
    subjectType: string,
    subjectId: string,
    resourceType: string,
    resourceName: string,
  ): Promise<AclRecord | null> {
    const all = (await this.#store.bucket('_acl').all()) as unknown as AclRecord[];
    return all.find(
      (r) =>
        r.subjectType === subjectType &&
        r.subjectId === subjectId &&
        r.resourceType === resourceType &&
        r.resourceName === resourceName,
    ) ?? null;
  }

  async #findOwnerRecord(
    resourceType: string,
    resourceName: string,
  ): Promise<ResourceOwnerRecord | null> {
    const all = (await this.#store
      .bucket('_resource_owners')
      .all()) as unknown as ResourceOwnerRecord[];
    return all.find(
      (r) => r.resourceType === resourceType && r.resourceName === resourceName,
    ) ?? null;
  }

  async #resolveSubjectName(subjectType: string, subjectId: string): Promise<string> {
    if (subjectType === 'user') {
      if (subjectId === SUPERADMIN_USER_ID) return SUPERADMIN_USERNAME;
      const user = (await this.#store
        .bucket('_users')
        .get(subjectId)) as unknown as UserRecord | undefined;
      return user?.username ?? subjectId;
    }
    // role
    const role = this.#cache.getRole(subjectId);
    return role?.name ?? subjectId;
  }

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

function stripPasswordHash(record: UserRecord): UserInfo {
  const { passwordHash: _, _version: __, ...rest } = record;
  return rest;
}

function stripRoleVersion(record: RoleRecord): RoleInfo {
  const { _version: _, ...rest } = record;
  return rest;
}

// ── Operation → ACL Mapping ──────────────────────────────────────
//
// Maps protocol operations to abstract ACL operations (read/write/admin).
// Used by isAllowed() to match against ACL entries.

const OPERATION_TO_ACL: Readonly<Record<string, string>> = {
  // Store — read
  'store.get': 'read',
  'store.all': 'read',
  'store.where': 'read',
  'store.findOne': 'read',
  'store.count': 'read',
  'store.first': 'read',
  'store.last': 'read',
  'store.paginate': 'read',
  'store.sum': 'read',
  'store.avg': 'read',
  'store.min': 'read',
  'store.max': 'read',
  'store.subscribe': 'read',
  'store.unsubscribe': 'read',
  'store.buckets': 'read',
  'store.stats': 'read',
  // Store — write
  'store.insert': 'write',
  'store.update': 'write',
  'store.delete': 'write',
  'store.clear': 'write',
  'store.transaction': 'write',
  // Store — admin
  'store.defineBucket': 'admin',
  'store.dropBucket': 'admin',
  'store.updateBucket': 'admin',
  'store.getBucketSchema': 'admin',
  'store.defineQuery': 'admin',
  'store.undefineQuery': 'admin',
  'store.listQueries': 'admin',

  // Rules — read
  'rules.getFact': 'read',
  'rules.queryFacts': 'read',
  'rules.getAllFacts': 'read',
  'rules.subscribe': 'read',
  'rules.unsubscribe': 'read',
  'rules.stats': 'read',
  // Rules — write
  'rules.emit': 'write',
  'rules.setFact': 'write',
  'rules.deleteFact': 'write',
  // Rules — admin
  'rules.registerRule': 'admin',
  'rules.unregisterRule': 'admin',
  'rules.updateRule': 'admin',
  'rules.enableRule': 'admin',
  'rules.disableRule': 'admin',
  'rules.getRule': 'admin',
  'rules.getRules': 'admin',
  'rules.validateRule': 'admin',

  // Procedures
  'procedures.get': 'read',
  'procedures.call': 'write',
  'procedures.register': 'admin',
  'procedures.unregister': 'admin',
  'procedures.update': 'admin',
  'procedures.list': 'admin',

  // Server / Audit
  'server.stats': 'admin',
  'server.connections': 'admin',
  'audit.query': 'admin',
};

function deriveResourceType(operation: string): string | null {
  if (operation.startsWith('store.')) return 'bucket';
  if (operation.startsWith('rules.')) return 'topic';
  if (operation.startsWith('procedures.')) return 'procedure';
  return null;
}

// ── Role Permission Matching ─────────────────────────────────────

function rolePermissionsAllow(
  permissions: readonly RolePermission[],
  operation: string,
  resourceType: string | null,
  resource: string,
): boolean {
  for (const perm of permissions) {
    if (!operationMatchesPermission(operation, perm.allow)) continue;

    // Check resource constraints
    if (resourceType === 'bucket' && perm.buckets !== undefined) {
      if (!perm.buckets.includes(resource)) continue;
    }
    if (resourceType === 'topic' && perm.topics !== undefined) {
      if (!perm.topics.some((t) => matchWildcard(t, resource))) continue;
    }

    return true;
  }
  return false;
}

function operationMatchesPermission(
  operation: string,
  allow: string | readonly string[],
): boolean {
  const patterns = typeof allow === 'string' ? [allow] : allow;
  return patterns.some((pattern) => matchWildcard(pattern, operation));
}

function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

// ── System Role Seeding ──────────────────────────────────────────

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
