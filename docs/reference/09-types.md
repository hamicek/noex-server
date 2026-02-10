# Types

Shared TypeScript types exported from `@hamicek/noex-server` for server statistics and connection introspection.

## Import

```typescript
import type {
  ServerStats,
  ConnectionsStats,
  ConnectionInfo,
  ConnectionMetadata,
} from '@hamicek/noex-server';
```

---

## ServerStats

Returned by `server.getStats()`. Provides a snapshot of the running server state.

```typescript
interface ServerStats {
  readonly name: string;
  readonly port: number;
  readonly host: string;
  readonly connectionCount: number;
  readonly uptimeMs: number;
  readonly authEnabled: boolean;
  readonly rateLimitEnabled: boolean;
  readonly rulesEnabled: boolean;
  readonly connections: ConnectionsStats;
  readonly store: unknown;
  readonly rules: unknown;
}
```

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Server name from configuration. |
| port | `number` | Port the server is listening on. |
| host | `string` | Host the server is bound to. |
| connectionCount | `number` | Number of active WebSocket connections. |
| uptimeMs | `number` | Milliseconds since the server started. |
| authEnabled | `boolean` | Whether authentication is configured. |
| rateLimitEnabled | `boolean` | Whether rate limiting is configured. |
| rulesEnabled | `boolean` | Whether a rule engine is attached. |
| connections | `ConnectionsStats` | Aggregated connection statistics. |
| store | `unknown` | Store statistics (shape depends on `@hamicek/noex-store`). |
| rules | `unknown` | Rule engine statistics, or `null` if rules are not configured. |

**Example:**

```typescript
const stats = await server.getStats();

console.log(`Server: ${stats.name}`);
console.log(`Connections: ${stats.connectionCount}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);
console.log(`Auth: ${stats.authEnabled ? 'on' : 'off'}`);
```

---

## ConnectionsStats

Aggregated statistics across all active connections.

```typescript
interface ConnectionsStats {
  readonly active: number;
  readonly authenticated: number;
  readonly totalStoreSubscriptions: number;
  readonly totalRulesSubscriptions: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| active | `number` | Total active connections. |
| authenticated | `number` | Connections that have completed authentication. |
| totalStoreSubscriptions | `number` | Sum of all active store subscriptions across connections. |
| totalRulesSubscriptions | `number` | Sum of all active rules subscriptions across connections. |

---

## ConnectionInfo

Detailed information about a single connection. Returned by `server.getConnections()`.

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

| Field | Type | Description |
|-------|------|-------------|
| connectionId | `string` | Unique connection identifier (e.g., `"conn-1"`). |
| remoteAddress | `string` | Client IP address. |
| connectedAt | `number` | Unix timestamp (ms) when the connection was established. |
| authenticated | `boolean` | Whether the connection has completed authentication. |
| userId | `string \| null` | User ID from the auth session, or `null` if unauthenticated. |
| storeSubscriptionCount | `number` | Number of active store subscriptions on this connection. |
| rulesSubscriptionCount | `number` | Number of active rules subscriptions on this connection. |

**Example:**

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(`${conn.connectionId}: ${conn.remoteAddress}`);
  console.log(`  Auth: ${conn.authenticated ? conn.userId : 'anonymous'}`);
  console.log(`  Store subs: ${conn.storeSubscriptionCount}`);
  console.log(`  Rules subs: ${conn.rulesSubscriptionCount}`);
}
```

---

## ConnectionMetadata

Internal metadata tracked per connection in the connection registry. Has the same fields as `ConnectionInfo` without `connectionId`.

```typescript
interface ConnectionMetadata {
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}
```

---

## See Also

- [NoexServer](./01-noex-server.md) — Server class with `getStats()` and `getConnections()`
- [Configuration](./02-configuration.md) — Server configuration types
- [Errors](./10-errors.md) — Error codes and error class
- [Lifecycle](./08-lifecycle.md) — Connection lifecycle and monitoring
