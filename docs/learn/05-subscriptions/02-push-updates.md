# Push Updates

After subscribing, the server automatically sends push messages whenever the query result changes. You don't need to poll — new data arrives as soon as it's available.

## What You'll Learn

- The push message format
- How insert, update, and delete trigger pushes
- Why some mutations don't produce a push (deep equality)
- Scalar vs array push data
- How pushes work across multiple clients

## Server Setup

Same as the [previous chapter](./01-subscribing.md):

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'push-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});

store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Push Message Format

Push messages are server-initiated — they arrive without a corresponding request. They have no `id` field:

```jsonc
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [ /* updated query result */ ]
}
```

| Field | Description |
|-------|-------------|
| `type` | Always `"push"` |
| `channel` | Always `"subscription"` for store subscriptions |
| `subscriptionId` | Matches the ID from the subscribe response |
| `data` | The complete, updated query result |

**Important:** Push `data` is always the *full* result — not a diff. If you subscribed to `all-users` and a third user is inserted, the push contains all three users, not just the new one.

## Push on Insert

```jsonc
// 1. Subscribe
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Insert a user
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

// 3. Push arrives automatically
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }
```

## Push on Update

```jsonc
// After subscribing and inserting Alice...

// Update Alice's role
→ { "id": 3, "type": "store.update", "bucket": "users",
    "key": "a1", "data": { "name": "Alice Smith" } }
← { "id": 3, "type": "result",
    "data": { "id": "a1", "name": "Alice Smith", "role": "user", "_version": 2 } }

// Push with updated data
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice Smith", "role": "user", "_version": 2 }] }
```

## Push on Delete

```jsonc
// Delete Alice
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "a1" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// Push with empty result
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [] }
```

## Deep Equality — No Unnecessary Pushes

The server compares the new query result with the previous one using deep equality. If they're the same, no push is sent. This prevents noise:

```jsonc
// Subscribe to admin users (initially empty)
→ { "id": 1, "type": "store.subscribe", "query": "users-by-role",
    "params": { "role": "admin" } }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Insert a regular user — query result is still [] → no push
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Regular", "role": "user" } }
← { "id": 2, "type": "result", "data": { ... } }
// ← (no push — admin list unchanged)

// Insert an admin — query result changes → push
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Admin", "role": "admin" } }
← { "id": 3, "type": "result", "data": { ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "x1", "name": "Admin", "role": "admin", "_version": 1 }] }
```

This is especially useful for scalar queries like `count` — updating a user's name doesn't change the count, so no push is sent.

## Scalar Push Data

For scalar queries, push `data` is a plain value, not an array:

```jsonc
// Subscribe to count
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }

// Insert a user
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result", "data": { ... } }

// Push: count is now 1 (not [1], not { count: 1 })
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 1 }
```

## Sequential Pushes

Each mutation that changes the query result triggers a separate push:

```jsonc
// Subscribe to count (initially 0)
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }

// Insert first user → push with count 1
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 1 }

// Insert second user → push with count 2
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 2 }
```

## Multi-Client Push

Subscriptions work across client boundaries. When Client B mutates data, Client A receives pushes for its active subscriptions:

```text
Client A                             Server                           Client B
   │                                    │                                │
   │── subscribe "all-users" ─────────►│                                │
   │◄── { subscriptionId: "sub-1",     │                                │
   │     data: [] }                     │                                │
   │                                    │                                │
   │                                    │◄── insert { name: "Bob" } ────│
   │                                    │──► result { id: "b1" } ───────►│
   │                                    │                                │
   │◄── push { subscriptionId: "sub-1",│                                │
   │     data: [{ name: "Bob" }] } ────│                                │
```

Each client's subscriptions are independent. Client A and Client B can subscribe to the same query and each receives their own pushes:

```jsonc
// Client A subscribes to all-users → gets sub-1
// Client B subscribes to user-count → gets sub-2
// Client A inserts a user:

// Client A receives: push on sub-1 with updated user list
// Client B receives: push on sub-2 with updated count
```

## Push Timing

Push messages arrive asynchronously after the mutation response. The server:
1. Processes the mutation (insert/update/delete)
2. Sends the result back to the requesting client
3. Re-evaluates affected queries
4. Compares new results to previous results
5. Sends push messages only where results changed

In practice, pushes arrive within milliseconds of the mutation. In tests, you can use `store.settle()` on the server to wait for all pending re-evaluations before asserting on push messages.

## Working Example

```typescript
// Subscribe
const subResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const subscriptionId = subResp.data.subscriptionId;

// Set up push listener BEFORE the mutation
const pushPromise = waitForPush(ws, subscriptionId);

// Mutate
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

// Wait for push
const push = await pushPromise;
console.log(push.data); // [{ id: "...", name: "Alice", role: "user", _version: 1 }]
```

**Tip:** Always set up the push listener *before* the mutation that triggers it. Otherwise you might miss the push.

## Exercise

Subscribe to both `all-users` and `user-count`. Insert a user, then verify you receive pushes on both subscriptions — one with the user array, one with the count.

<details>
<summary>Solution</summary>

```jsonc
// 1. Subscribe to all-users
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Subscribe to user-count
→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// 3. Insert a user
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

// 4. Two pushes arrive:
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }

← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }
```

</details>

## Summary

- Push messages have format: `{ type: "push", channel: "subscription", subscriptionId, data }`
- `data` is always the full updated result — not a diff
- Insert, update, and delete on subscribed buckets trigger re-evaluation
- No push is sent when the result hasn't actually changed (deep equality)
- Scalar queries push plain values; array queries push arrays
- Push works across clients — Client B's mutation triggers Client A's push
- Set up push listeners before mutations to avoid missing messages

---

Next: [Parameterized Queries](./03-parameterized-queries.md)
