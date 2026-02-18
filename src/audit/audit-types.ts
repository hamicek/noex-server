import type { OperationTier } from '../auth/operation-tiers.js';

// ── Audit Entry ──────────────────────────────────────────────────

export interface AuditEntry {
  readonly timestamp: number;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly operation: string;
  readonly resource: string;
  readonly result: 'success' | 'error';
  readonly error?: string;
  readonly details?: Record<string, unknown>;
  readonly remoteAddress: string;
}

// ── Audit Config ─────────────────────────────────────────────────

export interface AuditConfig {
  /** Which operation tiers to log. Default: ['admin']. */
  readonly tiers?: readonly OperationTier[];
  /** Maximum number of entries kept in memory (ring buffer). Default: 10_000. */
  readonly maxEntries?: number;
  /** Optional callback for external persistence. */
  readonly onEntry?: (entry: AuditEntry) => void;
}

// ── Audit Query ──────────────────────────────────────────────────

export interface AuditQuery {
  readonly userId?: string;
  readonly operation?: string;
  readonly result?: 'success' | 'error';
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
}
