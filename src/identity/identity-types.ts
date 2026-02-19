// ── Identity Types ───────────────────────────────────────────────
//
// All type definitions for the built-in identity & authorization system.
// These correspond to records stored in system buckets (_users, _roles, etc.).

// ── User ─────────────────────────────────────────────────────────

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

/** User info returned by public APIs (passwordHash stripped). */
export interface UserInfo {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

// ── Role ─────────────────────────────────────────────────────────

export interface RolePermission {
  readonly allow: string | readonly string[];
  readonly buckets?: readonly string[];
  readonly topics?: readonly string[];
}

export interface RoleRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly system: boolean;
  readonly permissions: readonly RolePermission[];
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

export type RoleInfo = Omit<RoleRecord, '_version'>;

// ── User–Role join ───────────────────────────────────────────────

export interface UserRoleRecord {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly grantedBy?: string;
  readonly grantedAt: number;
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

// ── ACL ──────────────────────────────────────────────────────────

export type AclSubjectType = 'user' | 'role';
export type AclResourceType = 'bucket' | 'topic' | 'procedure' | 'query';

export interface AclRecord {
  readonly id: string;
  readonly subjectType: AclSubjectType;
  readonly subjectId: string;
  readonly resourceType: AclResourceType;
  readonly resourceName: string;
  readonly operations: readonly string[];
  readonly grantedBy?: string;
  readonly grantedAt: number;
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

// ── Session ──────────────────────────────────────────────────────

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

export interface SessionInfo {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

// ── Resource Ownership ───────────────────────────────────────────

export interface ResourceOwnerRecord {
  readonly id: string;
  readonly userId: string;
  readonly resourceType: AclResourceType;
  readonly resourceName: string;
  readonly createdAt: number;
  readonly _version: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

// ── User CRUD Inputs ────────────────────────────────────────────

export interface CreateUserInput {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateUserInput {
  readonly displayName?: string;
  readonly email?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ListUsersOptions {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ListUsersResult {
  readonly users: readonly UserInfo[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

// ── Login Result ────────────────────────────────────────────────

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName?: string;
    readonly roles: readonly string[];
  };
}

// ── Virtual Superadmin ──────────────────────────────────────────

export const SUPERADMIN_USER_ID = '__superadmin__';
export const SUPERADMIN_USERNAME = '__superadmin__';

// ── Config ───────────────────────────────────────────────────────

export interface IdentityConfig {
  /**
   * Secret used for initial bootstrap login (identity.loginWithSecret).
   * Required for first-time setup when no users exist yet.
   */
  readonly adminSecret: string;

  /** Session token TTL in milliseconds. Default: 24 hours. */
  readonly sessionTtlMs?: number;
}

// ── System Role Names ────────────────────────────────────────────

export const SYSTEM_ROLES = ['superadmin', 'admin', 'writer', 'reader'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLES)[number];

// ── System Bucket Names ──────────────────────────────────────────

export const SYSTEM_BUCKET_NAMES = [
  '_users',
  '_roles',
  '_user_roles',
  '_acl',
  '_sessions',
  '_resource_owners',
] as const;
export type SystemBucketName = (typeof SYSTEM_BUCKET_NAMES)[number];
