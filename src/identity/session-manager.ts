import type { Store } from '@hamicek/noex-store';
import type { SessionRecord, SessionInfo } from './identity-types.js';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── SessionManager ──────────────────────────────────────────────

export class SessionManager {
  readonly #store: Store;
  readonly #sessionTtlMs: number;

  constructor(store: Store, sessionTtlMs?: number) {
    this.#store = store;
    this.#sessionTtlMs = sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  get sessionTtlMs(): number {
    return this.#sessionTtlMs;
  }

  async createSession(
    userId: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<SessionInfo> {
    const expiresAt = Date.now() + this.#sessionTtlMs;

    const record = (await this.#store.bucket('_sessions').insert({
      userId,
      expiresAt,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    })) as unknown as SessionRecord;

    return {
      id: record.id,
      userId: record.userId,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }

  async validateSession(token: string): Promise<SessionInfo | null> {
    const record = (await this.#store
      .bucket('_sessions')
      .get(token)) as unknown as SessionRecord | undefined;

    if (record === undefined) return null;

    if (record.expiresAt < Date.now()) {
      await this.deleteSession(token);
      return null;
    }

    return {
      id: record.id,
      userId: record.userId,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }

  async deleteSession(token: string): Promise<void> {
    try {
      await this.#store.bucket('_sessions').delete(token);
    } catch {
      // Already deleted or not found — safe to ignore
    }
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const sessions = (await this.#store
      .bucket('_sessions')
      .where({ userId })) as unknown as SessionRecord[];

    for (const session of sessions) {
      await this.#store.bucket('_sessions').delete(session.id);
    }
  }
}
