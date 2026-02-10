# Managing Subscriptions

Control the subscription lifecycle: unsubscribe when you no longer need updates, understand connection limits, and know what happens when a client disconnects.

## What You'll Learn

- How to unsubscribe with `store.unsubscribe`
- What happens when you unsubscribe (no more pushes)
- Error handling for invalid unsubscribe attempts
- Subscription limits per connection (`maxSubscriptionsPerConnection`)
- Automatic cleanup on client disconnect

## store.unsubscribe

Removes an active subscription. After unsubscribing, no more push messages are sent for that subscription.

```jsonc
// Request
→ { "id": 1, "type": "store.unsubscribe", "subscriptionId": "sub-1" }

// Response
← { "id": 1, "type": "result", "data": { "unsubscribed": true } }
```

**Required fields:** `subscriptionId`

## No Push After Unsubscribe

After unsubscribing, mutations no longer trigger pushes for that subscription:

```jsonc
// 1. Subscribe
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Unsubscribe
→ { "id": 2, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 2, "type": "result", "data": { "unsubscribed": true } }

// 3. Insert a user — no push for sub-1
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result", "data": { ... } }
// (no push — sub-1 is gone)
```

## Independent Subscriptions

Unsubscribing from one subscription does not affect others:

```jsonc
// Subscribe to two queries
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// Unsubscribe from all-users only
→ { "id": 3, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 3, "type": "result", "data": { "unsubscribed": true } }

// Insert a user
→ { "id": 4, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 4, "type": "result", "data": { ... } }

// sub-2 still receives pushes
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }
// (no push for sub-1 — it's unsubscribed)
```

## Error Handling

| Error Code | Cause |
|-----------|-------|
| `NOT_FOUND` | The `subscriptionId` doesn't match any active subscription |
| `VALIDATION_ERROR` | The `subscriptionId` field is missing or empty |

```jsonc
// Unknown subscription ID
→ { "id": 5, "type": "store.unsubscribe", "subscriptionId": "sub-nonexistent" }
← { "id": 5, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-nonexistent\" not found" }

// Double unsubscribe
→ { "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 6, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-1\" not found" }

// Missing subscriptionId
→ { "id": 7, "type": "store.unsubscribe" }
← { "id": 7, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"subscriptionId\": expected non-empty string" }
```

## Subscription Limits

Each connection has a maximum number of active subscriptions (store + rules combined). The default limit is **100**.

```typescript
const server = await NoexServer.start({
  store,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50, // custom limit
  },
});
```

When a client exceeds the limit, the server responds with `RATE_LIMITED`:

```jsonc
// 101st subscription on default config
→ { "id": 101, "type": "store.subscribe", "query": "all-users" }
← { "id": 101, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 100 per connection)" }
```

The limit counts both store subscriptions and rules subscriptions together on the same connection.

## Cleanup on Disconnect

When a client disconnects (closes the WebSocket), the server automatically:
1. Calls the unsubscribe function for every active subscription on that connection
2. Clears the subscription maps
3. Closes the WebSocket

You don't need to manually unsubscribe before disconnecting — the server handles cleanup. This prevents resource leaks from abandoned connections.

```text
Client                               Server
   │                                    │
   │── subscribe "all-users" ─────────►│  (sub-1 created)
   │◄── { subscriptionId: "sub-1" }    │
   │                                    │
   │── subscribe "user-count" ────────►│  (sub-2 created)
   │◄── { subscriptionId: "sub-2" }    │
   │                                    │
   │── disconnect ─────────────────────►│
   │                                    │  (auto-cleanup: sub-1, sub-2 removed)
   │                                    │  (future mutations → no pushes)
```

## Working Example

```typescript
// Create two subscriptions
const sub1 = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const sub1Id = sub1.data.subscriptionId;

const sub2 = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'user-count',
});
const sub2Id = sub2.data.subscriptionId;

// Unsubscribe from the first one
const unsub = await sendRequest(ws, {
  type: 'store.unsubscribe',
  subscriptionId: sub1Id,
});
console.log(unsub.data); // { unsubscribed: true }

// Insert a user — only sub2 (count) triggers a push
const pushPromise = waitForPush(ws, sub2Id);
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});
const push = await pushPromise;
console.log(push.data); // 1
```

## Exercise

Write a sequence that demonstrates subscription lifecycle:
1. Subscribe to `all-users` and `user-count`
2. Insert a user and verify both subscriptions receive pushes
3. Unsubscribe from `all-users`
4. Insert another user and verify only `user-count` receives a push
5. Unsubscribe from `user-count`
6. Verify that unsubscribing from `all-users` again returns `NOT_FOUND`

<details>
<summary>Solution</summary>

```jsonc
// 1. Subscribe to both
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// 2. Insert → both get pushes
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result", "data": { "id": "a1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }

// 3. Unsubscribe from all-users
→ { "id": 4, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 4, "type": "result", "data": { "unsubscribed": true } }

// 4. Insert → only user-count gets a push
→ { "id": 5, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "id": 5, "type": "result", "data": { "id": "b1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 2 }
// (no push for sub-1)

// 5. Unsubscribe from user-count
→ { "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-2" }
← { "id": 6, "type": "result", "data": { "unsubscribed": true } }

// 6. Double unsubscribe → NOT_FOUND
→ { "id": 7, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 7, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-1\" not found" }
```

</details>

## Summary

- `store.unsubscribe` stops push messages for a given `subscriptionId`
- Unsubscribing one subscription doesn't affect others
- `NOT_FOUND` if the subscription doesn't exist or was already unsubscribed
- Default limit: 100 subscriptions per connection (store + rules combined), configurable via `connectionLimits.maxSubscriptionsPerConnection`
- Exceeding the limit returns `RATE_LIMITED`
- On disconnect, the server auto-cleans all subscriptions — no manual cleanup needed

---

Next: [Atomic Operations](../06-transactions/01-atomic-operations.md)
