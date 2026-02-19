# @hamicek/noex-server

WebSocket server for [@hamicek/noex-store](https://github.com/hamicek/noex-store) and [@hamicek/noex-rules](https://github.com/hamicek/noex-rules) built on [@hamicek/noex](https://github.com/hamicek/noex) GenServer supervision.

## Features

- **GenServer per connection** with `simple_one_for_one` supervision and automatic cleanup
- Full proxy for noex-store: CRUD, reactive query subscriptions, multi-bucket transactions
- Optional noex-rules proxy: emit events, manage facts, subscribe to rule matches
- Token-based authentication with pluggable validation and per-operation permissions
- Rate limiting, heartbeat ping/pong, and write-buffer backpressure
- Graceful shutdown with client notification and configurable grace period
- Connection registry with real-time stats and per-connection metadata
- JSON-over-WebSocket protocol (version 1.0.0) with request/response correlation and push channels

## Installation

```bash
npm install @hamicek/noex-server
```

Requires `@hamicek/noex` and `@hamicek/noex-store` as peer dependencies and Node.js >= 20.
`@hamicek/noex-rules` is an optional peer dependency.

## Quick Start

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'my-store' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineQuery('all-users', async (ctx) => ctx.bucket('users').all());

const server = await NoexServer.start({
  port: 8080,
  store,
});

console.log(`Listening on ws://localhost:${server.port}`);
```

A client connects over WebSocket and sends JSON messages:

```jsonc
// Insert a record
→ { "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
← { "id": 1, "type": "result", "data": { "id": "a1b2c3", "name": "Alice", "role": "user", "_version": 1, ... } }

// Subscribe to a reactive query
→ { "id": 2, "type": "store.subscribe", "query": "all-users" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-1" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [...] }
```

## API

### NoexServer

#### `NoexServer.start(config): Promise<NoexServer>`

Creates and starts the server. Initializes the HTTP server, WebSocket upgrade handler, connection supervisor, and optional rate limiter.

```typescript
const server = await NoexServer.start({
  port: 8080,
  store,
  rules: engine,        // optional
  auth: { ... },        // optional
  rateLimit: { ... },   // optional
});
```

#### `server.stop(options?): Promise<void>`

Gracefully stops the server.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `gracePeriodMs` | `number` | `0` | Time to wait for clients to disconnect after sending a shutdown notification |

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

#### `server.port: number`

The port the server is listening on. Useful when starting with `port: 0` for tests.

#### `server.connectionCount: number`

Number of active WebSocket connections.

#### `server.isRunning: boolean`

Whether the server is currently accepting connections.

#### `server.getConnections(): ConnectionInfo[]`

Returns metadata for all active connections: remote address, auth status, subscription counts, connected timestamp.

#### `server.getStats(): Promise<ServerStats>`

Aggregated statistics including connection counts, uptime, feature flags, and underlying store/rules stats.

```typescript
const stats = await server.getStats();
// {
//   name: 'noex-server',
//   port: 8080,
//   connectionCount: 42,
//   uptimeMs: 360000,
//   authEnabled: true,
//   rateLimitEnabled: true,
//   rulesEnabled: false,
//   connections: { active: 42, authenticated: 40, totalStoreSubscriptions: 120, ... },
//   store: { ... },
//   rules: null,
// }
```

---

### Configuration

```typescript
interface ServerConfig {
  store: Store;                        // required — noex-store instance
  rules?: RuleEngine;                  // optional — noex-rules instance
  port?: number;                       // default: 8080
  host?: string;                       // default: '0.0.0.0'
  path?: string;                       // default: '/' (WebSocket endpoint)
  maxPayloadBytes?: number;            // default: 1 MB
  auth?: AuthConfig;                   // when omitted, auth is disabled
  rateLimit?: RateLimitConfig;         // when omitted, rate limiting is disabled
  heartbeat?: HeartbeatConfig;         // default: 30 s interval, 10 s timeout
  backpressure?: BackpressureConfig;   // default: 1 MB limit, 0.8 high water mark
  name?: string;                       // default: 'noex-server'
}
```

#### Authentication

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      const payload = verifyJwt(token);
      if (!payload) return null;
      return {
        userId: payload.sub,
        roles: payload.roles ?? ['user'],
        expiresAt: payload.exp * 1000,
      };
    },
    required: true, // default when auth is configured
    permissions: {
      check: (session, operation, resource) => {
        if (session.roles.includes('admin')) return true;
        if (operation === 'store.clear') return false;
        return true;
      },
    },
  },
});
```

When `auth.required` is true, clients must send `auth.login` before any other operation. Session expiration is checked on every request.

#### Rate Limiting

```typescript
rateLimit: {
  maxRequests: 200,   // requests per window
  windowMs: 60_000,   // sliding window duration
}
```

Uses `@hamicek/noex` RateLimiter GenServer. Key is `session.userId` for authenticated connections, remote IP address otherwise.

#### Heartbeat

```typescript
heartbeat: {
  intervalMs: 30_000,  // how often to send ping
  timeoutMs: 10_000,   // how long to wait for pong
}
```

The server sends `ping` messages at the configured interval. If no `pong` is received within `timeoutMs`, the connection is closed with code `4001`.

#### Backpressure

```typescript
backpressure: {
  maxBufferedBytes: 1_048_576,  // 1 MB
  highWaterMark: 0.8,           // pause push at 80%
}
```

When the WebSocket write buffer exceeds the high water mark, push messages are paused to prevent memory exhaustion on slow clients.

---

## Protocol

All messages are JSON objects sent as WebSocket text frames. Protocol version: `1.0.0`.

### Connection Lifecycle

1. Client connects via WebSocket
2. Server sends a `welcome` message with protocol version and auth requirements
3. If auth is required, client sends `auth.login` with a token
4. Client sends requests, server responds with results or errors
5. For subscriptions, server sends asynchronous `push` messages
6. Server sends periodic `ping`, client responds with `pong`
7. Either side can close the connection; server cleans up all subscriptions

### Message Types

**Request** (client -> server):

```jsonc
{ "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
```

**Response** (server -> client):

```jsonc
{ "id": 1, "type": "result", "data": { ... } }
{ "id": 1, "type": "error", "code": "VALIDATION_ERROR", "message": "...", "details": { ... } }
```

**Push** (server -> client, no request correlation):

```jsonc
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [...] }
{ "type": "push", "channel": "event", "subscriptionId": "sub-2", "data": { "topic": "...", "event": { ... } } }
```

**System** (server -> client):

```jsonc
{ "type": "welcome", "version": "1.0.0", "serverTime": 1706745600000, "requiresAuth": true }
{ "type": "ping", "timestamp": 1706745600000 }
{ "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
```

### Operations

#### Store

| Operation | Description | Payload fields |
|-----------|-------------|----------------|
| `store.insert` | Insert a record | `bucket`, `data` |
| `store.get` | Get by primary key | `bucket`, `key` |
| `store.update` | Update a record | `bucket`, `key`, `data` |
| `store.delete` | Delete a record | `bucket`, `key` |
| `store.all` | All records | `bucket` |
| `store.where` | Filter records | `bucket`, `filter` |
| `store.findOne` | First match | `bucket`, `filter` |
| `store.count` | Count records | `bucket`, `filter?` |
| `store.first` | First N records | `bucket`, `n` |
| `store.last` | Last N records | `bucket`, `n` |
| `store.paginate` | Cursor pagination | `bucket`, `limit`, `after?` |
| `store.clear` | Clear all records | `bucket` |
| `store.sum` | Sum a numeric field | `bucket`, `field`, `filter?` |
| `store.avg` | Average a numeric field | `bucket`, `field`, `filter?` |
| `store.min` | Minimum value | `bucket`, `field`, `filter?` |
| `store.max` | Maximum value | `bucket`, `field`, `filter?` |
| `store.subscribe` | Subscribe to reactive query | `query`, `params?` |
| `store.unsubscribe` | Cancel subscription | `subscriptionId` |
| `store.transaction` | Atomic multi-bucket transaction | `operations` |
| `store.buckets` | List defined buckets | — |
| `store.stats` | Store statistics | — |

#### Transactions

Send multiple operations atomically:

```jsonc
{
  "id": 10,
  "type": "store.transaction",
  "operations": [
    { "op": "get", "bucket": "users", "key": "user-1" },
    { "op": "update", "bucket": "users", "key": "user-1", "data": { "credits": 400 } },
    { "op": "insert", "bucket": "logs", "data": { "action": "credit_update" } }
  ]
}
```

Supported ops: `get`, `insert`, `update`, `delete`, `where`, `findOne`, `count`.

#### Rules

Available only when `rules` is configured. Returns `RULES_NOT_AVAILABLE` otherwise.

| Operation | Description | Payload fields |
|-----------|-------------|----------------|
| `rules.emit` | Emit an event | `topic`, `data`, `correlationId?` |
| `rules.setFact` | Set a fact | `key`, `value` |
| `rules.getFact` | Get a fact | `key` |
| `rules.deleteFact` | Delete a fact | `key` |
| `rules.queryFacts` | Query facts by pattern | `pattern` |
| `rules.getAllFacts` | Get all facts | — |
| `rules.subscribe` | Subscribe to rule events | `pattern` |
| `rules.unsubscribe` | Cancel subscription | `subscriptionId` |
| `rules.stats` | Engine statistics | — |

#### Auth

| Operation | Description | Payload fields |
|-----------|-------------|----------------|
| `auth.login` | Authenticate with token | `token` |
| `auth.logout` | End session | — |
| `auth.whoami` | Current session info | — |

### Error Codes

| Code | Description |
|------|-------------|
| `PARSE_ERROR` | Invalid JSON |
| `INVALID_REQUEST` | Missing `id` or `type` |
| `UNKNOWN_OPERATION` | Unsupported operation type |
| `VALIDATION_ERROR` | Schema validation failed |
| `NOT_FOUND` | Record or subscription not found |
| `ALREADY_EXISTS` | Duplicate key or unique constraint violation |
| `CONFLICT` | Transaction version conflict |
| `UNAUTHORIZED` | Authentication required or token invalid |
| `FORBIDDEN` | Insufficient permissions |
| `RATE_LIMITED` | Rate limit exceeded |
| `BACKPRESSURE` | Write buffer full, slow down |
| `INTERNAL_ERROR` | Unexpected server error |
| `BUCKET_NOT_DEFINED` | Bucket does not exist |
| `QUERY_NOT_DEFINED` | Reactive query not defined |
| `RULES_NOT_AVAILABLE` | Rule engine not configured |

---

## Architecture

```
NoexServer
└── ConnectionSupervisor (simple_one_for_one)
    ├── ConnectionServer #1  (GenServer per WebSocket)
    ├── ConnectionServer #2
    └── ConnectionServer #N
```

Each WebSocket connection is managed by a dedicated `ConnectionServer` GenServer. The supervisor uses the `temporary` restart strategy — crashed connections are cleaned up (all subscriptions unsubscribed, WebSocket closed) but not restarted.

The request pipeline for each message:

1. JSON parse and validate
2. Authentication check (if configured)
3. Rate limit check (if configured)
4. Route to store proxy or rules proxy
5. Serialize result or map error

---

## Production Considerations

### TLS / WSS

The server listens on plain HTTP and `ws://`. For production, terminate TLS at a reverse proxy (nginx, Caddy, etc.) and forward `wss://` connections to the server:

```nginx
upstream noex {
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/ssl/certs/api.example.com.pem;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    location / {
        proxy_pass http://noex;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Session Persistence

The built-in identity system stores sessions in the `_sessions` noex-store bucket, which lives entirely in memory. A server restart clears all sessions — every user will need to log in again. There is no built-in hook for external session storage.

### Audit Log Persistence

The audit ring buffer is in-memory (default 10,000 entries). Once the buffer is full, oldest entries are overwritten. Use `onEntry` to persist entries to durable storage:

```typescript
const server = await NoexServer.start({
  store,
  audit: {
    tiers: ['admin', 'write'],
    onEntry: (entry) => {
      fs.appendFileSync('audit.jsonl', JSON.stringify(entry) + '\n');
    },
  },
});
```

See the [Audit reference](./docs/reference/11-audit.md) for the full `AuditEntry` shape and query API.

---

## License

MIT
