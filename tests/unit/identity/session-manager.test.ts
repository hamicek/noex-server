import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '@hamicek/noex-store';
import { IdentityManager } from '../../../src/identity/identity-manager.js';
import { SessionManager } from '../../../src/identity/session-manager.js';
import type { SessionRecord } from '../../../src/identity/identity-types.js';

describe('SessionManager', () => {
  let store: Store;
  let manager: IdentityManager;
  let sessions: SessionManager;
  let storeCounter = 0;

  beforeEach(async () => {
    store = await Store.start({ name: `session-mgr-test-${++storeCounter}` });
    // IdentityManager creates system buckets including _sessions
    manager = await IdentityManager.start(store, {
      adminSecret: 'test-secret',
    });
    sessions = new SessionManager(store);
  });

  afterEach(async () => {
    await manager.stop();
    await store.stop();
  });

  // ── createSession ─────────────────────────────────────────────

  describe('createSession', () => {
    it('creates a session with correct userId', async () => {
      const session = await sessions.createSession('user-123');

      expect(session.userId).toBe('user-123');
      expect(typeof session.id).toBe('string');
      expect(session.id.length).toBeGreaterThan(0);
    });

    it('sets expiresAt based on TTL', async () => {
      const before = Date.now();
      const session = await sessions.createSession('user-123');
      const after = Date.now();

      const expectedMin = before + 24 * 60 * 60 * 1000;
      const expectedMax = after + 24 * 60 * 60 * 1000;

      expect(session.expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(session.expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('uses custom TTL', async () => {
      const customSessions = new SessionManager(store, 60_000); // 1 minute
      const before = Date.now();
      const session = await customSessions.createSession('user-123');

      expect(session.expiresAt).toBeLessThanOrEqual(before + 60_000 + 100);
      expect(session.expiresAt).toBeGreaterThanOrEqual(before + 60_000 - 100);
    });

    it('sets createdAt timestamp', async () => {
      const before = Date.now();
      const session = await sessions.createSession('user-123');

      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('stores session in _sessions bucket', async () => {
      const session = await sessions.createSession('user-123');

      const record = (await store
        .bucket('_sessions')
        .get(session.id)) as unknown as SessionRecord;

      expect(record).toBeDefined();
      expect(record.userId).toBe('user-123');
    });

    it('stores metadata (ip, userAgent)', async () => {
      const session = await sessions.createSession('user-123', {
        ip: '192.168.1.1',
        userAgent: 'TestClient/1.0',
      });

      const record = (await store
        .bucket('_sessions')
        .get(session.id)) as unknown as SessionRecord;

      expect(record.ip).toBe('192.168.1.1');
      expect(record.userAgent).toBe('TestClient/1.0');
    });

    it('generates unique session IDs', async () => {
      const s1 = await sessions.createSession('user-1');
      const s2 = await sessions.createSession('user-1');

      expect(s1.id).not.toBe(s2.id);
    });
  });

  // ── validateSession ───────────────────────────────────────────

  describe('validateSession', () => {
    it('returns session info for valid token', async () => {
      const created = await sessions.createSession('user-123');
      const validated = await sessions.validateSession(created.id);

      expect(validated).not.toBeNull();
      expect(validated!.id).toBe(created.id);
      expect(validated!.userId).toBe('user-123');
      expect(validated!.expiresAt).toBe(created.expiresAt);
    });

    it('returns null for non-existent token', async () => {
      const result = await sessions.validateSession('non-existent-token');
      expect(result).toBeNull();
    });

    it('returns null and deletes expired session', async () => {
      const shortLived = new SessionManager(store, 1); // 1ms TTL
      const session = await shortLived.createSession('user-123');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortLived.validateSession(session.id);
      expect(result).toBeNull();

      // Session should be deleted from store
      const record = await store.bucket('_sessions').get(session.id);
      expect(record).toBeUndefined();
    });
  });

  // ── deleteSession ─────────────────────────────────────────────

  describe('deleteSession', () => {
    it('deletes an existing session', async () => {
      const session = await sessions.createSession('user-123');

      await sessions.deleteSession(session.id);

      const result = await sessions.validateSession(session.id);
      expect(result).toBeNull();
    });

    it('does not throw for non-existent session', async () => {
      await expect(
        sessions.deleteSession('non-existent'),
      ).resolves.toBeUndefined();
    });
  });

  // ── deleteUserSessions ────────────────────────────────────────

  describe('deleteUserSessions', () => {
    it('deletes all sessions for a user', async () => {
      const s1 = await sessions.createSession('user-123');
      const s2 = await sessions.createSession('user-123');
      const s3 = await sessions.createSession('user-456');

      await sessions.deleteUserSessions('user-123');

      expect(await sessions.validateSession(s1.id)).toBeNull();
      expect(await sessions.validateSession(s2.id)).toBeNull();
      expect(await sessions.validateSession(s3.id)).not.toBeNull();
    });

    it('does nothing when user has no sessions', async () => {
      await expect(
        sessions.deleteUserSessions('no-sessions-user'),
      ).resolves.toBeUndefined();
    });
  });

  // ── sessionTtlMs ──────────────────────────────────────────────

  describe('sessionTtlMs', () => {
    it('returns default TTL (24h)', () => {
      expect(sessions.sessionTtlMs).toBe(24 * 60 * 60 * 1000);
    });

    it('returns custom TTL', () => {
      const custom = new SessionManager(store, 3600_000);
      expect(custom.sessionTtlMs).toBe(3600_000);
    });
  });
});
