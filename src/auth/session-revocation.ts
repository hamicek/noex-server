// ── Session Revocation ──────────────────────────────────────────
//
// In-memory blacklist of revoked user sessions.
// Revoked users cannot re-authenticate until the TTL expires.

const DEFAULT_BLACKLIST_TTL_MS = 3_600_000; // 1 hour

export interface RevocationConfig {
  /** How long a revoked userId remains blocked. Default: 3,600,000 ms (1 hour). */
  readonly blacklistTtlMs?: number;
}

export interface RevokedEntry {
  readonly userId: string;
  readonly revokedAt: number;
  readonly expiresAt: number;
}

export class SessionBlacklist {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, RevokedEntry>();

  constructor(config?: RevocationConfig) {
    this.#ttlMs = config?.blacklistTtlMs ?? DEFAULT_BLACKLIST_TTL_MS;
  }

  /** Adds a userId to the blacklist. */
  revoke(userId: string): void {
    const now = Date.now();
    this.#entries.set(userId, {
      userId,
      revokedAt: now,
      expiresAt: now + this.#ttlMs,
    });
  }

  /** Returns true if the userId is currently blacklisted (TTL not expired). */
  isRevoked(userId: string): boolean {
    const entry = this.#entries.get(userId);
    if (entry === undefined) return false;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(userId);
      return false;
    }
    return true;
  }

  /** Removes a userId from the blacklist. Returns true if it was present. */
  unrevoke(userId: string): boolean {
    return this.#entries.delete(userId);
  }

  /** Removes all expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [userId, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(userId);
      }
    }
  }

  /** Number of blacklisted entries (including potentially expired ones). */
  get size(): number {
    return this.#entries.size;
  }
}
