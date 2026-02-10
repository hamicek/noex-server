# Configuration

noex-server is configured through a single `ServerConfig` object passed to `NoexServer.start()`. This chapter documents every field, its default value, and when you'd change it.

## What You'll Learn

- Every field in `ServerConfig`
- Default values and what they mean
- How optional features (auth, rate limiting, heartbeat, backpressure) are enabled
- The difference between user-facing config and resolved config

## ServerConfig Reference

```typescript
interface ServerConfig {
  store: Store;                        // required
  rules?: RuleEngine;                  // optional
  port?: number;                       // default: 8080
  host?: string;                       // default: '0.0.0.0'
  path?: string;                       // default: '/'
  maxPayloadBytes?: number;            // default: 1_048_576 (1 MB)
  auth?: AuthConfig;                   // default: disabled
  rateLimit?: RateLimitConfig;         // default: disabled
  heartbeat?: HeartbeatConfig;         // default: { intervalMs: 30000, timeoutMs: 10000 }
  backpressure?: BackpressureConfig;   // default: { maxBufferedBytes: 1048576, highWaterMark: 0.8 }
  connectionLimits?: Partial<ConnectionLimitsConfig>;  // default: { maxSubscriptionsPerConnection: 100 }
  name?: string;                       // default: 'noex-server'
}
```

## Core Fields

### `store` (required)

The noex-store instance. This is the only required field. The server proxies all `store.*` operations to this instance.

```typescript
const store = await Store.start({ name: 'my-store' });
const server = await NoexServer.start({ store });
```

### `rules` (optional)

A noex-rules `RuleEngine` instance. When provided, the server enables `rules.*` operations. When omitted, any `rules.*` request returns `RULES_NOT_AVAILABLE`.

```typescript
import { RuleEngine } from '@hamicek/noex-rules';

const engine = await RuleEngine.start({ name: 'my-rules' });
const server = await NoexServer.start({ store, rules: engine });
```

### `port`

**Default: `8080`**

The TCP port to listen on. Use `0` for a random available port — the actual port is available via `server.port` after startup:

```typescript
const server = await NoexServer.start({ store, port: 0 });
console.log(server.port); // e.g., 54321
```

### `host`

**Default: `'0.0.0.0'`**

The network interface to bind to. `'0.0.0.0'` listens on all interfaces. Use `'127.0.0.1'` for local-only access (recommended for tests).

### `path`

**Default: `'/'`**

The WebSocket endpoint path. Clients connect to `ws://host:port/path`.

### `maxPayloadBytes`

**Default: `1_048_576` (1 MB)**

Maximum size of an incoming WebSocket message. Messages exceeding this limit are rejected.

### `name`

**Default: `'noex-server'`**

Server name used for registry and logging.

## Auth Configuration

When `auth` is provided, authentication is enabled. When omitted, all operations are allowed without authentication.

```typescript
interface AuthConfig {
  validate: (token: string) => Promise<AuthSession | null>;
  required?: boolean;     // default: true (when auth is configured)
  permissions?: PermissionConfig;
}

interface AuthSession {
  userId: string;
  roles: readonly string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;     // Unix timestamp in milliseconds
}

interface PermissionConfig {
  check: (session: AuthSession, operation: string, resource: string) => boolean;
}
```

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      // Your token verification logic
      if (token === 'valid-token') {
        return { userId: 'user-1', roles: ['admin'] };
      }
      return null; // Invalid token
    },
    permissions: {
      check: (session, operation) => {
        if (operation === 'store.clear') {
          return session.roles.includes('admin');
        }
        return true;
      },
    },
  },
});
```

## Rate Limit Configuration

When provided, enables per-connection rate limiting using a sliding window algorithm.

```typescript
interface RateLimitConfig {
  maxRequests: number;   // requests per window
  windowMs: number;      // sliding window duration in ms
}
```

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: {
    maxRequests: 200,
    windowMs: 60_000, // 200 requests per minute
  },
});
```

The rate limit key is `session.userId` for authenticated connections, or the remote IP address for anonymous connections.

## Heartbeat Configuration

Always enabled with configurable timing.

```typescript
interface HeartbeatConfig {
  intervalMs: number;   // default: 30_000 (30 seconds)
  timeoutMs: number;    // default: 10_000 (10 seconds)
}
```

The server sends a `ping` message every `intervalMs`. If no `pong` is received within `timeoutMs`, the connection is closed with WebSocket close code `4001`.

## Backpressure Configuration

Always enabled with configurable thresholds.

```typescript
interface BackpressureConfig {
  maxBufferedBytes: number;   // default: 1_048_576 (1 MB)
  highWaterMark: number;      // default: 0.8 (80%)
}
```

When the WebSocket write buffer exceeds `maxBufferedBytes × highWaterMark`, push messages are paused to prevent memory exhaustion on slow clients.

## Connection Limits

```typescript
interface ConnectionLimitsConfig {
  maxSubscriptionsPerConnection: number;  // default: 100
}
```

Limits the number of active subscriptions per connection.

## Minimal vs Production Config

**Minimal (development):**

```typescript
const server = await NoexServer.start({ store });
```

**Production:**

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  host: '0.0.0.0',
  auth: {
    validate: verifyJwtToken,
    permissions: { check: checkPermissions },
  },
  rateLimit: { maxRequests: 200, windowMs: 60_000 },
  heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
  backpressure: { maxBufferedBytes: 2_097_152, highWaterMark: 0.75 },
  connectionLimits: { maxSubscriptionsPerConnection: 50 },
  name: 'my-app-server',
});
```

**Test:**

```typescript
const server = await NoexServer.start({
  store,
  port: 0,            // random port
  host: '127.0.0.1',  // local only
});
```

## Exercise

Write a ServerConfig that:
1. Listens on port 3000, host `'127.0.0.1'`
2. Requires authentication with a simple token check (accept `"secret123"`)
3. Blocks `store.clear` for non-admin users
4. Limits to 100 requests per 30 seconds

<details>
<summary>Solution</summary>

```typescript
const server = await NoexServer.start({
  store,
  port: 3000,
  host: '127.0.0.1',
  auth: {
    validate: async (token) => {
      if (token === 'secret123') {
        return { userId: 'user-1', roles: ['admin'] };
      }
      return null;
    },
    permissions: {
      check: (session, operation) => {
        if (operation === 'store.clear') {
          return session.roles.includes('admin');
        }
        return true;
      },
    },
  },
  rateLimit: {
    maxRequests: 100,
    windowMs: 30_000,
  },
});
```

</details>

## Summary

- `store` is the only required field — everything else has sensible defaults
- Auth, rate limiting are opt-in — omit to disable
- Heartbeat and backpressure are always active with configurable thresholds
- Use `port: 0` + `host: '127.0.0.1'` for tests
- The `name` field is used for registry and logging

---

Next: [Message Format](../03-protocol/01-message-format.md)
