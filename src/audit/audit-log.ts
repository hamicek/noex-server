import type { AuditEntry, AuditConfig, AuditQuery } from './audit-types.js';
import type { OperationTier } from '../auth/operation-tiers.js';

// ── Defaults ─────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TIERS: readonly OperationTier[] = ['admin'];

// ── AuditLog ─────────────────────────────────────────────────────

export class AuditLog {
  readonly #buffer: (AuditEntry | null)[];
  readonly #maxEntries: number;
  readonly #tiers: ReadonlySet<OperationTier>;
  readonly #onEntry: ((entry: AuditEntry) => void) | null;
  #head: number;
  #size: number;

  constructor(config?: AuditConfig) {
    this.#maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#tiers = new Set(config?.tiers ?? DEFAULT_TIERS);
    this.#onEntry = config?.onEntry ?? null;
    this.#buffer = new Array<AuditEntry | null>(this.#maxEntries).fill(null);
    this.#head = 0;
    this.#size = 0;
  }

  /** Whether the given tier should be audited. */
  shouldLog(tier: OperationTier | null): boolean {
    return tier !== null && this.#tiers.has(tier);
  }

  /** Append an entry to the ring buffer. */
  append(entry: AuditEntry): void {
    this.#buffer[this.#head] = entry;
    this.#head = (this.#head + 1) % this.#maxEntries;
    if (this.#size < this.#maxEntries) this.#size++;

    if (this.#onEntry !== null) {
      this.#onEntry(entry);
    }
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this.#size;
  }

  /** Query entries with optional filters. Returns newest-first. */
  query(filter?: AuditQuery): AuditEntry[] {
    const limit = filter?.limit ?? this.#size;
    const result: AuditEntry[] = [];

    // Walk backwards from the most recent entry.
    for (let i = 0; i < this.#size && result.length < limit; i++) {
      const idx =
        (this.#head - 1 - i + this.#maxEntries) % this.#maxEntries;
      const entry = this.#buffer[idx]!;
      if (entry === null) continue;

      if (filter !== undefined && !matches(entry, filter)) continue;
      result.push(entry);
    }

    return result;
  }
}

// ── Filter matching ──────────────────────────────────────────────

function matches(entry: AuditEntry, filter: AuditQuery): boolean {
  if (filter.userId !== undefined && entry.userId !== filter.userId) {
    return false;
  }
  if (filter.operation !== undefined && entry.operation !== filter.operation) {
    return false;
  }
  if (filter.result !== undefined && entry.result !== filter.result) {
    return false;
  }
  if (filter.from !== undefined && entry.timestamp < filter.from) {
    return false;
  }
  if (filter.to !== undefined && entry.timestamp > filter.to) {
    return false;
  }
  return true;
}
