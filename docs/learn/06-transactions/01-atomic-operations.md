# Atomic Operations

Execute multiple store operations in a single atomic transaction — all succeed or all fail. No partial writes, no inconsistent state.

## What You'll Learn

- The `store.transaction` message format
- Supported operations: get, insert, update, delete, where, findOne, count
- The response structure with indexed results
- Read-your-own-writes within a transaction
- Validation rules and error handling

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'transactions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    name:    { type: 'string', required: true },
    role:    { type: 'string', default: 'user' },
    credits: { type: 'number', default: 0 },
  },
});

store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    action: { type: 'string', required: true },
    userId: { type: 'string' },
  },
});

store.defineBucket('products', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
    price: { type: 'number', default: 0 },
    stock: { type: 'number', default: 0 },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## store.transaction

Sends a batch of operations to execute atomically. Each operation specifies an `op` type, a `bucket`, and operation-specific fields.

```jsonc
// Request
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } }
    ]
  }

// Response
← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "role": "user", "credits": 0, "_version": 1 } },
        { "index": 1, "data": { "id": "b1", "name": "Bob", "role": "user", "credits": 0, "_version": 1 } }
      ]
    }
  }
```

**Required fields:** `operations` (non-empty array)

## Supported Operations

| op | Required Fields | Optional | Returns |
|----|----------------|----------|---------|
| `get` | `bucket`, `key` | — | Record or `null` |
| `insert` | `bucket`, `data` | — | Inserted record |
| `update` | `bucket`, `key`, `data` | — | Updated record |
| `delete` | `bucket`, `key` | — | `{ deleted: true }` |
| `where` | `bucket`, `filter` | — | Array of matching records |
| `findOne` | `bucket`, `filter` | — | First match or `null` |
| `count` | `bucket` | `filter` | Number |

Each operation behaves identically to its standalone `store.*` counterpart, but within the transaction boundary.

## Response Structure

The response `data.results` is an array of objects, each with:
- **`index`** — the position of the operation in the original `operations` array (0-based)
- **`data`** — the result of that operation

```jsonc
← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { ... } },  // result of operations[0]
        { "index": 1, "data": { ... } },  // result of operations[1]
        { "index": 2, "data": 3 }          // result of operations[2] (e.g. count)
      ]
    }
  }
```

## Read-Your-Own-Writes

Operations within a transaction see the results of earlier operations in the same transaction. This enables read-modify-write patterns:

```jsonc
// Update a user's credits, then read the updated value
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "a1",
        "data": { "credits": 200 } },
      { "op": "get", "bucket": "users", "key": "a1" }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } }
      ]
    }
  }
```

Reads also see inserts from the same transaction:

```jsonc
// Insert two users, then count — sees both
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } },
      { "op": "count", "bucket": "users" }
    ]
  }

← { "id": 2, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", ... } },
        { "index": 1, "data": { "id": "b1", "name": "Bob", ... } },
        { "index": 2, "data": 2 }
      ]
    }
  }
```

## All-or-Nothing

If any operation fails, the entire transaction is rolled back. No partial writes are persisted:

```jsonc
// Transaction: update product stock + insert user without required 'name'
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "products", "key": "p1",
        "data": { "stock": 4 } },
      { "op": "insert", "bucket": "users",
        "data": { "credits": 100 } }
    ]
  }

// Second operation fails (missing required 'name') → entire transaction rolls back
← { "id": 3, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "..." }

// Product stock is unchanged — the update was rolled back
→ { "id": 4, "type": "store.get", "bucket": "products", "key": "p1" }
← { "id": 4, "type": "result",
    "data": { "id": "p1", "title": "Widget", "stock": 5, ... } }
```

## Validation

The server validates the `operations` array before execution:

| Validation | Error Code |
|-----------|-----------|
| `operations` is missing or not an array | `VALIDATION_ERROR` |
| `operations` is empty | `VALIDATION_ERROR` |
| An element is not an object | `VALIDATION_ERROR` |
| `op` is missing or not one of the valid types | `VALIDATION_ERROR` |
| `bucket` is missing or empty | `VALIDATION_ERROR` |
| `key` missing for get/update/delete | `VALIDATION_ERROR` |
| `data` missing for insert/update | `VALIDATION_ERROR` |
| `filter` missing for where/findOne | `VALIDATION_ERROR` |

Error messages include the operation index for easy debugging:

```jsonc
→ { "id": 5, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "get", "bucket": "users" }
    ]
  }
← { "id": 5, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "operations[1]: \"get\" requires \"key\"" }
```

## Working Example

```typescript
// Pre-insert a user
const insertResp = await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice', credits: 100 },
});
const userId = insertResp.data.id;

// Atomic: update credits + log the action
const txResp = await sendRequest(ws, {
  type: 'store.transaction',
  operations: [
    { op: 'update', bucket: 'users', key: userId, data: { credits: 200 } },
    { op: 'insert', bucket: 'logs', data: { action: 'credit_update', userId } },
  ],
});

console.log(txResp.data.results[0].data.credits); // 200
console.log(txResp.data.results[1].data.action);  // "credit_update"
```

## Exercise

Write a transaction that:
1. Inserts a user "Alice" with role "admin"
2. Inserts a log entry with action "user_created"
3. Queries all admin users with `where` to verify Alice is included
4. Counts the total users

<details>
<summary>Solution</summary>

```jsonc
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users",
        "data": { "name": "Alice", "role": "admin" } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "user_created" } },
      { "op": "where", "bucket": "users",
        "filter": { "role": "admin" } },
      { "op": "count", "bucket": "users" }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "role": "admin", "credits": 0, "_version": 1 } },
        { "index": 1, "data": { "id": "l1", "action": "user_created", "_version": 1 } },
        { "index": 2, "data": [{ "id": "a1", "name": "Alice", "role": "admin", "credits": 0, "_version": 1 }] },
        { "index": 3, "data": 1 }
      ]
    }
  }
```

Notice:
- `where` (index 2) sees Alice from the insert at index 0 (read-your-own-writes)
- `count` (index 3) returns 1, reflecting the insert within the transaction

</details>

## Summary

- `store.transaction` executes multiple operations atomically — all or nothing
- Supported ops: `get`, `insert`, `update`, `delete`, `where`, `findOne`, `count`
- Response `results` array mirrors the `operations` order with `index` and `data`
- Read-your-own-writes: later operations see earlier writes within the same transaction
- On failure, all changes are rolled back — no partial writes
- Validation errors include the operation index (e.g. `operations[1]: ...`)

---

Next: [Transaction Patterns](./02-transaction-patterns.md)
