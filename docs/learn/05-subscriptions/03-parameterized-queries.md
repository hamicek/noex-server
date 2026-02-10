# Parameterized Queries

Pass parameters to queries at subscription time. Instead of defining a separate query for each filter, define one query with parameters and let each client supply their own values.

## What You'll Learn

- How to define queries that accept parameters
- How to subscribe with the `params` field
- How different clients can use different parameters on the same query
- How pushes work with parameterized subscriptions

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'params-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    total:  { type: 'number', required: true },
    status: { type: 'string', default: 'pending' },
  },
});

// Parameterized query — filters users by role
store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});

// Parameterized query — filters orders by user
store.defineQuery('orders-for-user', async (ctx, params: { userId: string }) => {
  return ctx.bucket('orders').where({ userId: params.userId });
});

// Parameterized scalar query — counts orders by status
store.defineQuery('order-count-by-status', async (ctx, params: { status: string }) => {
  return ctx.bucket('orders').count({ status: params.status });
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Defining Queries with Parameters

The query function receives `params` as the second argument:

```typescript
store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});
```

Parameters can be any serializable value — objects, strings, numbers. The query function destructures them and uses them to filter, sort, or compute data.

## Subscribing with params

Pass the `params` field alongside `query` in the subscribe message:

```jsonc
// Subscribe to admin users only
→ { "id": 1, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "admin" } }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Subscribe to regular users
→ { "id": 2, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "user" } }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": [] } }
```

Each `(query, params)` combination creates an independent subscription with its own `subscriptionId` and its own push stream.

## Targeted Pushes

With parameterized subscriptions, pushes are targeted — you only receive updates when *your* filtered result changes:

```jsonc
// Two subscriptions active:
// sub-1: users-by-role { role: "admin" }
// sub-2: users-by-role { role: "user" }

// Insert a regular user
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob", "role": "user" } }
← { "id": 3, "type": "result", "data": { ... } }

// Only sub-2 receives a push (admin list unchanged)
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": [{ "id": "b1", "name": "Bob", "role": "user", "_version": 1 }] }
// (no push for sub-1)

// Insert an admin
→ { "id": 4, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "role": "admin" } }
← { "id": 4, "type": "result", "data": { ... } }

// Only sub-1 receives a push
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "admin", "_version": 1 }] }
// (no push for sub-2)
```

## Multiple Clients, Different Parameters

Different clients can subscribe to the same query with different parameters. Each receives pushes only for their own parameters:

```text
Client A (admin dashboard)           Server           Client B (user portal)
   │                                    │                │
   │── subscribe "users-by-role"       │                │
   │   params: { role: "admin" }  ────►│                │
   │◄── sub-1, data: []                │                │
   │                                    │                │
   │                                    │◄── subscribe "users-by-role"
   │                                    │    params: { role: "user" }  ──│
   │                                    │──► sub-2, data: [] ───────────►│
   │                                    │                │
   │              ┌─── insert { role: "user" } ───┐     │
   │              │                                │     │
   │   (no push)  │    Server re-evaluates:        │     │
   │              │    sub-1 result unchanged → skip│     │
   │              │    sub-2 result changed → push  │     │
   │              └────────────────────────────────┘     │
   │                                    │──► push sub-2 ►│
```

## Working Example

```typescript
// Insert initial data
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice', role: 'admin' },
});
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Bob', role: 'user' },
});

// Subscribe to admins
const adminSub = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'users-by-role',
  params: { role: 'admin' },
});
console.log(adminSub.data.data);
// [{ id: "a1", name: "Alice", role: "admin", _version: 1 }]

// Subscribe to pending orders for a specific user
const orderSub = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'orders-for-user',
  params: { userId: 'a1' },
});
console.log(orderSub.data.data); // []
```

## Exercise

Define and use a parameterized query:
1. Insert three users: Alice (admin), Bob (user), Charlie (admin)
2. Subscribe to `users-by-role` with `{ role: "admin" }`
3. Verify initial data contains Alice and Charlie
4. Insert a new admin "Dave" and verify you receive a push with all three admins
5. Insert a regular user "Eve" and verify no push is received

<details>
<summary>Solution</summary>

```jsonc
// 1. Insert users
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "role": "admin" } }
← { "id": 1, "type": "result", "data": { "id": "a1", ... } }

→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob", "role": "user" } }
← { "id": 2, "type": "result", "data": { "id": "b1", ... } }

→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Charlie", "role": "admin" } }
← { "id": 3, "type": "result", "data": { "id": "c1", ... } }

// 2. Subscribe to admins
→ { "id": 4, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "admin" } }
← { "id": 4, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": [
        { "id": "a1", "name": "Alice", "role": "admin", "_version": 1 },
        { "id": "c1", "name": "Charlie", "role": "admin", "_version": 1 }
      ]
    }
  }

// 4. Insert admin Dave → push with 3 admins
→ { "id": 5, "type": "store.insert", "bucket": "users",
    "data": { "name": "Dave", "role": "admin" } }
← { "id": 5, "type": "result", "data": { "id": "d1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice", "role": "admin", "_version": 1 },
      { "id": "c1", "name": "Charlie", "role": "admin", "_version": 1 },
      { "id": "d1", "name": "Dave", "role": "admin", "_version": 1 }
    ]
  }

// 5. Insert regular user Eve → no push on sub-1 (admin list unchanged)
→ { "id": 6, "type": "store.insert", "bucket": "users",
    "data": { "name": "Eve", "role": "user" } }
← { "id": 6, "type": "result", "data": { "id": "e1", ... } }
// (no push for sub-1)
```

</details>

## Summary

- Define parameterized queries with `async (ctx, params) => { ... }` on the server
- Subscribe with `"params": { ... }` in the subscribe message
- Each `(query, params)` combination is an independent subscription
- Pushes are targeted — only sent when the parameterized result changes
- Different clients can subscribe to the same query with different parameters

---

Next: [Managing Subscriptions](./04-managing-subscriptions.md)
