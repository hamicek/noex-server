import type { Store } from '@hamicek/noex-store';
import type {
  RoleRecord,
  UserRoleRecord,
  AclRecord,
  ResourceOwnerRecord,
} from './identity-types.js';
import { SUPERADMIN_USER_ID } from './identity-types.js';

// ── IdentityCache ────────────────────────────────────────────────
//
// In-memory cache of all identity data for fast, synchronous
// permission checks. Loaded from system buckets on start and
// kept up-to-date via store event subscriptions.

const EMPTY_STRING_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

export class IdentityCache {
  readonly #store: Store;

  // roleId → RoleRecord
  #roles = new Map<string, RoleRecord>();

  // roleName → roleId
  #rolesByName = new Map<string, string>();

  // userId → Set<roleId>
  #userRoles = new Map<string, Set<string>>();

  // `${subjectType}:${subjectId}:${resourceType}:${resourceName}` → operations[]
  #acl = new Map<string, readonly string[]>();

  // `${userId}:${resourceType}:${resourceName}` → true
  #ownership = new Map<string, true>();

  readonly #unsubscribers: Array<() => Promise<void>> = [];

  private constructor(store: Store) {
    this.#store = store;
  }

  /**
   * Creates and initializes an IdentityCache.
   *
   * 1. Loads all data from system buckets.
   * 2. Subscribes to bucket events for cache invalidation.
   */
  static async start(store: Store): Promise<IdentityCache> {
    const cache = new IdentityCache(store);
    await cache.#loadAll();
    await cache.#subscribeToChanges();
    return cache;
  }

  /** Unsubscribes from all store events. */
  async stop(): Promise<void> {
    for (const unsub of this.#unsubscribers) {
      await unsub();
    }
    this.#unsubscribers.length = 0;
  }

  // ── Query Methods ──────────────────────────────────────────────

  /** Returns the set of roleIds assigned to a user. */
  getUserRoleIds(userId: string): ReadonlySet<string> {
    return this.#userRoles.get(userId) ?? EMPTY_STRING_SET;
  }

  /** Returns role names for a user. Superadmin always returns ['superadmin']. */
  getUserRoleNames(userId: string): string[] {
    if (userId === SUPERADMIN_USER_ID) return ['superadmin'];

    const roleIds = this.#userRoles.get(userId);
    if (roleIds === undefined || roleIds.size === 0) return [];

    const names: string[] = [];
    for (const roleId of roleIds) {
      const role = this.#roles.get(roleId);
      if (role !== undefined) names.push(role.name);
    }
    return names;
  }

  /** Returns full RoleRecord objects for a user's assigned roles. */
  getUserRoles(userId: string): RoleRecord[] {
    if (userId === SUPERADMIN_USER_ID) {
      const sa = this.getRoleByName('superadmin');
      return sa !== undefined ? [sa] : [];
    }

    const roleIds = this.#userRoles.get(userId);
    if (roleIds === undefined || roleIds.size === 0) return [];

    const result: RoleRecord[] = [];
    for (const roleId of roleIds) {
      const role = this.#roles.get(roleId);
      if (role !== undefined) result.push(role);
    }
    return result;
  }

  /** Looks up a role by ID. */
  getRole(roleId: string): RoleRecord | undefined {
    return this.#roles.get(roleId);
  }

  /** Looks up a role by name. */
  getRoleByName(name: string): RoleRecord | undefined {
    const id = this.#rolesByName.get(name);
    return id !== undefined ? this.#roles.get(id) : undefined;
  }

  /** Returns ACL operations for a specific user on a resource, or null. */
  getUserAcl(
    userId: string,
    resourceType: string,
    resourceName: string,
  ): readonly string[] | null {
    return this.#acl.get(`user:${userId}:${resourceType}:${resourceName}`) ?? null;
  }

  /** Returns ACL operations for a specific role on a resource, or null. */
  getRoleAcl(
    roleId: string,
    resourceType: string,
    resourceName: string,
  ): readonly string[] | null {
    return this.#acl.get(`role:${roleId}:${resourceType}:${resourceName}`) ?? null;
  }

  /** Checks whether a user is the owner of a resource. */
  isOwner(
    userId: string,
    resourceType: string,
    resourceName: string,
  ): boolean {
    return this.#ownership.has(`${userId}:${resourceType}:${resourceName}`);
  }

  // ── Load ───────────────────────────────────────────────────────

  async #loadAll(): Promise<void> {
    await Promise.all([
      this.#loadRoles(),
      this.#loadUserRoles(),
      this.#loadAcl(),
      this.#loadOwnership(),
    ]);
  }

  async #loadRoles(): Promise<void> {
    const roles = new Map<string, RoleRecord>();
    const rolesByName = new Map<string, string>();
    const records = (await this.#store
      .bucket('_roles')
      .all()) as unknown as RoleRecord[];

    for (const r of records) {
      roles.set(r.id, r);
      rolesByName.set(r.name, r.id);
    }

    // Atomic swap — avoids empty state during reload
    this.#roles = roles;
    this.#rolesByName = rolesByName;
  }

  async #loadUserRoles(): Promise<void> {
    const userRoles = new Map<string, Set<string>>();
    const records = (await this.#store
      .bucket('_user_roles')
      .all()) as unknown as UserRoleRecord[];

    for (const ur of records) {
      let set = userRoles.get(ur.userId);
      if (set === undefined) {
        set = new Set();
        userRoles.set(ur.userId, set);
      }
      set.add(ur.roleId);
    }

    this.#userRoles = userRoles;
  }

  async #loadAcl(): Promise<void> {
    const acl = new Map<string, readonly string[]>();
    const records = (await this.#store
      .bucket('_acl')
      .all()) as unknown as AclRecord[];

    for (const r of records) {
      const key = `${r.subjectType}:${r.subjectId}:${r.resourceType}:${r.resourceName}`;
      acl.set(key, r.operations);
    }

    this.#acl = acl;
  }

  async #loadOwnership(): Promise<void> {
    const ownership = new Map<string, true>();
    const records = (await this.#store
      .bucket('_resource_owners')
      .all()) as unknown as ResourceOwnerRecord[];

    for (const r of records) {
      ownership.set(`${r.userId}:${r.resourceType}:${r.resourceName}`, true);
    }

    this.#ownership = ownership;
  }

  // ── Subscribe for Invalidation ─────────────────────────────────

  async #subscribeToChanges(): Promise<void> {
    this.#unsubscribers.push(
      await this.#store.on('bucket._roles.*', () => {
        void this.#loadRoles();
      }),
      await this.#store.on('bucket._user_roles.*', () => {
        void this.#loadUserRoles();
      }),
      await this.#store.on('bucket._acl.*', () => {
        void this.#loadAcl();
      }),
      await this.#store.on('bucket._resource_owners.*', () => {
        void this.#loadOwnership();
      }),
    );
  }
}
