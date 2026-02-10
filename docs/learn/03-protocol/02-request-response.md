# Request and Response

Every client action follows the request/response pattern: the client sends a JSON message with an `id` and operation `type`, the server processes it and responds with the same `id`. This chapter covers correlation, routing, and concurrent requests.

## What You'll Learn

- How request/response correlation works via the `id` field
- How operations are routed by namespace prefix
- How to handle concurrent requests safely
- What happens with malformed requests

## Correlation via `id`

Every request must include a numeric `id`. The server includes this `id` in the corresponding response. This is how the client matches responses to requests:

```jsonc
// Request
→ { "id": 42, "type": "store.get", "bucket": "users", "key": "abc" }

// Response (matches id: 42)
← { "id": 42, "type": "result", "data": { "id": "abc", "name": "Alice", ... } }
```

**Rules:**
- `id` must be present — missing `id` returns `INVALID_REQUEST` with `id: 0`
- `id` should be numeric — the server echoes it as-is
- Client is responsible for unique IDs (incrementing counter is the simplest approach)
- The server does not enforce uniqueness — it simply echoes whatever `id` was sent

## Operation Routing

The `type` field determines which subsystem handles the request:

```text
type: "store.insert"   →  Store proxy  →  store.insert()
type: "rules.emit"     →  Rules proxy  →  engine.emit()
type: "auth.login"     →  Auth handler →  validate(token)
type: "pong"           →  Heartbeat    →  (acknowledged silently)
```

| Prefix | Subsystem | Requires |
|--------|-----------|----------|
| `store.*` | Store proxy | Store always available |
| `rules.*` | Rules proxy | `rules` configured in ServerConfig |
| `auth.*` | Auth handler | `auth` configured in ServerConfig |

Unrecognized operations return `UNKNOWN_OPERATION`:

```jsonc
→ { "id": 1, "type": "magic.spell" }
← { "id": 1, "type": "error", "code": "UNKNOWN_OPERATION", "message": "Unknown operation: magic.spell" }
```

## Request Pipeline

Every request passes through these stages:

```text
1. Parse JSON
   ├── Invalid JSON → PARSE_ERROR (id: 0)
   └── Valid JSON ↓

2. Validate structure
   ├── Missing id or type → INVALID_REQUEST
   └── Valid ↓

3. Auth check (if auth.required)
   ├── Not authenticated → UNAUTHORIZED
   └── Authenticated (or auth not required) ↓

4. Rate limit check (if rateLimit configured)
   ├── Exceeded → RATE_LIMITED
   └── Within limits ↓

5. Permission check (if permissions configured)
   ├── Denied → FORBIDDEN
   └── Allowed ↓

6. Route to handler
   ├── store.* → Store proxy
   ├── rules.* → Rules proxy
   ├── auth.* → Auth handler
   └── unknown → UNKNOWN_OPERATION

7. Execute and respond
   ├── Success → { id, type: "result", data }
   └── Error → { id, type: "error", code, message }
```

## Concurrent Requests

Multiple requests can be in flight simultaneously. The server processes them independently and may respond out of order:

```jsonc
// Client sends two requests quickly
→ { "id": 1, "type": "store.all", "bucket": "users" }      // slow (many records)
→ { "id": 2, "type": "store.count", "bucket": "products" }  // fast (just a number)

// Server responds — id:2 may arrive before id:1
← { "id": 2, "type": "result", "data": 5 }
← { "id": 1, "type": "result", "data": [{ ... }, { ... }, ...] }
```

This is why `id` correlation is critical. Without it, you can't tell which response belongs to which request.

## Working Example

A robust client that sends concurrent requests:

```typescript
import { WebSocket } from 'ws';

let nextId = 1;

function sendRequest(ws: WebSocket, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

// Usage: fire two requests concurrently
const [users, count] = await Promise.all([
  sendRequest(ws, { type: 'store.all', bucket: 'users' }),
  sendRequest(ws, { type: 'store.count', bucket: 'users' }),
]);

console.log(users.data);  // [{...}, {...}]
console.log(count.data);  // 2
```

## Error Responses

Error responses always include `code` and `message`. Some include `details`:

```jsonc
// Validation error with details
← {
    "id": 5,
    "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing required field: bucket",
    "details": { "field": "bucket" }
  }

// Rate limited with retry hint
← {
    "id": 6,
    "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded",
    "details": { "retryAfterMs": 1500 }
  }
```

**Important:** An error on one request does not affect other requests or the connection itself. The connection stays open and functional.

## Exercise

Write a function `sendBatch` that takes a WebSocket and an array of payloads, sends them all concurrently, and returns an array of responses in the same order as the payloads.

<details>
<summary>Solution</summary>

```typescript
async function sendBatch(
  ws: WebSocket,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return Promise.all(
    payloads.map((payload) => sendRequest(ws, payload)),
  );
}

// Usage
const results = await sendBatch(ws, [
  { type: 'store.insert', bucket: 'users', data: { name: 'Alice' } },
  { type: 'store.insert', bucket: 'users', data: { name: 'Bob' } },
  { type: 'store.count', bucket: 'users' },
]);
// results[0] = insert result for Alice
// results[1] = insert result for Bob
// results[2] = count result
```

This works because each `sendRequest` call uses its own `id` and resolves independently. `Promise.all` preserves the original order.

</details>

## Summary

- Every request carries an `id` that the server echoes in the response
- Operations are routed by prefix: `store.*`, `rules.*`, `auth.*`
- The request pipeline: parse → validate → auth → rate limit → permission → route → respond
- Concurrent requests are independent — responses may arrive out of order
- Errors on one request don't break the connection or other requests
- Use `Promise.all` with `sendRequest` for concurrent operations

---

Next: [Push Messages](./03-push-messages.md)
