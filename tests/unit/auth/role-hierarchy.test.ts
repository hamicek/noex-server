import { describe, it, expect } from 'vitest';
import { hasAccessForTier, isBuiltinRole } from '../../../src/auth/role-hierarchy.js';

describe('role-hierarchy', () => {
  describe('hasAccessForTier', () => {
    // ── Admin role ────────────────────────────────────────────────

    it('admin can access all tiers', () => {
      const roles = ['admin'] as const;
      expect(hasAccessForTier(roles, 'admin')).toBe(true);
      expect(hasAccessForTier(roles, 'write')).toBe(true);
      expect(hasAccessForTier(roles, 'read')).toBe(true);
    });

    // ── Writer role ───────────────────────────────────────────────

    it('writer can access write and read tiers', () => {
      const roles = ['writer'] as const;
      expect(hasAccessForTier(roles, 'admin')).toBe(false);
      expect(hasAccessForTier(roles, 'write')).toBe(true);
      expect(hasAccessForTier(roles, 'read')).toBe(true);
    });

    // ── Reader role ───────────────────────────────────────────────

    it('reader can only access read tier', () => {
      const roles = ['reader'] as const;
      expect(hasAccessForTier(roles, 'admin')).toBe(false);
      expect(hasAccessForTier(roles, 'write')).toBe(false);
      expect(hasAccessForTier(roles, 'read')).toBe(true);
    });

    // ── Multiple built-in roles ───────────────────────────────────

    it('uses the highest built-in role level', () => {
      expect(hasAccessForTier(['reader', 'writer'], 'write')).toBe(true);
      expect(hasAccessForTier(['reader', 'admin'], 'admin')).toBe(true);
      expect(hasAccessForTier(['writer', 'reader'], 'admin')).toBe(false);
    });

    // ── Custom roles bypass tier check ────────────────────────────

    it('returns true for all tiers when session has no built-in roles', () => {
      const roles = ['user'] as const;
      expect(hasAccessForTier(roles, 'admin')).toBe(true);
      expect(hasAccessForTier(roles, 'write')).toBe(true);
      expect(hasAccessForTier(roles, 'read')).toBe(true);
    });

    it('returns true for all tiers with multiple custom roles', () => {
      const roles = ['editor', 'moderator'] as const;
      expect(hasAccessForTier(roles, 'admin')).toBe(true);
      expect(hasAccessForTier(roles, 'write')).toBe(true);
      expect(hasAccessForTier(roles, 'read')).toBe(true);
    });

    it('returns true for empty roles array', () => {
      expect(hasAccessForTier([], 'admin')).toBe(true);
      expect(hasAccessForTier([], 'write')).toBe(true);
      expect(hasAccessForTier([], 'read')).toBe(true);
    });

    // ── Mixed built-in + custom roles ─────────────────────────────

    it('applies tier check when at least one built-in role is present', () => {
      expect(hasAccessForTier(['user', 'reader'], 'write')).toBe(false);
      expect(hasAccessForTier(['user', 'reader'], 'read')).toBe(true);
      expect(hasAccessForTier(['editor', 'writer'], 'admin')).toBe(false);
      expect(hasAccessForTier(['editor', 'writer'], 'write')).toBe(true);
    });
  });

  describe('isBuiltinRole', () => {
    it('returns true for admin, writer, reader', () => {
      expect(isBuiltinRole('admin')).toBe(true);
      expect(isBuiltinRole('writer')).toBe(true);
      expect(isBuiltinRole('reader')).toBe(true);
    });

    it('returns false for custom roles', () => {
      expect(isBuiltinRole('user')).toBe(false);
      expect(isBuiltinRole('editor')).toBe(false);
      expect(isBuiltinRole('moderator')).toBe(false);
      expect(isBuiltinRole('')).toBe(false);
    });
  });
});
