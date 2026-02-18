import type { OperationTier } from './operation-tiers.js';

// ── Role Hierarchy ───────────────────────────────────────────────
//
//   admin  → admin + write + read
//   writer → write + read
//   reader → read only
//
// Sessions that contain NONE of these built-in roles bypass the
// tier check entirely — they rely on the custom `check` function
// for access control. This preserves backward compatibility with
// setups that use custom role names.

const TIER_LEVELS: Record<OperationTier, number> = {
  read:  0,
  write: 1,
  admin: 2,
};

const ROLE_LEVELS: Record<string, number> = {
  reader: 0,
  writer: 1,
  admin:  2,
};

const BUILTIN_ROLES = ['admin', 'writer', 'reader'];

/**
 * Checks whether a session's roles grant access to the given tier.
 *
 * Returns `true` when:
 * - The session contains no built-in roles (tier check not applicable).
 * - The session's highest built-in role level ≥ the required tier level.
 */
export function hasAccessForTier(
  roles: readonly string[],
  tier: OperationTier,
): boolean {
  const maxLevel = highestRoleLevel(roles);

  // No built-in roles → tier check does not apply
  if (maxLevel === -1) return true;

  return maxLevel >= TIER_LEVELS[tier];
}

function highestRoleLevel(roles: readonly string[]): number {
  let max = -1;
  for (const role of roles) {
    if (role in ROLE_LEVELS && ROLE_LEVELS[role] > max) {
      max = ROLE_LEVELS[role];
    }
  }
  return max;
}

/**
 * Returns `true` when the role is one of the built-in tier roles.
 */
export function isBuiltinRole(role: string): boolean {
  return BUILTIN_ROLES.includes(role);
}
