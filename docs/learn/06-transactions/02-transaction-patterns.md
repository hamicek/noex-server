# Transaction Patterns

Common real-world patterns using atomic transactions: cross-bucket operations, purchase workflows, and handling errors gracefully.

## What You'll Learn

- Cross-bucket transactions (e.g. transfer between accounts)
- Purchase pattern: deduct credits, reduce stock, log the action
- Version tracking and optimistic concurrency
- Rollback behavior and how to recover from errors
- Transactions + subscriptions: push after commit

## Server Setup

Same as the [previous chapter](./01-atomic-operations.md), with three buckets: `users`, `products`, and `logs`.

## Cross-Bucket Operations

A single transaction can atomically modify records across multiple buckets. This is essential for operations that must be consistent — like transferring credits between users:

```jsonc
// Transfer 50 credits from Alice to Bob
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 450 } },
      { "op": "update", "bucket": "users", "key": "bob-id",
        "data": { "credits": 150 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "transfer", "userId": "alice-id" } }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "name": "Alice", "credits": 450, "_version": 2 } },
        { "index": 1, "data": { "id": "bob-id", "name": "Bob", "credits": 150, "_version": 2 } },
        { "index": 2, "data": { "id": "l1", "action": "transfer", "userId": "alice-id", "_version": 1 } }
      ]
    }
  }
```

If the log insert fails, neither credit update is persisted.

## Purchase Pattern

A common e-commerce pattern: deduct user credits, reduce product stock, and log the purchase — all atomically:

```jsonc
// Alice buys a Widget (price: 100, current stock: 10)
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 400 } },
      { "op": "update", "bucket": "products", "key": "widget-id",
        "data": { "stock": 9 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "purchase", "userId": "alice-id" } }
    ]
  }

← { "id": 2, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "credits": 400, "_version": 3 } },
        { "index": 1, "data": { "id": "widget-id", "title": "Widget", "stock": 9, "_version": 2 } },
        { "index": 2, "data": { "id": "l2", "action": "purchase", "_version": 1 } }
      ]
    }
  }
```

Three buckets, one atomic operation. If any step fails, the user's credits aren't deducted and the stock isn't reduced.

## Read-Modify-Write

When you need to read a value before modifying it, do it within the transaction to ensure consistency:

```jsonc
// Read current credits, then update based on the value
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "alice-id" },
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 300 } }
    ]
  }

← { "id": 3, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "credits": 400, "_version": 3 } },
        { "index": 1, "data": { "id": "alice-id", "credits": 300, "_version": 4 } }
      ]
    }
  }
```

In practice, the client reads the current value (index 0), computes the new value, and sends the update (index 1). Since both happen atomically, no other client can modify the value in between.

## Version Tracking

Every record has a `_version` field that increments on each update:

```text
insert → _version: 1
update → _version: 2
update → _version: 3
...
```

Within a transaction, the store tracks which version was first read and uses it during commit. If another client modified the same record between the read and the commit, a `CONFLICT` error is returned and the entire transaction is rolled back.

```text
Client A                    Store                    Client B
   │                          │                          │
   │── tx: get user ────────►│   (_version: 2)          │
   │                          │                          │
   │                          │◄── update user ──────────│
   │                          │    (_version: 2 → 3)     │
   │                          │                          │
   │── tx: update user ─────►│   (expects v2, actual v3) │
   │◄── CONFLICT ─────────────│                          │
```

This is optimistic concurrency: the transaction doesn't hold locks, but detects conflicts at commit time.

## Error Recovery

When a transaction fails, the standard recovery pattern is:

1. **Re-read** the current state
2. **Recompute** the new values based on fresh data
3. **Retry** the transaction

```typescript
async function purchaseWithRetry(ws, userId, productId, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. Read current state
    const readResp = await sendRequest(ws, {
      type: 'store.transaction',
      operations: [
        { op: 'get', bucket: 'users', key: userId },
        { op: 'get', bucket: 'products', key: productId },
      ],
    });

    const user = readResp.data.results[0].data;
    const product = readResp.data.results[1].data;

    if (user.credits < product.price) {
      throw new Error('Insufficient credits');
    }
    if (product.stock < 1) {
      throw new Error('Out of stock');
    }

    // 2. Attempt purchase
    const txResp = await sendRequest(ws, {
      type: 'store.transaction',
      operations: [
        { op: 'update', bucket: 'users', key: userId,
          data: { credits: user.credits - product.price } },
        { op: 'update', bucket: 'products', key: productId,
          data: { stock: product.stock - 1 } },
        { op: 'insert', bucket: 'logs',
          data: { action: 'purchase', userId } },
      ],
    });

    if (txResp.type === 'result') {
      return txResp.data; // success
    }

    if (txResp.code === 'CONFLICT') {
      continue; // retry with fresh data
    }

    throw new Error(txResp.message); // non-retriable error
  }

  throw new Error('Max retries exceeded');
}
```

## Transactions + Subscriptions

Transactions trigger subscription pushes the same way individual mutations do. After a transaction commits, all affected subscriptions receive push messages:

```jsonc
// Subscribe to all-users
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Insert two users via transaction
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } }
    ]
  }
← { "id": 2, "type": "result",
    "data": { "results": [ ... ] } }

// One push with both users (full result, not per-operation)
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice", "role": "user", ... },
      { "id": "b1", "name": "Bob", "role": "user", ... }
    ]
  }
```

The push contains the final result after the entire transaction — not intermediate states.

## Delete + Insert Pattern

Sometimes you need to replace a record atomically — delete the old one and insert a new one:

```jsonc
→ { "id": 4, "type": "store.transaction",
    "operations": [
      { "op": "delete", "bucket": "users", "key": "old-id" },
      { "op": "insert", "bucket": "users",
        "data": { "name": "New User", "role": "admin" } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "user_replaced" } }
    ]
  }
```

## Edge Cases

**Get returns `null` for non-existent keys:**
```jsonc
→ { "id": 5, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "non-existent" }
    ]
  }
← { "id": 5, "type": "result",
    "data": { "results": [{ "index": 0, "data": null }] } }
```

**Delete is idempotent:**
```jsonc
→ { "id": 6, "type": "store.transaction",
    "operations": [
      { "op": "delete", "bucket": "users", "key": "non-existent" }
    ]
  }
← { "id": 6, "type": "result",
    "data": { "results": [{ "index": 0, "data": { "deleted": true } }] } }
```

**Count with filter in a transaction:**
```jsonc
→ { "id": 7, "type": "store.transaction",
    "operations": [
      { "op": "count", "bucket": "users", "filter": { "role": "admin" } }
    ]
  }
← { "id": 7, "type": "result",
    "data": { "results": [{ "index": 0, "data": 2 }] } }
```

## Exercise

Write a purchase transaction workflow:
1. Insert user Alice with 500 credits
2. Insert product "Laptop" with price 300 and stock 5
3. Execute a transaction that: deducts credits, reduces stock, and logs the purchase
4. Verify Alice's remaining credits (200) and the product stock (4) by reading them in a second transaction

<details>
<summary>Solution</summary>

```jsonc
// 1. Insert Alice
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "credits": 500 } }
← { "id": 1, "type": "result",
    "data": { "id": "a1", "name": "Alice", "credits": 500, "_version": 1 } }

// 2. Insert Laptop
→ { "id": 2, "type": "store.insert", "bucket": "products",
    "data": { "title": "Laptop", "price": 300, "stock": 5 } }
← { "id": 2, "type": "result",
    "data": { "id": "p1", "title": "Laptop", "price": 300, "stock": 5, "_version": 1 } }

// 3. Purchase transaction
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "a1",
        "data": { "credits": 200 } },
      { "op": "update", "bucket": "products", "key": "p1",
        "data": { "stock": 4 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "purchase", "userId": "a1" } }
    ]
  }
← { "id": 3, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "p1", "title": "Laptop", "stock": 4, "_version": 2 } },
        { "index": 2, "data": { "id": "l1", "action": "purchase", "userId": "a1", "_version": 1 } }
      ]
    }
  }

// 4. Verify via transaction reads
→ { "id": 4, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "a1" },
      { "op": "get", "bucket": "products", "key": "p1" }
    ]
  }
← { "id": 4, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "p1", "title": "Laptop", "stock": 4, "_version": 2 } }
      ]
    }
  }
```

</details>

## Summary

- **Cross-bucket transactions** ensure consistency across multiple buckets in one atomic operation
- **Purchase pattern:** update user + update product + insert log — all or nothing
- **Read-modify-write:** read then update within the same transaction to prevent races
- **Version tracking** provides optimistic concurrency — `CONFLICT` on version mismatch
- **Error recovery:** re-read, recompute, retry on `CONFLICT`
- **Subscriptions** receive one push per transaction with the final result
- **Delete is idempotent**, **get returns `null`** for missing keys — even inside transactions

---

Next: [Rules Setup](../07-rules/01-setup.md)
