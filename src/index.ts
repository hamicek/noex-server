// ── Main ─────────────────────────────────────────────────────────

export { NoexServer } from './server.js';
export type { ServerStats, ConnectionsStats } from './server.js';
export type { ConnectionInfo, ConnectionMetadata } from './connection/connection-registry.js';

// ── Configuration ────────────────────────────────────────────────

export type {
  ServerConfig,
  AuthConfig,
  AuthSession,
  PermissionConfig,
  PermissionRule,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
  ConnectionLimitsConfig,
  AuditConfig,
  AuditEntry,
  AuditQuery,
  RevocationConfig,
  RevokedEntry,
} from './config.js';

// ── Auth ─────────────────────────────────────────────────────────

export type { OperationTier } from './auth/operation-tiers.js';
export { getOperationTier } from './auth/operation-tiers.js';
export { hasAccessForTier, isBuiltinRole } from './auth/role-hierarchy.js';

// ── Errors ───────────────────────────────────────────────────────

export { NoexServerError } from './errors.js';
export { ErrorCode } from './protocol/codes.js';

// ── Protocol types (for client implementations) ──────────────────

export type {
  ClientRequest,
  SuccessResponse,
  ErrorResponse,
  PushMessage,
  WelcomeMessage,
  HeartbeatPing,
  HeartbeatPong,
  SystemMessage,
  ServerMessage,
  ClientMessage,
} from './protocol/types.js';
export { PROTOCOL_VERSION } from './protocol/types.js';
