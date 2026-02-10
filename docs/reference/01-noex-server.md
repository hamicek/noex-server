# NoexServer

Main server class. Manages a WebSocket server, a connection supervisor, and an optional rate limiter. Each incoming connection is handled by a dedicated GenServer process supervised with a `simple_one_for_one` strategy.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
```

---

## Factory

### NoexServer.start()

```typescript
static async start(config: ServerConfig): Promise<NoexServer>
```

Creates and starts a new server instance. Performs the following steps:

1. Resolves configuration with defaults.
2. Starts the rate limiter (if configured).
3. Creates the connection registry.
4. Starts the connection supervisor.
5. Creates an HTTP server with a WebSocket upgrade handler.
6. Begins listening on the configured `host` and `port`.

If any step fails, all previously created resources are cleaned up before the error is thrown.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| config | `ServerConfig` | yes | Server configuration. Only `store` is required; all other fields have defaults. |

**Returns:** `Promise<NoexServer>` — running server instance

**Example:**

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ buckets: { users: {} } });

const server = await NoexServer.start({
  store,
  port: 8080,
  host: '0.0.0.0',
});

console.log(`Listening on port ${server.port}`);
```

---

## Methods

### stop()

```typescript
async stop(options?: { gracePeriodMs?: number }): Promise<void>
```

Gracefully stops the server:

1. Stops accepting new connections (closes the HTTP server).
2. If `gracePeriodMs > 0`, broadcasts a `SystemMessage` with `event: "shutdown"` to all connected clients, then waits for them to disconnect or for the grace period to expire.
3. Stops all remaining connections via the supervisor. Each connection's `terminate()` sends a WebSocket close frame.
4. Stops the rate limiter (if started).
5. Closes the connection registry.
6. Waits for the HTTP server to finish closing.

Calling `stop()` on an already-stopped server is a no-op.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| options.gracePeriodMs | `number` | no | Time in milliseconds to wait for clients to disconnect before force-closing. Default: `0` (immediate). |

**Returns:** `Promise<void>`

**Example:**

```typescript
// Immediate shutdown
await server.stop();

// Graceful shutdown with 5-second grace period
await server.stop({ gracePeriodMs: 5000 });
```

### getConnections()

```typescript
getConnections(): ConnectionInfo[]
```

Returns information about all active connections.

**Returns:** `ConnectionInfo[]` — array of connection info objects

**Example:**

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(`${conn.connectionId}: ${conn.remoteAddress}`);
  console.log(`  Auth: ${conn.authenticated ? conn.userId : 'anonymous'}`);
  console.log(`  Store subs: ${conn.storeSubscriptionCount}`);
}
```

### getStats()

```typescript
async getStats(): Promise<ServerStats>
```

Returns a snapshot of the server state, including aggregated connection statistics, store statistics, and rule engine statistics (if configured).

**Returns:** `Promise<ServerStats>` — server statistics

**Example:**

```typescript
const stats = await server.getStats();

console.log(`Server: ${stats.name}`);
console.log(`Connections: ${stats.connectionCount}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);
console.log(`Auth: ${stats.authEnabled ? 'on' : 'off'}`);
console.log(`Rate limit: ${stats.rateLimitEnabled ? 'on' : 'off'}`);
console.log(`Rules: ${stats.rulesEnabled ? 'on' : 'off'}`);
```

---

## Properties

### port

```typescript
get port(): number
```

The port the server is listening on. Useful when starting the server with `port: 0` (random port assignment).

**Example:**

```typescript
const server = await NoexServer.start({ store, port: 0 });
console.log(`Listening on port ${server.port}`); // e.g., 54321
```

### connectionCount

```typescript
get connectionCount(): number
```

The number of active WebSocket connections managed by the supervisor.

### isRunning

```typescript
get isRunning(): boolean
```

Whether the server is currently running. Returns `false` after `stop()` has been called.

---

## Types

Types used by `NoexServer` are documented separately:

- `ServerConfig` — see [Configuration](./02-configuration.md)
- `ServerStats`, `ConnectionsStats` — see [Types](./09-types.md)
- `ConnectionInfo` — see [Types](./09-types.md)

---

## See Also

- [Configuration](./02-configuration.md) — Server configuration types and defaults
- [Protocol](./03-protocol.md) — WebSocket protocol specification
- [Types](./09-types.md) — ServerStats, ConnectionsStats, ConnectionInfo
- [Errors](./10-errors.md) — Error codes and error class
- [Lifecycle](./08-lifecycle.md) — Heartbeat, backpressure, graceful shutdown
