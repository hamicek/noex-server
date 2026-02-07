// ── Main ─────────────────────────────────────────────────────────

export { NoexServer } from './server.js';
export type { ServerStats } from './server.js';
export type { ConnectionInfo, ConnectionMetadata } from './connection/connection-registry.js';

// ── Configuration ────────────────────────────────────────────────

export type {
  ServerConfig,
  AuthConfig,
  AuthSession,
  PermissionConfig,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
} from './config.js';

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
