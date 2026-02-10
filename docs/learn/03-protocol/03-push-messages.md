# Push Messages

Push messages are server-initiated — they arrive without a preceding request. The server pushes data when a subscribed query result changes or a rules engine event matches a subscribed pattern.

## What You'll Learn

- How push messages differ from responses
- The two push channels: `subscription` and `event`
- How `subscriptionId` demultiplexes pushes
- How to handle pushes alongside request/response messages

## Push vs Response

| | Response | Push |
|---|----------|------|
| Has `id` | Yes — matches the request | No |
| Triggered by | A client request | Data change or rule match |
| Timing | After the request | Anytime (asynchronous) |
| Correlation | Via `id` field | Via `subscriptionId` |

```text
Client                                 Server
  │                                       │
  │── { id:1, type:"store.subscribe" } ──►│
  │◄── { id:1, type:"result", data:... }──│  ← Response (has id:1)
  │                                       │
  │   ... time passes, data changes ...   │
  │                                       │
  │◄── { type:"push", subscriptionId:... }│  ← Push (no id)
  │◄── { type:"push", subscriptionId:... }│  ← Push (no id)
```

## The Subscription Channel

When you subscribe to a store reactive query, pushes arrive on the `subscription` channel:

```jsonc
// Subscribe to a query
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-1" } }

// Push arrives when data changes
← {
    "type": "push",
    "channel": "subscription",
    "subscriptionId": "sub-1",
    "data": [
      { "id": "u1", "name": "Alice", "role": "user" },
      { "id": "u2", "name": "Bob", "role": "admin" }
    ]
  }
```

The `data` field contains the full, re-evaluated query result — not a diff. For array queries it's an array; for scalar queries (count, sum, etc.) it's a single value.

## The Event Channel

When you subscribe to rules engine events with a pattern, pushes arrive on the `event` channel:

```jsonc
// Subscribe to rule events
→ { "id": 2, "type": "rules.subscribe", "pattern": "order.*" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-2" } }

// Push arrives when a matching event fires
← {
    "type": "push",
    "channel": "event",
    "subscriptionId": "sub-2",
    "data": {
      "topic": "order.created",
      "event": { "orderId": "ORD-1", "total": 99.99 }
    }
  }
```

## Demultiplexing with subscriptionId

A client can have multiple active subscriptions. The `subscriptionId` tells you which one a push belongs to:

```text
Client has three subscriptions:
  sub-1 → "all-users" query
  sub-2 → "active-orders" query
  sub-3 → "alert.*" rules pattern

Incoming push:
  { type: "push", channel: "subscription", subscriptionId: "sub-2", data: [...] }
  → This is an update to the "active-orders" query.
```

## Handling Pushes in the Client

The `sendRequest` helper from Chapter 2.2 ignores pushes (they have no `id`). You need a separate mechanism to handle them:

```typescript
type PushHandler = (data: unknown) => void;

const pushHandlers = new Map<string, PushHandler>();

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'push') {
    const handler = pushHandlers.get(msg.subscriptionId);
    if (handler) {
      handler(msg.data);
    }
  }
  // Responses are handled by sendRequest's per-id handlers
});

// Register a push handler for a subscription
function onPush(subscriptionId: string, handler: PushHandler) {
  pushHandlers.set(subscriptionId, handler);
}

// Usage
const result = await sendRequest(ws, { type: 'store.subscribe', query: 'all-users' });
const subId = result.data.subscriptionId;

onPush(subId, (data) => {
  console.log('Users updated:', data);
});
```

## waitForPush Helper

For tests, you often need to wait for a specific push:

```typescript
function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Push timeout for ${subscriptionId}`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'push' && msg.subscriptionId === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg.data);
      }
    };

    ws.on('message', handler);
  });
}
```

**Important:** Set up the push listener BEFORE the mutation that triggers it. Otherwise you might miss the push.

## Working Example

```typescript
// Subscribe and listen for changes
const subResult = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const subId = subResult.data.subscriptionId;

// Set up push listener BEFORE inserting
const pushPromise = waitForPush(ws, subId);

// This insert will trigger a push
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Carol' },
});

// Wait for the push
const updatedUsers = await pushPromise;
console.log('Updated list:', updatedUsers);
// [{ id: "...", name: "Alice" }, { id: "...", name: "Bob" }, { id: "...", name: "Carol" }]
```

## Exercise

Write a message router function that takes a raw WebSocket message string and routes it to the correct handler based on type. It should handle: responses (by id), pushes (by subscriptionId), and system messages (welcome, ping).

<details>
<summary>Solution</summary>

```typescript
type ResponseHandler = (msg: Record<string, unknown>) => void;
type PushHandler = (data: unknown) => void;

const responseHandlers = new Map<number, ResponseHandler>();
const pushHandlers = new Map<string, PushHandler>();

function routeMessage(raw: string) {
  const msg = JSON.parse(raw);

  // Response (has id)
  if (msg.id !== undefined) {
    const handler = responseHandlers.get(msg.id);
    if (handler) {
      responseHandlers.delete(msg.id);
      handler(msg);
    }
    return;
  }

  // Push
  if (msg.type === 'push') {
    const handler = pushHandlers.get(msg.subscriptionId);
    if (handler) handler(msg.data);
    return;
  }

  // System messages
  if (msg.type === 'welcome') {
    console.log(`Protocol v${msg.version}, auth: ${msg.requiresAuth}`);
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
  } else if (msg.type === 'system') {
    console.log(`System: ${msg.event}`);
  }
}
```

</details>

## Summary

- Push messages have no `id` — they're server-initiated, not responses
- Two channels: `subscription` (store queries) and `event` (rules engine)
- `subscriptionId` demultiplexes pushes when you have multiple subscriptions
- Push data for store queries is the full re-evaluated result, not a diff
- Always set up push listeners BEFORE the mutation that triggers the push
- The `waitForPush` helper is essential for testing

---

Next: [Error Handling](./04-error-handling.md)
