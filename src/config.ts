import type { RateLimiterRef } from '@hamicek/noex';
import type { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';
import type { ConnectionRegistry } from './connection/connection-registry.js';
import type { AuditLog } from './audit/audit-log.js';
import type { SessionBlacklist } from './auth/session-revocation.js';
import type { ProcedureEngine } from './procedures/procedure-engine.js';
import type { IdentityManager } from './identity/identity-manager.js';

import type { AuditConfig } from './audit/audit-types.js';
import type { ProceduresConfig } from './procedures/procedure-types.js';

export type { AuditEntry, AuditConfig, AuditQuery } from './audit/audit-types.js';
export type { RevocationConfig, RevokedEntry } from './auth/session-revocation.js';
export type { ProceduresConfig } from './procedures/procedure-types.js';

// ── Auth ──────────────────────────────────────────────────────────

export interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}

export interface PermissionRule {
  /** Role this rule applies to. */
  readonly role: string;
  /** Allowed operations — exact string, wildcard pattern, or array of patterns. */
  readonly allow: string | readonly string[];
  /** Restrict to specific store buckets (only checked for store.* operations). */
  readonly buckets?: readonly string[];
  /** Restrict to specific rules topics (only checked for rules.* operations). */
  readonly topics?: readonly string[];
}

export interface PermissionConfig {
  /** Default behavior when no rule matches. Default: 'allow'. */
  readonly default?: 'allow' | 'deny';
  /** Declarative permission rules (evaluated in order, first match wins). */
  readonly rules?: readonly PermissionRule[];
  /**
   * Custom check function (overrides declarative rules).
   * Return true to allow, false to deny, undefined to fall through to rules.
   */
  readonly check?: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean | undefined;
}

export interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  /** Whether authentication is required. Default: true when auth is configured. */
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}

export interface BuiltInAuthConfig {
  /** Discriminant — activates built-in identity management. */
  readonly builtIn: true;
  /** Secret for bootstrap login (identity.loginWithSecret). */
  readonly adminSecret: string;
  /** Session TTL in milliseconds. Default: 24 hours. */
  readonly sessionTtl?: number;
  /** Minimum password length. Default: 8. */
  readonly passwordMinLength?: number;
  /** Maximum sessions per user. Default: 10. */
  readonly maxSessionsPerUser?: number;
  /** Login rate limiting (brute-force protection). Enabled by default. */
  readonly loginRateLimit?: {
    /** Maximum failed attempts before lockout. Default: 5. */
    readonly maxAttempts?: number;
    /** Time window in milliseconds. Default: 15 minutes. */
    readonly windowMs?: number;
  };
}

export function isBuiltInAuth(
  auth: AuthConfig | BuiltInAuthConfig,
): auth is BuiltInAuthConfig {
  return 'builtIn' in auth && (auth as BuiltInAuthConfig).builtIn === true;
}

// ── Sub-configs ───────────────────────────────────────────────────

export interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}

export interface ConnectionLimitsConfig {
  /** Maximum number of active subscriptions per single connection. Default: 100. */
  readonly maxSubscriptionsPerConnection: number;
}

// ── Defaults ──────────────────────────────────────────────────────

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PATH = '/';
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB
export const DEFAULT_NAME = 'noex-server';

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  intervalMs: 30_000,
  timeoutMs: 10_000,
};

export const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxBufferedBytes: 1_048_576, // 1 MB
  highWaterMark: 0.8,
};

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimitsConfig = {
  maxSubscriptionsPerConnection: 100,
};

// ── Server Config (user-facing) ──────────────────────────────────

export interface ServerConfig {
  /** Instance of @hamicek/noex-store (required). */
  readonly store: Store;

  /** Instance of @hamicek/noex-rules (optional peer dependency). */
  readonly rules?: RuleEngine;

  /** WebSocket server port. Default: 8080. */
  readonly port?: number;

  /** WebSocket server host. Default: '0.0.0.0'. */
  readonly host?: string;

  /** WebSocket endpoint path. Default: '/'. */
  readonly path?: string;

  /** Maximum incoming message size in bytes. Default: 1 MB. */
  readonly maxPayloadBytes?: number;

  /** Authentication configuration. When omitted, auth is disabled. */
  readonly auth?: AuthConfig | BuiltInAuthConfig;

  /** Rate limiting configuration. When omitted, rate limiting is disabled. */
  readonly rateLimit?: RateLimitConfig;

  /** Heartbeat ping/pong configuration. Default: 30 s interval, 10 s timeout. */
  readonly heartbeat?: HeartbeatConfig;

  /** Write buffer backpressure configuration. Default: 1 MB limit, 0.8 high water mark. */
  readonly backpressure?: BackpressureConfig;

  /** Per-connection limits. */
  readonly connectionLimits?: Partial<ConnectionLimitsConfig>;

  /** Audit log configuration. When omitted, audit logging is disabled. */
  readonly audit?: AuditConfig;

  /** Session revocation configuration. Requires auth to be configured. */
  readonly revocation?: import('./auth/session-revocation.js').RevocationConfig;

  /** Procedures engine configuration. When omitted, procedures are disabled. */
  readonly procedures?: ProceduresConfig;

  /** Server name used for registry and logging. Default: 'noex-server'. */
  readonly name?: string;

  /**
   * Allowed origins for WebSocket connections. When set, the server validates
   * the Origin header during the HTTP upgrade and rejects connections from
   * unknown origins with 403 Forbidden.
   *
   * Connections without an Origin header (e.g. server-to-server) are always
   * allowed. When undefined, origin validation is disabled (suitable for dev).
   */
  readonly allowedOrigins?: readonly string[];
}

// ── Resolved Config (all defaults applied) ────────────────────────

export interface ResolvedServerConfig {
  readonly store: Store;
  readonly rules: RuleEngine | null;
  readonly port: number;
  readonly host: string;
  readonly path: string;
  readonly maxPayloadBytes: number;
  readonly auth: AuthConfig | null;
  readonly rateLimit: RateLimitConfig | null;
  readonly rateLimiterRef: RateLimiterRef | null;
  readonly connectionRegistry: ConnectionRegistry;
  readonly heartbeat: HeartbeatConfig;
  readonly backpressure: BackpressureConfig;
  readonly connectionLimits: ConnectionLimitsConfig;
  readonly auditLog: AuditLog | null;
  readonly blacklist: SessionBlacklist | null;
  readonly procedureEngine: ProcedureEngine | null;
  readonly identityManager: IdentityManager | null;
  readonly name: string;
  readonly allowedOrigins: readonly string[] | null;
}

// ── Resolve ───────────────────────────────────────────────────────

export function resolveConfig(config: ServerConfig): ResolvedServerConfig {
  // Built-in auth config is resolved separately in server.ts (needs IdentityManager),
  // so we only pass through external AuthConfig here.
  const auth =
    config.auth !== undefined && !isBuiltInAuth(config.auth)
      ? config.auth
      : null;

  return {
    store: config.store,
    rules: config.rules ?? null,
    port: config.port ?? DEFAULT_PORT,
    host: config.host ?? DEFAULT_HOST,
    path: config.path ?? DEFAULT_PATH,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    auth,
    rateLimit: config.rateLimit ?? null,
    rateLimiterRef: null,
    connectionRegistry: null as unknown as ConnectionRegistry,
    heartbeat: config.heartbeat ?? DEFAULT_HEARTBEAT,
    backpressure: config.backpressure ?? DEFAULT_BACKPRESSURE,
    connectionLimits: {
      ...DEFAULT_CONNECTION_LIMITS,
      ...config.connectionLimits,
    },
    auditLog: null,
    blacklist: null,
    procedureEngine: null,
    identityManager: null,
    name: config.name ?? DEFAULT_NAME,
    allowedOrigins: config.allowedOrigins ?? null,
  };
}
