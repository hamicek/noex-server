# Key Concepts

Before diving into code, let's establish the vocabulary and mental model for noex-server. Every concept here maps directly to something you'll use in the protocol.

## What You'll Learn

- The four message categories: request, response, push, system
- How request/response correlation works via the `id` field
- What push channels are and how they differ from responses
- The complete connection lifecycle from connect to close
- A glossary of terms used throughout the documentation

## The Protocol Model

noex-server uses a JSON-over-WebSocket protocol. Every message is a JSON object sent as a WebSocket text frame. The protocol defines four categories:

```text
┌─────────────────────────────────────────────────────────────────┐
│                    MESSAGE CATEGORIES                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  REQUEST     Client → Server                                    │
│  ──────────────────────────────────                             │
│  { id: 1, type: "store.insert", bucket: "users", data: {...} } │
│                                                                  │
│  RESPONSE    Server → Client (correlated by id)                 │
│  ──────────────────────────────────                             │
│  { id: 1, type: "result", data: {...} }                         │
│  { id: 1, type: "error", code: "VALIDATION_ERROR", ... }       │
│                                                                  │
│  PUSH        Server → Client (no id, async)                    │
│  ──────────────────────────────────                             │
│  { type: "push", channel: "subscription", subscriptionId, data }│
│  { type: "push", channel: "event", subscriptionId, data }      │
│                                                                  │
│  SYSTEM      Server → Client (control messages)                 │
│  ──────────────────────────────────                             │
│  { type: "welcome", version: "1.0.0", ... }                    │
│  { type: "ping", timestamp: ... }                               │
│  { type: "system", event: "shutdown", ... }                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Request/Response Correlation

Every request includes a numeric `id` field. The server echoes this `id` in the response. This lets the client match responses to requests even when multiple requests are in flight:

```text
Client                              Server
  │                                    │
  │── { id: 1, type: "store.get" } ──►│
  │── { id: 2, type: "store.all" } ──►│   ← Two requests in flight
  │                                    │
  │◄── { id: 2, type: "result" } ─────│   ← Response to id:2 arrives first
  │◄── { id: 1, type: "result" } ─────│   ← Response to id:1 arrives second
```

### Push Channels

Push messages are server-initiated — they don't correlate to any request. They arrive on named channels:

| Channel | Source | When |
|---------|--------|------|
| `subscription` | Store reactive queries | Data changes that affect a subscribed query |
| `event` | Rules engine | A rule fires and produces an event matching a subscribed pattern |

Each push carries a `subscriptionId` so the client knows which subscription it belongs to.

## Operation Namespaces

Operations are routed by prefix:

| Prefix | Purpose | Examples |
|--------|---------|----------|
| `store.*` | Store CRUD, queries, subscriptions, transactions | `store.insert`, `store.where`, `store.subscribe` |
| `rules.*` | Rules engine events, facts, subscriptions | `rules.emit`, `rules.setFact`, `rules.subscribe` |
| `auth.*` | Authentication and session management | `auth.login`, `auth.logout`, `auth.whoami` |

## Connection Lifecycle

```text
 1. CONNECT
    Client opens WebSocket to ws://host:port/

 2. WELCOME
    Server sends: { type: "welcome", version: "1.0.0",
                    requiresAuth: true/false, serverTime: ... }

 3. AUTH (if requiresAuth is true)
    Client sends:  { id: 1, type: "auth.login", token: "..." }
    Server sends:  { id: 1, type: "result", data: { userId, roles } }

 4. OPERATIONS
    Client sends requests, server responds with results/errors.
    Server pushes subscription/event updates asynchronously.

 5. HEARTBEAT (ongoing)
    Server sends: { type: "ping", timestamp: ... }
    Client sends: { type: "pong", timestamp: ... }
    If no pong within timeout → server closes with code 4001.

 6. CLOSE
    Either side closes the WebSocket.
    Server cleans up: unsubscribes all subscriptions, removes from registry.
```

## Error Model

Every error response includes a `code` string from a fixed set of 15 codes:

| Code | Meaning |
|------|---------|
| `PARSE_ERROR` | Invalid JSON |
| `INVALID_REQUEST` | Missing `id` or `type` |
| `UNKNOWN_OPERATION` | Unsupported operation type |
| `VALIDATION_ERROR` | Missing/invalid fields in the request |
| `NOT_FOUND` | Record or subscription not found |
| `ALREADY_EXISTS` | Duplicate key violation |
| `CONFLICT` | Version conflict in transaction |
| `UNAUTHORIZED` | Not authenticated |
| `FORBIDDEN` | Insufficient permissions |
| `RATE_LIMITED` | Too many requests |
| `BACKPRESSURE` | Server write buffer full |
| `INTERNAL_ERROR` | Unexpected server error |
| `BUCKET_NOT_DEFINED` | Unknown bucket name |
| `QUERY_NOT_DEFINED` | Unknown reactive query name |
| `RULES_NOT_AVAILABLE` | Rules engine not configured |

## Architecture Overview

```text
┌───────────────────────────────────────────────────┐
│                   NoexServer                       │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │       ConnectionSupervisor                    │ │
│  │       (simple_one_for_one, temporary)         │ │
│  │                                               │ │
│  │  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │ Connection #1 │  │ Connection #2 │   ...   │ │
│  │  │  (GenServer)  │  │  (GenServer)  │         │ │
│  │  │  ┌──────────┐│  │  ┌──────────┐│         │ │
│  │  │  │ WebSocket ││  │  │ WebSocket ││         │ │
│  │  │  │ Auth      ││  │  │ Auth      ││         │ │
│  │  │  │ Rate Limit││  │  │ Rate Limit││         │ │
│  │  │  │ Subs[]    ││  │  │ Subs[]    ││         │ │
│  │  │  └──────────┘│  │  └──────────┘│         │ │
│  │  └──────────────┘  └──────────────┘          │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─────────────┐  ┌────────────┐                  │
│  │    Store     │  │   Rules    │  (optional)      │
│  └─────────────┘  └────────────┘                  │
└───────────────────────────────────────────────────┘
```

Each connection is a GenServer that owns:
- The WebSocket reference
- Authentication session state
- Rate limiter key
- List of active subscription IDs

When the WebSocket closes (or the GenServer crashes), all state is cleaned up automatically.

## Glossary

| Term | Definition |
|------|-----------|
| **Bucket** | A named collection of records in the store, defined with a schema |
| **Connection** | A single WebSocket session managed by a dedicated GenServer |
| **GenServer** | An actor-like process that holds state and processes messages sequentially |
| **Push** | A server-initiated message delivered to the client without a prior request |
| **Reactive query** | A named query defined on the store that can be subscribed to; results are pushed when data changes |
| **Subscription** | A client's registration to receive push updates for a reactive query or rules pattern |
| **Supervisor** | A process that monitors child processes and handles failures (cleanup, restart) |

## Exercise

Given the following sequence of WebSocket messages, identify each message's category (request, response, push, or system) and explain what happened:

```jsonc
← { "type": "welcome", "version": "1.0.0", "requiresAuth": false, "serverTime": 1706745600000 }
→ { "id": 1, "type": "store.insert", "bucket": "notes", "data": { "text": "Hello" } }
← { "id": 1, "type": "result", "data": { "id": "n1", "text": "Hello", "_version": 1 } }
→ { "id": 2, "type": "store.subscribe", "query": "all-notes" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-1" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [{ "id": "n1", "text": "Hello" }] }
← { "type": "ping", "timestamp": 1706745630000 }
→ { "type": "pong", "timestamp": 1706745630000 }
```

<details>
<summary>Solution</summary>

1. **System (welcome)** — server greets the client with protocol version and auth requirements
2. **Request** — client inserts a record into the `notes` bucket
3. **Response** — server confirms the insert, returns the record with generated `id` and `_version`
4. **Request** — client subscribes to the `all-notes` reactive query
5. **Response** — server confirms subscription, returns `subscriptionId`
6. **Push** — server pushes the current query result (the note we just inserted) on the `subscription` channel
7. **System (ping)** — server checks if the client is alive
8. **Request (pong)** — client responds to the ping

Note: the push on line 6 arrives asynchronously — it's the initial result of the subscribed query, not a response to any request.

</details>

## Summary

- The protocol has four message categories: request, response, push, and system
- Request/response correlation uses the `id` field
- Push messages arrive on named channels (`subscription`, `event`) with a `subscriptionId`
- Operations are namespaced: `store.*`, `rules.*`, `auth.*`
- The connection lifecycle: connect → welcome → auth → operations → heartbeat → close
- Each connection is a GenServer with isolated state and automatic cleanup
- 15 typed error codes cover every failure mode

---

Next: [Your First Server](../02-getting-started/01-first-server.md)
