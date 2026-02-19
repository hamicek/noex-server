# API Reference

Complete API reference for `@hamicek/noex-server`. Every class, method, type, configuration option, and protocol message documented with signatures and examples.

## Server

| Module | Description |
|--------|-------------|
| [NoexServer](./01-noex-server.md) | Main server class — start, stop, port, connections, stats |
| [Configuration](./02-configuration.md) | All configuration interfaces and their default values |
| [Protocol](./03-protocol.md) | WebSocket protocol specification — request/response/push message formats |

## Operations

| Module | Description |
|--------|-------------|
| [Store Operations](./04-store-operations.md) | CRUD, queries, aggregations, and admin operations on the store |
| [Store Subscriptions](./05-store-subscriptions.md) | Reactive subscriptions, push notifications, and transactions |
| [Rules Operations](./06-rules-operations.md) | Rule engine operations — events, facts, subscriptions, stats |

## Infrastructure

| Module | Description |
|--------|-------------|
| [Authentication](./07-authentication.md) | Login, logout, session lifecycle, permissions |
| [Lifecycle](./08-lifecycle.md) | Heartbeat, backpressure, connection limits, rate limiting, graceful shutdown |
| [Types](./09-types.md) | Shared types — ServerStats, ConnectionsStats, ConnectionInfo, ConnectionMetadata |
| [Errors](./10-errors.md) | ErrorCode enum, NoexServerError class, error response format |
| [Audit](./11-audit.md) | Audit log — operation tiers, audit.query, external persistence |
| [Built-in Identity](./12-built-in-auth.md) | Built-in auth — 27 identity operations, users, roles, ACL, ownership |

## Quick Links

```typescript
import { NoexServer, ErrorCode, NoexServerError } from '@hamicek/noex-server';
import type { ServerConfig, AuthConfig, AuthSession } from '@hamicek/noex-server';
```

### Start a Server

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-store' });
const server = await NoexServer.start({ store, port: 8080 });
```

### Start with Authentication

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      // Return AuthSession or null
      return { userId: 'u1', roles: ['admin'] };
    },
  },
});
```

### Stop Gracefully

```typescript
await server.stop({ gracePeriodMs: 5000 });
```
