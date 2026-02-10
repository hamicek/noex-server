# Connection Registry

Inspect active connections at runtime — per-connection metadata, aggregated statistics, and WebSocket-accessible server introspection.

## What You'll Learn

- `server.getConnections()` — list all active connections with metadata
- `server.connectionCount` — quick count of active connections
- `server.getStats()` — aggregated server statistics
- `ConnectionInfo` fields — what metadata is tracked per connection
- `server.stats` and `server.connections` WebSocket operations

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'registry-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

store.defineQuery('all-users', async (ctx) => ctx.bucket('users').all());

const server = await NoexServer.start({
  store,
  port: 8080,
  name: 'my-app',
  auth: {
    validate: async (token) => {
      if (token === 'token-alice') {
        return { userId: 'alice', roles: ['admin'] };
      }
      return null;
    },
    required: false,
  },
});
```

## ConnectionInfo

Each connection is tracked with the following metadata:

```typescript
interface ConnectionInfo {
  readonly connectionId: string;            // "conn-1", "conn-2", ...
  readonly remoteAddress: string;           // Client IP address
  readonly connectedAt: number;             // Unix timestamp (ms)
  readonly authenticated: boolean;          // true after auth.login
  readonly userId: string | null;           // null until authenticated
  readonly storeSubscriptionCount: number;  // Active store subscriptions
  readonly rulesSubscriptionCount: number;  // Active rules subscriptions
}
```

Metadata is updated automatically:
- **On connect** — `authenticated: false`, `userId: null`, subscription counts `0`
- **On `auth.login`** — `authenticated: true`, `userId` set
- **On `auth.logout`** — `authenticated: false`, `userId: null`
- **On `store.subscribe` / `store.unsubscribe`** — `storeSubscriptionCount` updated
- **On `rules.subscribe` / `rules.unsubscribe`** — `rulesSubscriptionCount` updated
- **On disconnect** — connection removed from registry

## server.getConnections()

Returns an array of `ConnectionInfo` for all active connections:

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(conn.connectionId);            // "conn-1"
  console.log(conn.remoteAddress);           // "127.0.0.1"
  console.log(conn.connectedAt);            // 1706745600000
  console.log(conn.authenticated);           // true
  console.log(conn.userId);                  // "alice"
  console.log(conn.storeSubscriptionCount);  // 2
  console.log(conn.rulesSubscriptionCount);  // 0
}
```

Returns an empty array when no clients are connected.

## server.connectionCount

A quick way to get the number of active connections without fetching full metadata:

```typescript
console.log(server.connectionCount); // 3
```

This reads the supervisor's child count directly — no registry query needed.

## server.getStats()

Returns aggregated statistics about the entire server:

```typescript
const stats = await server.getStats();
```

```typescript
interface ServerStats {
  readonly name: string;                // Server name from config
  readonly port: number;                // Listening port
  readonly host: string;                // Listening host
  readonly connectionCount: number;     // Active connections
  readonly uptimeMs: number;            // Time since server started
  readonly authEnabled: boolean;        // Whether auth is configured
  readonly rateLimitEnabled: boolean;   // Whether rate limiting is configured
  readonly rulesEnabled: boolean;       // Whether rules engine is configured
  readonly connections: ConnectionsStats;
  readonly store: unknown;              // Store stats (from store.getStats())
  readonly rules: unknown;              // Rules stats or null
}

interface ConnectionsStats {
  readonly active: number;                   // Total active connections
  readonly authenticated: number;            // Connections with valid session
  readonly totalStoreSubscriptions: number;  // Sum across all connections
  readonly totalRulesSubscriptions: number;  // Sum across all connections
}
```

## WebSocket Operations

Both stats and connection list are also available over the WebSocket protocol, so clients can inspect the server without direct access to the `NoexServer` instance.

### server.stats

```jsonc
→ { "id": 1, "type": "server.stats" }

← { "id": 1, "type": "result",
    "data": {
      "name": "my-app",
      "connectionCount": 3,
      "authEnabled": true,
      "rateLimitEnabled": false,
      "rulesEnabled": false,
      "connections": {
        "active": 3,
        "authenticated": 1,
        "totalStoreSubscriptions": 4,
        "totalRulesSubscriptions": 0
      },
      "store": { ... },
      "rules": null
    } }
```

### server.connections

```jsonc
→ { "id": 2, "type": "server.connections" }

← { "id": 2, "type": "result",
    "data": [
      {
        "connectionId": "conn-1",
        "remoteAddress": "192.168.1.10",
        "connectedAt": 1706745600000,
        "authenticated": true,
        "userId": "alice",
        "storeSubscriptionCount": 2,
        "rulesSubscriptionCount": 0
      },
      {
        "connectionId": "conn-2",
        "remoteAddress": "192.168.1.20",
        "connectedAt": 1706745610000,
        "authenticated": false,
        "userId": null,
        "storeSubscriptionCount": 0,
        "rulesSubscriptionCount": 0
      }
    ] }
```

## Metadata Lifecycle

```
Connect
  │
  ▼
Registry: { authenticated: false, userId: null, subs: 0 }
  │
  ▼
auth.login ──▶ { authenticated: true, userId: "alice" }
  │
  ▼
store.subscribe ──▶ { storeSubscriptionCount: 1 }
store.subscribe ──▶ { storeSubscriptionCount: 2 }
  │
  ▼
store.unsubscribe ──▶ { storeSubscriptionCount: 1 }
  │
  ▼
auth.logout ──▶ { authenticated: false, userId: null }
  │
  ▼
Disconnect ──▶ Connection removed from registry
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `UNKNOWN_OPERATION` | Unknown `server.*` operation (e.g. `server.unknown`) |

## Working Example

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  name: 'my-app',
});

// Server-side: inspect connections
console.log(server.connectionCount); // 0

// ... clients connect ...

const connections = server.getConnections();
console.log(connections.length); // 2

const stats = await server.getStats();
console.log(stats.name);                              // "my-app"
console.log(stats.uptimeMs);                           // 12345
console.log(stats.connections.active);                 // 2
console.log(stats.connections.authenticated);           // 1
console.log(stats.connections.totalStoreSubscriptions); // 3

// Client-side: inspect via WebSocket
// → { "id": 1, "type": "server.stats" }
// ← { "id": 1, "type": "result", "data": { "name": "my-app", ... } }

// → { "id": 2, "type": "server.connections" }
// ← { "id": 2, "type": "result", "data": [ { "connectionId": "conn-1", ... } ] }
```

## Exercise

Set up a server with optional auth. Connect two clients:
1. Authenticate the first client
2. Create a store subscription on the second client
3. Use `server.connections` to verify the state of both connections
4. Disconnect the first client and verify it's removed

<details>
<summary>Solution</summary>

```jsonc
// Client A connects
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": false }

// Client B connects
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": false }

// 1. Client A authenticates
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", "roles": ["admin"] } }

// 2. Client B subscribes
→ { "id": 2, "type": "store.subscribe", "query": "all-users" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "initialData": [] } }

// 3. Client A checks connections
→ { "id": 3, "type": "server.connections" }
← { "id": 3, "type": "result",
    "data": [
      { "connectionId": "conn-1", "authenticated": true, "userId": "alice",
        "storeSubscriptionCount": 0, "rulesSubscriptionCount": 0 },
      { "connectionId": "conn-2", "authenticated": false, "userId": null,
        "storeSubscriptionCount": 1, "rulesSubscriptionCount": 0 }
    ] }

// 4. Client A disconnects, Client B verifies
→ { "id": 4, "type": "server.connections" }
← { "id": 4, "type": "result",
    "data": [
      { "connectionId": "conn-2", "authenticated": false, "userId": null,
        "storeSubscriptionCount": 1, "rulesSubscriptionCount": 0 }
    ] }
```

</details>

## Summary

- `server.getConnections()` returns `ConnectionInfo[]` — per-connection metadata
- `server.connectionCount` is a lightweight count via the supervisor
- `server.getStats()` returns aggregated `ServerStats` including connections, store, and rules
- `ConnectionInfo` tracks: `connectionId`, `remoteAddress`, `connectedAt`, `authenticated`, `userId`, subscription counts
- Metadata is updated automatically on auth events and subscription changes
- `server.stats` and `server.connections` WebSocket operations expose the same data to clients
- Connections are removed from the registry on disconnect

---

Next: [Graceful Shutdown](./03-graceful-shutdown.md)
