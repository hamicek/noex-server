import type { RateLimiterRef } from '@hamicek/noex';
import type { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';

// ── Auth ──────────────────────────────────────────────────────────

export interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}

export interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}

export interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  /** Whether authentication is required. Default: true when auth is configured. */
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
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
  readonly auth?: AuthConfig;

  /** Rate limiting configuration. When omitted, rate limiting is disabled. */
  readonly rateLimit?: RateLimitConfig;

  /** Heartbeat ping/pong configuration. Default: 30 s interval, 10 s timeout. */
  readonly heartbeat?: HeartbeatConfig;

  /** Write buffer backpressure configuration. Default: 1 MB limit, 0.8 high water mark. */
  readonly backpressure?: BackpressureConfig;

  /** Server name used for registry and logging. Default: 'noex-server'. */
  readonly name?: string;
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
  readonly heartbeat: HeartbeatConfig;
  readonly backpressure: BackpressureConfig;
  readonly name: string;
}

// ── Resolve ───────────────────────────────────────────────────────

export function resolveConfig(config: ServerConfig): ResolvedServerConfig {
  return {
    store: config.store,
    rules: config.rules ?? null,
    port: config.port ?? DEFAULT_PORT,
    host: config.host ?? DEFAULT_HOST,
    path: config.path ?? DEFAULT_PATH,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    auth: config.auth ?? null,
    rateLimit: config.rateLimit ?? null,
    rateLimiterRef: null,
    heartbeat: config.heartbeat ?? DEFAULT_HEARTBEAT,
    backpressure: config.backpressure ?? DEFAULT_BACKPRESSURE,
    name: config.name ?? DEFAULT_NAME,
  };
}
