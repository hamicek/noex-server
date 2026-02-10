# Message Format

Every message in noex-server is a JSON object sent as a WebSocket text frame. This chapter covers the structure of all message types in protocol version 1.0.0.

## What You'll Learn

- The JSON-over-WebSocket format
- The four message categories and their structures
- How to identify what kind of message you received
- Protocol versioning

## Protocol Version

The current protocol version is `1.0.0`. The server reports it in the welcome message. All messages follow the structures defined in this chapter.

## Message Categories

### 1. Request (Client → Server)

Every request must include:
- `id` — a numeric identifier (used for response correlation)
- `type` — the operation name (e.g., `"store.insert"`)
- Additional fields depending on the operation

```jsonc
{ "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
{ "id": 2, "type": "store.get", "bucket": "users", "key": "abc123" }
{ "id": 3, "type": "store.all", "bucket": "users" }
{ "id": 4, "type": "auth.login", "token": "my-jwt-token" }
```

Missing `id` results in `INVALID_REQUEST`. Missing `type` results in `INVALID_REQUEST`. Invalid JSON results in `PARSE_ERROR`.

### 2. Response (Server → Client)

Responses echo the request's `id` and have `type` of either `"result"` or `"error"`:

**Success:**

```jsonc
{
  "id": 1,
  "type": "result",
  "data": { "id": "abc123", "name": "Alice", "role": "user", "_version": 1, "_createdAt": 1706745600000 }
}
```

**Error:**

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: name",
  "details": { "field": "name" }
}
```

The `data` field in success responses varies by operation. The `details` field in errors is optional and provides additional context.

### 3. Push (Server → Client)

Push messages have no `id` — they're not responses to any request. They arrive asynchronously when subscribed data changes.

```jsonc
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [{ "id": "abc123", "name": "Alice" }, { "id": "def456", "name": "Bob" }]
}
```

```jsonc
{
  "type": "push",
  "channel": "event",
  "subscriptionId": "sub-2",
  "data": { "topic": "order.created", "event": { "orderId": "ORD-1" } }
}
```

| Field | Description |
|-------|-------------|
| `type` | Always `"push"` |
| `channel` | `"subscription"` (store queries) or `"event"` (rules engine) |
| `subscriptionId` | Identifies which subscription this push belongs to |
| `data` | The payload — array for query results, object for events |

### 4. System (Server → Client)

System messages are control messages from the server:

**Welcome** (sent immediately on connection):

```jsonc
{
  "type": "welcome",
  "version": "1.0.0",
  "requiresAuth": false,
  "serverTime": 1706745600000
}
```

**Ping** (heartbeat):

```jsonc
{ "type": "ping", "timestamp": 1706745600000 }
```

The client must respond with:

```jsonc
{ "type": "pong", "timestamp": 1706745600000 }
```

**Shutdown** (graceful shutdown notification):

```jsonc
{ "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
```

## Quick Reference: Identifying Messages

```text
Received a message. What is it?

  Has "id" field?
  ├── Yes → It's a RESPONSE
  │         type === "result" → Success
  │         type === "error"  → Error
  └── No  → Check "type" field
            type === "push"    → PUSH message
            type === "welcome" → System: welcome
            type === "ping"    → System: heartbeat
            type === "system"  → System: shutdown/other
```

## Working Example

A client that classifies every incoming message:

```typescript
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.id !== undefined) {
    // Response to a request
    if (msg.type === 'result') {
      console.log(`Response #${msg.id}: success`, msg.data);
    } else if (msg.type === 'error') {
      console.log(`Response #${msg.id}: error ${msg.code}`, msg.message);
    }
  } else if (msg.type === 'push') {
    console.log(`Push on ${msg.channel} [${msg.subscriptionId}]:`, msg.data);
  } else if (msg.type === 'welcome') {
    console.log(`Connected to protocol v${msg.version}`);
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
  } else if (msg.type === 'system') {
    console.log(`System event: ${msg.event}`);
  }
});
```

## Exercise

Given this raw WebSocket log, identify each message's category and purpose:

```
← {"type":"welcome","version":"1.0.0","requiresAuth":true,"serverTime":1706745600000}
→ {"id":1,"type":"auth.login","token":"abc"}
← {"id":1,"type":"error","code":"UNAUTHORIZED","message":"Invalid token"}
→ {"id":2,"type":"auth.login","token":"valid-token"}
← {"id":2,"type":"result","data":{"userId":"u1","roles":["user"]}}
→ {"id":3,"type":"store.insert","bucket":"tasks","data":{"title":"Test"}}
← {"id":3,"type":"result","data":{"id":"t1","title":"Test","_version":1}}
← {"type":"ping","timestamp":1706745630000}
→ {"type":"pong","timestamp":1706745630000}
```

<details>
<summary>Solution</summary>

1. **System (welcome)** — server announces protocol v1.0.0, auth required
2. **Request** — client tries to authenticate with token "abc"
3. **Response (error)** — authentication failed, `UNAUTHORIZED`
4. **Request** — client retries with a valid token
5. **Response (success)** — authenticated as user "u1" with role "user"
6. **Request** — client inserts a task
7. **Response (success)** — task inserted with generated id and version
8. **System (ping)** — server heartbeat check
9. **Client message (pong)** — client responds to keep connection alive

</details>

## Summary

- All messages are JSON text frames over WebSocket
- Requests have `id` + `type`, responses echo the `id`
- Push messages have no `id` — they use `channel` + `subscriptionId`
- System messages: `welcome`, `ping`, `system` (shutdown)
- Check for `id` first to distinguish responses from other messages

---

Next: [Request and Response](./02-request-response.md)
