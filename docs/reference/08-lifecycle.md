# Lifecycle

Server infrastructure features: heartbeat monitoring, write buffer backpressure, connection limits, rate limiting, graceful shutdown, and runtime introspection via `server.stats` and `server.connections`.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
import type {
  HeartbeatConfig,
  BackpressureConfig,
  RateLimitConfig,
  ConnectionLimitsConfig,
} from '@hamicek/noex-server';
```

---

## Heartbeat

The server sends periodic `ping` messages to each connected client. Clients must respond with a `pong` message before the next heartbeat tick. If a client fails to respond, the connection is closed with code `4001` and reason `"heartbeat_timeout"`.

### Configuration

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| intervalMs | `number` | `30000` | Interval between ping messages in milliseconds. |
| timeoutMs | `number` | `10000` | Time to wait for a pong response. Not used as a separate timer — the server checks on the next tick whether a pong was received since the last ping. |

### Ping Message

```json
{ "type": "ping", "timestamp": 1700000000000 }
```

### Pong Response

Clients must respond with:

```json
{ "type": "pong", "timestamp": 1700000000000 }
```

The `timestamp` field should echo the value from the ping message.

### Timeout Behavior

1. Server sends a `ping` on tick N.
2. On tick N+1, the server checks if a `pong` was received after the ping.
3. If no `pong` was received (`lastPongAt < lastPingAt`), the connection is closed with WebSocket close code `4001` and reason `"heartbeat_timeout"`.
4. If a `pong` was received, a new `ping` is sent.

Only the unresponsive connection is affected — other connections continue normally.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  heartbeat: {
    intervalMs: 15_000,  // ping every 15 seconds
    timeoutMs: 5_000,    // (informational — timeout is per-tick)
  },
});
```

---

## Backpressure

When a client reads slowly, outgoing messages queue in the WebSocket write buffer. The backpressure mechanism prevents unbounded memory growth by dropping non-essential push messages when the buffer exceeds a threshold.

### Configuration

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxBufferedBytes | `number` | `1048576` (1 MB) | Maximum write buffer size in bytes. |
| highWaterMark | `number` | `0.8` | Fraction of `maxBufferedBytes` at which backpressure activates (0.0–1.0). |

### Behavior

The backpressure threshold is computed as:

```
threshold = maxBufferedBytes × highWaterMark
```

With default values: `1,048,576 × 0.8 = 838,860.8 bytes`.

When `ws.bufferedAmount >= threshold`:

- **Push messages** (subscription updates, rule events) are silently dropped.
- **Request-response messages** (results, errors) are always sent.
- Reactive query subscriptions will naturally resend on the next state change, so dropped pushes do not cause data loss — only temporary staleness.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  backpressure: {
    maxBufferedBytes: 2_097_152,  // 2 MB
    highWaterMark: 0.75,          // activate at 75%
  },
});
```

---

## Connection Limits

### Subscription Limit

Each connection has a maximum number of active subscriptions (store + rules combined).

```typescript
interface ConnectionLimitsConfig {
  readonly maxSubscriptionsPerConnection: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSubscriptionsPerConnection | `number` | `100` | Maximum active subscriptions per connection. |

When the limit is reached, `store.subscribe` and `rules.subscribe` return a `RATE_LIMITED` error with message `"Subscription limit reached (max N per connection)"`.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50,
  },
});
```

---

## Rate Limiting

Per-key rate limiting using a sliding window counter. When configured, every request (including `auth.login`) counts toward the limit.

### Configuration

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| maxRequests | `number` | Maximum number of requests allowed per window. |
| windowMs | `number` | Sliding window duration in milliseconds. |

### Rate Limit Key

- **Unauthenticated clients:** keyed by remote IP address.
- **Authenticated clients:** keyed by `session.userId`.

The key switches from IP to `userId` immediately after a successful `auth.login`. This means:

- Login attempts are rate-limited by IP (prevents brute force).
- After login, each user has an independent rate limit bucket.

### Error Response

When the limit is exceeded, the server returns:

```json
{
  "id": 5,
  "type": "error",
  "code": "RATE_LIMITED",
  "message": "Rate limit exceeded. Retry after 45000ms",
  "details": { "retryAfterMs": 45000 }
}
```

### Disabled by Default

Rate limiting is only active when `rateLimit` is provided in `ServerConfig`. When omitted, no rate limiting is applied.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,  // 100 requests per minute
  },
});
```

---

## Graceful Shutdown

The `NoexServer.stop()` method supports a graceful shutdown sequence:

### Immediate Shutdown (default)

```typescript
await server.stop();
```

1. Stops accepting new connections.
2. Stops all connections via the supervisor (each sends a WebSocket close frame with code `1000`).
3. Stops the rate limiter (if started).
4. Closes the connection registry.
5. Closes the HTTP server.

### Graceful Shutdown with Grace Period

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

1. Stops accepting new connections.
2. Broadcasts a `SystemMessage` to all connected clients:
   ```json
   { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
   ```
3. Waits up to `gracePeriodMs` for all clients to disconnect voluntarily.
4. If clients remain after the grace period, force-stops them via the supervisor.
5. Cleans up rate limiter and registry.

### Connection Close on Shutdown

When the supervisor stops a connection:

- If the WebSocket is still open, a close frame is sent with code `1000` and reason `"normal_closure"` (normal stop) or `"server_shutdown"` (shutdown stop).
- All store and rules subscriptions are cleaned up.
- The heartbeat timer is stopped.

---

## Runtime Introspection

### server.stats

```
{ id, type: "server.stats" }
```

Returns a snapshot of the server state, including aggregated connection statistics and underlying store/rules statistics.

**Parameters:** None.

**Returns:**

```typescript
{
  name: string;
  connectionCount: number;
  authEnabled: boolean;
  rateLimitEnabled: boolean;
  rulesEnabled: boolean;
  connections: {
    active: number;
    authenticated: number;
    totalStoreSubscriptions: number;
    totalRulesSubscriptions: number;
  };
  store: unknown;   // Store.getStats() result
  rules: unknown;   // RuleEngine.getStats() result or null
}
```

**Example:**

```typescript
// Client sends:
{ id: 10, type: "server.stats" }

// Server responds:
{
  id: 10,
  type: "result",
  data: {
    name: "noex-server",
    connectionCount: 5,
    authEnabled: true,
    rateLimitEnabled: false,
    rulesEnabled: true,
    connections: {
      active: 5,
      authenticated: 3,
      totalStoreSubscriptions: 12,
      totalRulesSubscriptions: 4
    },
    store: { /* ... */ },
    rules: { /* ... */ }
  }
}
```

### server.connections

```
{ id, type: "server.connections" }
```

Returns information about all active connections.

**Parameters:** None.

**Returns:** `ConnectionInfo[]`

```typescript
interface ConnectionInfo {
  readonly connectionId: string;
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}
```

**Example:**

```typescript
// Client sends:
{ id: 11, type: "server.connections" }

// Server responds:
{
  id: 11,
  type: "result",
  data: [
    {
      connectionId: "conn-1",
      remoteAddress: "192.168.1.10",
      connectedAt: 1700000000000,
      authenticated: true,
      userId: "user-1",
      storeSubscriptionCount: 3,
      rulesSubscriptionCount: 1
    }
  ]
}
```

---

## WebSocket Close Codes

| Code | Reason | Description |
|------|--------|-------------|
| `1000` | `normal_closure` | Connection terminated normally (client disconnect or server stop). |
| `1000` | `server_shutdown` | Connection terminated due to server shutdown via supervisor. |
| `1001` | `server_shutting_down` | New connection rejected because the server is shutting down. |
| `4001` | `heartbeat_timeout` | Client failed to respond to a heartbeat ping. |

---

## See Also

- [NoexServer](./01-noex-server.md) — Server class with `stop()`, `getStats()`, `getConnections()`
- [Configuration](./02-configuration.md) — HeartbeatConfig, BackpressureConfig, RateLimitConfig, ConnectionLimitsConfig
- [Protocol](./03-protocol.md) — HeartbeatPing, HeartbeatPong, SystemMessage types
- [Types](./09-types.md) — ServerStats, ConnectionsStats, ConnectionInfo
- [Authentication](./07-authentication.md) — Auth session used for rate limit key switching
- [Errors](./10-errors.md) — RATE_LIMITED, BACKPRESSURE error codes
