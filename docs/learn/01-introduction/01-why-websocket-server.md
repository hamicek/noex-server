# Why a WebSocket Server?

Most backends start with REST endpoints. A request comes in, the server responds, done. But as your application grows, you start needing real-time data: live dashboards, collaborative editing, instant notifications. Suddenly, REST isn't enough.

noex-server gives you a protocol-first WebSocket server with built-in CRUD, reactive subscriptions, transactions, authentication, and production resilience — all supervised by GenServer processes that never leave dangling state.

## What You'll Learn

- Why REST polling falls short for real-time applications
- How WebSocket push changes the data flow model
- What a protocol-first server provides versus raw WebSocket handling
- How GenServer supervision makes each connection reliable

## The Problem with REST Polling

When a client needs up-to-date data from a REST API, it has two options:

### Option 1: Poll

```text
Client                          Server
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob] ──────│
  │                                │
  │     (wait 5 seconds...)        │
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob] ──────│   ← No change. Wasted request.
  │                                │
  │     (wait 5 seconds...)        │
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob, Carol]│   ← Carol added 4 seconds ago.
  │                                │      Stale by up to 5 seconds.
```

Polling wastes bandwidth when data hasn't changed and delivers stale data between intervals. Reducing the interval increases load without eliminating the delay.

### Option 2: Long Polling / SSE

Server-Sent Events (SSE) solve the push problem for one-way communication, but they're HTTP-only, unidirectional, and require a separate channel for client-to-server messages. You end up maintaining two protocols: REST for writes, SSE for reads.

### WebSocket: Bidirectional, Persistent, Efficient

```text
Client                          Server
  │                                │
  │══ WebSocket Connected ═════════│
  │                                │
  │──── insert user "Carol" ──────►│
  │◄─── result: { id: "c3" } ─────│
  │                                │
  │◄─── push: [Alice, Bob, Carol] ─│   ← Immediate. No polling.
  │                                │
  │──── subscribe to "all-users" ─►│
  │◄─── result: { subId: "s1" } ──│
  │                                │
  │◄─── push: [Alice, Bob, Carol] ─│   ← Subscription delivers
  │                                │      live results.
```

A single WebSocket connection handles both directions. The server pushes data the instant it changes. No wasted requests, no stale intervals.

## REST vs WebSocket vs noex-server

| Dimension | REST + Polling | Raw WebSocket | noex-server |
|-----------|---------------|---------------|-------------|
| **Latency** | Up to polling interval | Instant push | Instant push |
| **Bandwidth** | Wasted on empty polls | Efficient | Efficient |
| **Protocol** | HTTP per request | You build it yourself | JSON protocol v1.0.0 built-in |
| **CRUD** | You build routes | You build message handling | `store.insert`, `store.get`, etc. |
| **Subscriptions** | Separate SSE channel | You build pub/sub | `store.subscribe` with reactive queries |
| **Error codes** | HTTP status codes | You define them | 15 typed error codes |
| **Auth** | Middleware per route | You build it | `auth.login` with pluggable validation |
| **Connection health** | N/A | You build ping/pong | Heartbeat with auto-disconnect |
| **Fault tolerance** | Process crash = lost state | Manual cleanup | GenServer per connection with supervision |

## What a Protocol-First Server Provides

Instead of building WebSocket message handling, routing, error formatting, and subscription management from scratch, noex-server ships with:

1. **A typed protocol** — every message has a defined structure, version, and error code
2. **Request/response correlation** — each request carries an `id` that the response echoes back
3. **Push channels** — server-initiated messages on named channels (`subscription`, `event`)
4. **Operation routing** — `store.*`, `rules.*`, and `auth.*` namespaces with built-in validation
5. **Error taxonomy** — 15 error codes from `PARSE_ERROR` to `RULES_NOT_AVAILABLE`, each with a clear recovery path

## GenServer Supervision

Every WebSocket connection is managed by a dedicated GenServer process:

```text
NoexServer
└── ConnectionSupervisor (simple_one_for_one)
    ├── ConnectionServer #1  ← GenServer per WebSocket
    ├── ConnectionServer #2
    └── ConnectionServer #N
```

If a ConnectionServer crashes (e.g., a bug in message handling), the supervisor cleans up that connection — all subscriptions are unsubscribed, the WebSocket is closed — without affecting any other connection. The crash is isolated.

This is fundamentally different from a typical Node.js WebSocket server where an unhandled error in one message handler can take down the entire process.

## Working Example

A minimal server that accepts WebSocket connections:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'demo' });

store.defineBucket('messages', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    text: { type: 'string', required: true },
    from: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({
  port: 8080,
  store,
});

console.log(`Listening on ws://localhost:${server.port}`);
```

A client connects and sends JSON:

```jsonc
// Client sends:
→ { "id": 1, "type": "store.insert", "bucket": "messages", "data": { "text": "Hello!", "from": "Alice" } }

// Server responds:
← { "id": 1, "type": "result", "data": { "id": "a1b2c3", "text": "Hello!", "from": "Alice", "_version": 1, "_createdAt": 1706745600000 } }
```

## Exercise

Think about an application you've built (or used) that does REST polling for real-time data. Answer these questions:

1. What is the polling interval?
2. What is the maximum staleness a user experiences?
3. How many requests per minute does each client generate?
4. What percentage of those requests return unchanged data?

<details>
<summary>Discussion</summary>

For a typical dashboard polling every 5 seconds:
- Maximum staleness: 5 seconds
- Requests per minute per client: 12
- If data changes once per minute on average, ~92% of requests return unchanged data

With noex-server's WebSocket push:
- Maximum staleness: 0 (pushed on change)
- Requests per minute: 0 (server pushes)
- Zero wasted requests

The savings multiply with each connected client. 100 polling clients × 12 req/min = 1,200 req/min. With push: 100 push messages only when data changes.

</details>

## Summary

- REST polling wastes bandwidth and delivers stale data
- WebSocket provides bidirectional, persistent, efficient real-time communication
- noex-server ships with a complete JSON protocol, not just raw WebSocket
- GenServer supervision isolates each connection — crashes don't cascade
- The protocol handles CRUD, subscriptions, transactions, auth, and error codes out of the box

---

Next: [Key Concepts](./02-key-concepts.md)
