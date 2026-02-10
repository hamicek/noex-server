# Subscribing to Queries

Subscribe to a named query and receive its current result immediately — then get automatic push updates whenever that result changes.

## What You'll Learn

- How to define reactive queries on the server with `store.defineQuery()`
- How to subscribe via the `store.subscribe` message
- The response structure: `subscriptionId` + initial `data`
- Scalar vs array initial results
- Error handling for undefined queries

## Server Setup

All examples in this chapter assume this server setup:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'subscriptions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

// Define reactive queries BEFORE starting the server
store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Defining Queries

Reactive queries are named, read-only async functions registered on the store. They describe *what data* the client will receive. The store automatically tracks which buckets and records each query depends on, so it knows when to re-evaluate.

```typescript
// Array query — returns all records
store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

// Scalar query — returns a single number
store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});
```

Inside a query function, `ctx.bucket(name)` provides read-only access to bucket data. Any read method available on a bucket (`all`, `where`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max`, `get`) can be used in a query.

**Important:** Queries must be defined *before* clients subscribe. You cannot define queries dynamically at runtime — they are part of the server's configuration.

## store.subscribe

Sends a subscription request for a named query. The server responds with a unique `subscriptionId` and the current query result as initial data.

```jsonc
// Request
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }

// Response
← { "id": 1, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": []
    }
  }
```

**Required fields:** `query`

The response `data` contains two fields:
- **`subscriptionId`** — a unique string (e.g. `"sub-1"`, `"sub-2"`) identifying this subscription. Use it to match incoming push messages and to unsubscribe later.
- **`data`** — the current query result at the time of subscription. This is the same result you would get from executing the query directly.

## Initial Data

The initial `data` reflects the current state of the store at subscription time:

```jsonc
// Empty bucket → empty array
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// After inserting a user → array with one record
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result",
    "data": { "id": "a1b2", "name": "Alice", "role": "user", "_version": 1 } }

→ { "id": 3, "type": "store.subscribe", "query": "all-users" }
← { "id": 3, "type": "result",
    "data": {
      "subscriptionId": "sub-2",
      "data": [{ "id": "a1b2", "name": "Alice", "role": "user", "_version": 1 }]
    }
  }
```

## Scalar Queries

Queries that return a single value (like `count()`) return that value directly, not wrapped in an array:

```jsonc
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }
```

After inserting two users and subscribing again:

```jsonc
→ { "id": 4, "type": "store.subscribe", "query": "user-count" }
← { "id": 4, "type": "result",
    "data": { "subscriptionId": "sub-3", "data": 2 } }
```

## Error Handling

| Error Code | Cause |
|-----------|-------|
| `QUERY_NOT_DEFINED` | The query name doesn't match any defined query |
| `VALIDATION_ERROR` | The `query` field is missing or empty |

```jsonc
// Unknown query
→ { "id": 5, "type": "store.subscribe", "query": "nonexistent" }
← { "id": 5, "type": "error",
    "code": "QUERY_NOT_DEFINED",
    "message": "Query \"nonexistent\" is not defined" }

// Missing query field
→ { "id": 6, "type": "store.subscribe" }
← { "id": 6, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"query\": expected non-empty string" }
```

## Working Example

```typescript
// Subscribe to all users
const subResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});

const { subscriptionId, data: initialUsers } = subResp.data;
console.log('Subscription ID:', subscriptionId); // "sub-1"
console.log('Initial users:', initialUsers);      // []

// Subscribe to user count
const countResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'user-count',
});

console.log('Initial count:', countResp.data.data); // 0
```

## Exercise

Write a sequence of WebSocket messages that:
1. Inserts two users ("Alice" and "Bob")
2. Subscribes to `all-users` and verifies the initial data contains both users
3. Subscribes to `user-count` and verifies the initial count is 2

<details>
<summary>Solution</summary>

```jsonc
// 1. Insert users
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 1, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "id": 2, "type": "result",
    "data": { "id": "b1", "name": "Bob", "role": "user", "_version": 1 } }

// 2. Subscribe to all-users — initial data has both
→ { "id": 3, "type": "store.subscribe", "query": "all-users" }
← { "id": 3, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": [
        { "id": "a1", "name": "Alice", "role": "user", "_version": 1 },
        { "id": "b1", "name": "Bob", "role": "user", "_version": 1 }
      ]
    }
  }

// 3. Subscribe to user-count — initial count is 2
→ { "id": 4, "type": "store.subscribe", "query": "user-count" }
← { "id": 4, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 2 } }
```

</details>

## Summary

- Define reactive queries on the server with `store.defineQuery()` before clients connect
- Subscribe via `store.subscribe` with the `query` field
- Response contains `subscriptionId` (for matching pushes and unsubscribing) and `data` (current result)
- Array queries return arrays, scalar queries return numbers/values directly
- `QUERY_NOT_DEFINED` if the query doesn't exist, `VALIDATION_ERROR` if the `query` field is missing

---

Next: [Push Updates](./02-push-updates.md)
