// ── Operation Tiers ──────────────────────────────────────────────
//
// Every protocol operation belongs to one of three tiers:
//   admin  – structural changes (bucket/query/rule/procedure management)
//   write  – data mutations (insert, update, delete, emit, transactions)
//   read   – data reads (get, where, subscribe, stats)
//
// The tier determines the minimum role level required to execute the
// operation. See role-hierarchy.ts for the role → tier resolution.

export type OperationTier = 'admin' | 'write' | 'read';

const OPERATION_TIERS: Record<string, OperationTier> = {
  // ── ADMIN tier ─────────────────────────────────────────────────
  // Bucket management (Phase 2)
  'store.defineBucket':    'admin',
  'store.dropBucket':      'admin',
  'store.updateBucket':    'admin',
  'store.getBucketSchema': 'admin',

  // Query management (Phase 4)
  'store.defineQuery':     'admin',
  'store.undefineQuery':   'admin',
  'store.listQueries':     'admin',

  // Rule management (Phase 3)
  'rules.registerRule':    'admin',
  'rules.unregisterRule':  'admin',
  'rules.updateRule':      'admin',
  'rules.enableRule':      'admin',
  'rules.disableRule':     'admin',
  'rules.getRule':         'admin',
  'rules.getRules':        'admin',

  // Procedure management (Phase 5)
  'procedures.register':   'admin',
  'procedures.unregister': 'admin',
  'procedures.update':     'admin',
  'procedures.list':       'admin',

  // Server management
  'server.stats':          'admin',
  'server.connections':    'admin',
  'audit.query':           'admin',

  // ── WRITE tier ─────────────────────────────────────────────────
  'store.insert':          'write',
  'store.update':          'write',
  'store.delete':          'write',
  'store.clear':           'write',
  'store.transaction':     'write',
  'rules.emit':            'write',
  'rules.setFact':         'write',
  'rules.deleteFact':      'write',
  'procedures.call':       'write',

  // ── READ tier ──────────────────────────────────────────────────
  'store.get':             'read',
  'store.all':             'read',
  'store.where':           'read',
  'store.findOne':         'read',
  'store.count':           'read',
  'store.first':           'read',
  'store.last':            'read',
  'store.paginate':        'read',
  'store.sum':             'read',
  'store.avg':             'read',
  'store.min':             'read',
  'store.max':             'read',
  'store.subscribe':       'read',
  'store.unsubscribe':     'read',
  'store.buckets':         'read',
  'store.stats':           'read',
  'rules.getFact':         'read',
  'rules.queryFacts':      'read',
  'rules.getAllFacts':      'read',
  'rules.subscribe':       'read',
  'rules.unsubscribe':     'read',
  'rules.stats':           'read',
  'procedures.get':        'read',
};

/**
 * Returns the tier for a known operation, or `null` for operations
 * not in the tier map (e.g. `auth.login`, `ping`).
 */
export function getOperationTier(operation: string): OperationTier | null {
  return OPERATION_TIERS[operation] ?? null;
}
