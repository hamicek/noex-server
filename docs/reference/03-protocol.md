# Protocol

WebSocket protocol specification for communication between clients and the noex-server. All messages are JSON-encoded UTF-8 strings.

## Import

```typescript
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type ClientMessage,
  type SuccessResponse,
  type ErrorResponse,
  type PushMessage,
  type WelcomeMessage,
  type HeartbeatPing,
  type HeartbeatPong,
  type SystemMessage,
  type ServerMessage,
} from '@hamicek/noex-server';
```

---

## Protocol Version

```typescript
const PROTOCOL_VERSION = '1.0.0';
```

Sent in the `WelcomeMessage` upon connection. Clients can use this to verify compatibility.

---

## Connection Lifecycle

```
Client                                Server
  |                                     |
  |  ── WebSocket connect ──────────►   |
  |                                     |
  |  ◄── WelcomeMessage ────────────   |
  |      { type: "welcome",            |
  |        version, serverTime,         |
  |        requiresAuth }               |
  |                                     |
  |  ── auth.login (if required) ──►   |
  |  ◄── SuccessResponse ───────────   |
  |                                     |
  |  ── ClientRequest ──────────────►   |
  |  ◄── SuccessResponse / Error ────  |
  |                                     |
  |  ◄── PushMessage (subscription) ── |
  |                                     |
  |  ◄── HeartbeatPing ─────────────   |
  |  ── HeartbeatPong ──────────────►   |
  |                                     |
  |  ◄── SystemMessage (shutdown) ───  |
  |                                     |
  |  ── WebSocket close ────────────►   |
```

1. Client opens a WebSocket connection to the server's configured `path` (default: `/`).
2. Server immediately sends a `WelcomeMessage` with the protocol version and auth requirement.
3. If `requiresAuth` is `true`, the client must send an `auth.login` request before any other operation.
4. Client sends `ClientRequest` messages; server responds with `SuccessResponse` or `ErrorResponse`.
5. Subscriptions generate asynchronous `PushMessage` frames.
6. Server sends periodic `HeartbeatPing`; client must reply with `HeartbeatPong`.
7. Before graceful shutdown, the server may send a `SystemMessage` with a grace period.

---

## Client → Server

### ClientRequest

```typescript
interface ClientRequest {
  readonly id: number;
  readonly type: string;
  readonly [key: string]: unknown;
}
```

Every client request must include a numeric `id` for response correlation and a `type` string identifying the operation. Additional fields depend on the operation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | `number` | yes | Request identifier. Must be a finite number. Server echoes this in the response. |
| type | `string` | yes | Operation name (e.g., `"store.get"`, `"auth.login"`). Must be non-empty. |
| ...fields | `unknown` | — | Operation-specific parameters. |

**Example:**

```json
{
  "id": 1,
  "type": "store.get",
  "bucket": "users",
  "key": "user-1"
}
```

### HeartbeatPong

```typescript
interface HeartbeatPong {
  readonly type: 'pong';
  readonly timestamp: number;
}
```

Sent by the client in response to a `HeartbeatPing`. The `timestamp` must match the value from the ping. No `id` field is required.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | `'pong'` | yes | Must be `"pong"`. |
| timestamp | `number` | yes | Timestamp from the corresponding `HeartbeatPing`. Must be a finite number. |

**Example:**

```json
{
  "type": "pong",
  "timestamp": 1700000000000
}
```

### ClientMessage

```typescript
type ClientMessage = ClientRequest | HeartbeatPong;
```

Union of all message types the client can send to the server.

---

## Server → Client

### SuccessResponse

```typescript
interface SuccessResponse {
  readonly id: number;
  readonly type: 'result';
  readonly data: unknown;
}
```

Sent when a `ClientRequest` is processed successfully.

| Field | Type | Description |
|-------|------|-------------|
| id | `number` | Matches the `id` from the original `ClientRequest`. |
| type | `'result'` | Always `"result"`. |
| data | `unknown` | Operation result. Shape depends on the operation. |

**Example:**

```json
{
  "id": 1,
  "type": "result",
  "data": { "name": "Alice", "age": 30 }
}
```

### ErrorResponse

```typescript
interface ErrorResponse {
  readonly id: number;
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}
```

Sent when a request fails. The `id` field matches the original request. For parse errors where no valid `id` can be extracted, `id` is `0`.

| Field | Type | Description |
|-------|------|-------------|
| id | `number` | Matches the request `id`, or `0` for parse errors. |
| type | `'error'` | Always `"error"`. |
| code | `ErrorCode` | Machine-readable error code (see [Errors](./10-errors.md)). |
| message | `string` | Human-readable error description. |
| details | `unknown` | Optional structured data (e.g., `{ retryAfterMs }` for rate limiting). |

**Example:**

```json
{
  "id": 42,
  "type": "error",
  "code": "NOT_FOUND",
  "message": "Key \"user-999\" not found in bucket \"users\""
}
```

### PushMessage

```typescript
interface PushMessage {
  readonly type: 'push';
  readonly channel: string;
  readonly subscriptionId: string;
  readonly data: unknown;
}
```

Asynchronous notification sent by the server when a subscription fires. Push messages are not correlated with any request — they have no `id`.

| Field | Type | Description |
|-------|------|-------------|
| type | `'push'` | Always `"push"`. |
| channel | `string` | Push channel: `"subscription"` for store subscriptions, `"event"` for rules subscriptions. |
| subscriptionId | `string` | Matches the `subscriptionId` returned when the subscription was created. |
| data | `unknown` | Payload. For store: the updated query result. For rules: the event data. |

**Example — store subscription push:**

```json
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [{ "name": "Alice" }, { "name": "Bob" }]
}
```

**Example — rules event push:**

```json
{
  "type": "push",
  "channel": "event",
  "subscriptionId": "sub-2",
  "data": { "topic": "order:created", "data": { "orderId": "ORD-001" } }
}
```

### WelcomeMessage

```typescript
interface WelcomeMessage {
  readonly type: 'welcome';
  readonly version: string;
  readonly serverTime: number;
  readonly requiresAuth: boolean;
}
```

Sent immediately after a WebSocket connection is established.

| Field | Type | Description |
|-------|------|-------------|
| type | `'welcome'` | Always `"welcome"`. |
| version | `string` | Protocol version (currently `"1.0.0"`). |
| serverTime | `number` | Server timestamp (ms since epoch) at the time of connection. |
| requiresAuth | `boolean` | Whether the client must authenticate before sending other requests. |

**Example:**

```json
{
  "type": "welcome",
  "version": "1.0.0",
  "serverTime": 1700000000000,
  "requiresAuth": true
}
```

### HeartbeatPing

```typescript
interface HeartbeatPing {
  readonly type: 'ping';
  readonly timestamp: number;
}
```

Periodic heartbeat sent by the server. The client must respond with a `HeartbeatPong` containing the same `timestamp`. If the client does not respond before the next tick, the server closes the connection with code `4001`.

| Field | Type | Description |
|-------|------|-------------|
| type | `'ping'` | Always `"ping"`. |
| timestamp | `number` | Server timestamp (ms since epoch). Client must echo this in the pong. |

**Example:**

```json
{
  "type": "ping",
  "timestamp": 1700000000000
}
```

### SystemMessage

```typescript
interface SystemMessage {
  readonly type: 'system';
  readonly event: string;
  readonly [key: string]: unknown;
}
```

Server-initiated system notification. Currently used for graceful shutdown announcements.

| Field | Type | Description |
|-------|------|-------------|
| type | `'system'` | Always `"system"`. |
| event | `string` | Event name (e.g., `"shutdown"`). |
| ...fields | `unknown` | Event-specific data. |

**Example — shutdown notification:**

```json
{
  "type": "system",
  "event": "shutdown",
  "gracePeriodMs": 5000
}
```

### ServerMessage

```typescript
type ServerMessage =
  | SuccessResponse
  | ErrorResponse
  | PushMessage
  | WelcomeMessage
  | HeartbeatPing
  | SystemMessage;
```

Union of all message types the server can send to the client. Discriminated by the `type` field.

---

## Operation Types

The `type` field in `ClientRequest` determines which operation is executed. Operations are grouped by namespace:

| Namespace | Operations | Description |
|-----------|------------|-------------|
| `store.*` | `store.insert`, `store.get`, `store.update`, `store.delete`, `store.all`, `store.where`, `store.findOne`, `store.count`, `store.first`, `store.last`, `store.paginate`, `store.sum`, `store.avg`, `store.min`, `store.max`, `store.clear`, `store.buckets`, `store.stats`, `store.subscribe`, `store.unsubscribe`, `store.transaction` | Store CRUD, queries, aggregations, subscriptions |
| `rules.*` | `rules.emit`, `rules.setFact`, `rules.getFact`, `rules.deleteFact`, `rules.queryFacts`, `rules.getAllFacts`, `rules.subscribe`, `rules.unsubscribe`, `rules.stats` | Rule engine operations |
| `auth.*` | `auth.login`, `auth.logout`, `auth.whoami` | Authentication |
| `server.*` | `server.stats`, `server.connections` | Server introspection |

---

## Message Validation

The server validates incoming messages in this order:

1. **JSON parsing** — Message must be valid JSON. On failure: `PARSE_ERROR` with `id: 0`.
2. **Object check** — Must be a JSON object (not array, null, or primitive). On failure: `PARSE_ERROR` with `id: 0`.
3. **Type field** — Must include a non-empty string `type`. On failure: `INVALID_REQUEST` with `id: 0`.
4. **Pong handling** — If `type` is `"pong"`, `timestamp` must be a finite number. No `id` required.
5. **ID field** — For all other messages, `id` must be a finite number. On failure: `INVALID_REQUEST` with `id: 0`.

---

## Request Processing Pipeline

After validation, each request passes through:

```
ClientRequest
  → checkAuth()        → UNAUTHORIZED / FORBIDDEN
  → checkRateLimit()   → RATE_LIMITED
  → routeRequest()     → SuccessResponse / ErrorResponse
```

1. **Auth check** — Skipped for `auth.*` operations. If auth is required and the client is not authenticated, returns `UNAUTHORIZED`. If the session has expired, clears the session and returns `UNAUTHORIZED`. If permissions are configured, checks operation permissions — returns `FORBIDDEN` on failure.
2. **Rate limit check** — If rate limiting is configured, consumes a token. Returns `RATE_LIMITED` with `retryAfterMs` on failure.
3. **Route** — Dispatches to the appropriate handler based on the `type` namespace prefix.

---

## WebSocket Close Codes

| Code | Reason | Description |
|------|--------|-------------|
| 1000 | `normal_closure` | Clean shutdown initiated by the server. |
| 1001 | `server_shutting_down` | Connection rejected because the server is shutting down. |
| 4001 | `heartbeat_timeout` | Client did not respond to heartbeat ping in time. |

---

## See Also

- [Errors](./10-errors.md) — Error codes and error class
- [Store Operations](./04-store-operations.md) — Store CRUD and query operations
- [Store Subscriptions](./05-store-subscriptions.md) — Store subscriptions and transactions
- [Rules Operations](./06-rules-operations.md) — Rule engine operations
- [Authentication](./07-authentication.md) — Auth operations
- [Lifecycle](./08-lifecycle.md) — Heartbeat, backpressure, connection limits
