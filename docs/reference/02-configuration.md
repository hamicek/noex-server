# Configuration

All configuration interfaces and their default values for `NoexServer`.

## Import

```typescript
import type {
  ServerConfig,
  AuthConfig,
  AuthSession,
  PermissionConfig,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
  ConnectionLimitsConfig,
} from '@hamicek/noex-server';
```

---

## ServerConfig

The main configuration object passed to `NoexServer.start()`.

```typescript
interface ServerConfig {
  readonly store: Store;
  readonly rules?: RuleEngine;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  readonly auth?: AuthConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly heartbeat?: HeartbeatConfig;
  readonly backpressure?: BackpressureConfig;
  readonly connectionLimits?: Partial<ConnectionLimitsConfig>;
  readonly name?: string;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| store | `Store` | *required* | Instance of `@hamicek/noex-store`. |
| rules | `RuleEngine` | — | Instance of `@hamicek/noex-rules` (optional peer dependency). |
| port | `number` | `8080` | WebSocket server port. |
| host | `string` | `'0.0.0.0'` | WebSocket server host. |
| path | `string` | `'/'` | WebSocket endpoint path. |
| maxPayloadBytes | `number` | `1_048_576` (1 MB) | Maximum incoming message size in bytes. |
| auth | `AuthConfig` | — | Authentication configuration. When omitted, auth is disabled. |
| rateLimit | `RateLimitConfig` | — | Rate limiting configuration. When omitted, rate limiting is disabled. |
| heartbeat | `HeartbeatConfig` | `{ intervalMs: 30_000, timeoutMs: 10_000 }` | Heartbeat ping/pong configuration. |
| backpressure | `BackpressureConfig` | `{ maxBufferedBytes: 1_048_576, highWaterMark: 0.8 }` | Write buffer backpressure configuration. |
| connectionLimits | `Partial<ConnectionLimitsConfig>` | `{ maxSubscriptionsPerConnection: 100 }` | Per-connection limits. |
| name | `string` | `'noex-server'` | Server name used for registry and logging. |

**Example:**

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = new Store({ buckets: { users: {} } });

const server = await NoexServer.start({
  store,
  port: 3000,
  host: '127.0.0.1',
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000 },
});
```

---

## AuthConfig

Configures token-based authentication.

```typescript
interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| validate | `(token: string) => Promise<AuthSession \| null>` | *required* | Validates a token and returns a session, or `null` if invalid. |
| required | `boolean` | `true` | Whether authentication is required. When `false`, unauthenticated clients can use all operations. |
| permissions | `PermissionConfig` | — | Permission check callback. When omitted, all authenticated users have full access. |

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      const user = await verifyJWT(token);
      if (!user) return null;
      return {
        userId: user.id,
        roles: user.roles,
        expiresAt: user.exp * 1000,
      };
    },
    permissions: {
      check: (session, operation, resource) => {
        if (session.roles.includes('admin')) return true;
        if (operation.startsWith('store.get')) return true;
        return false;
      },
    },
  },
});
```

---

## AuthSession

Returned by the `validate` callback. Represents an authenticated user session.

```typescript
interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | `string` | yes | Unique user identifier. |
| roles | `readonly string[]` | yes | User roles for permission checks. |
| metadata | `Record<string, unknown>` | no | Arbitrary metadata attached to the session. |
| expiresAt | `number` | no | Unix timestamp (ms) when the session expires. Expired sessions are rejected automatically. |

---

## PermissionConfig

Configures per-operation permission checks.

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

| Field | Type | Description |
|-------|------|-------------|
| check | `(session, operation, resource) => boolean` | Returns `true` to allow, `false` to deny. Called for every request from an authenticated client. |

The `operation` parameter is the request `type` (e.g., `"store.insert"`, `"rules.emit"`). The `resource` parameter is extracted from the request payload (typically the `bucket` field for store operations).

---

## RateLimitConfig

Configures request rate limiting using a sliding window.

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| maxRequests | `number` | Maximum requests allowed within the window. |
| windowMs | `number` | Window duration in milliseconds. |

Rate limiting is keyed by `userId` (if authenticated) or by remote IP address.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: { maxRequests: 100, windowMs: 60_000 }, // 100 req/min
});
```

---

## HeartbeatConfig

Configures the server-initiated heartbeat mechanism.

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| intervalMs | `number` | `30_000` | Interval between ping messages (ms). |
| timeoutMs | `number` | `10_000` | Maximum time to wait for a pong response (ms). If exceeded, the connection is closed with code `4001`. |

---

## BackpressureConfig

Configures write buffer backpressure detection.

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxBufferedBytes | `number` | `1_048_576` (1 MB) | Maximum write buffer size in bytes. |
| highWaterMark | `number` | `0.8` | Fraction of `maxBufferedBytes` at which push messages are dropped (0–1). |

When the WebSocket write buffer exceeds `maxBufferedBytes * highWaterMark`, push messages (subscription updates) are dropped. The client will receive the correct state on the next subscription update.

---

## ConnectionLimitsConfig

Per-connection limits.

```typescript
interface ConnectionLimitsConfig {
  readonly maxSubscriptionsPerConnection: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSubscriptionsPerConnection | `number` | `100` | Maximum number of active subscriptions (store + rules) per single connection. Exceeding this limit returns a `RATE_LIMITED` error. |

---

## Default Values Summary

| Constant | Value |
|----------|-------|
| `DEFAULT_PORT` | `8080` |
| `DEFAULT_HOST` | `'0.0.0.0'` |
| `DEFAULT_PATH` | `'/'` |
| `DEFAULT_MAX_PAYLOAD_BYTES` | `1_048_576` (1 MB) |
| `DEFAULT_NAME` | `'noex-server'` |
| `DEFAULT_HEARTBEAT.intervalMs` | `30_000` (30 s) |
| `DEFAULT_HEARTBEAT.timeoutMs` | `10_000` (10 s) |
| `DEFAULT_BACKPRESSURE.maxBufferedBytes` | `1_048_576` (1 MB) |
| `DEFAULT_BACKPRESSURE.highWaterMark` | `0.8` |
| `DEFAULT_CONNECTION_LIMITS.maxSubscriptionsPerConnection` | `100` |

---

## See Also

- [NoexServer](./01-noex-server.md) — Server class
- [Authentication](./07-authentication.md) — Auth operations and session lifecycle
- [Lifecycle](./08-lifecycle.md) — Heartbeat, backpressure, connection limits
- [Errors](./10-errors.md) — Error codes
