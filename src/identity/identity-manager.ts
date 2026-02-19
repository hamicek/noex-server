import type { Store } from '@hamicek/noex-store';
import type { IdentityConfig, RolePermission, RoleRecord } from './identity-types.js';
import { SYSTEM_ROLES } from './identity-types.js';
import { ensureSystemBuckets } from './system-buckets.js';

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

  private constructor(store: Store, config: IdentityConfig) {
    this.#store = store;
    this.#config = config;
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
}

// ── Helpers ──────────────────────────────────────────────────────

async function ensureSystemRoles(store: Store): Promise<void> {
  const rolesBucket = store.bucket('_roles');

  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    const existing = await rolesBucket.where({ name: def.name }) as RoleRecord[];
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
