# Store Subscriptions

Reactive subscriptions to named queries, subscription lifecycle, push notifications, and atomic transactions.

---

## store.subscribe

Subscribes to a named query defined on the store. Returns a `subscriptionId` and the initial query result. Subsequent changes that affect the query result trigger `PushMessage` frames on channel `"subscription"`.

**Request:**

```json
{
  "id": 1,
  "type": "store.subscribe",
  "query": "all-users"
}
```

**Request (with params):**

```json
{
  "id": 2,
  "type": "store.subscribe",
  "query": "users-by-role",
  "params": { "role": "admin" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| query | `string` | yes | Name of a query defined via `store.defineQuery()`. |
| params | `unknown` | no | Parameters passed to the query function. |

**Response:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice" },
      { "id": "b2", "name": "Bob" }
    ]
  }
}
```

The `data` field contains the initial query result. Its shape depends on the query definition — it can be an array, a number, an object, or any other value.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `query` field. |
| `QUERY_NOT_DEFINED` | The named query does not exist. |
| `RATE_LIMITED` | Per-connection subscription limit reached (default: 100). |

---

## Push Mechanism

When the underlying data changes and the subscribed query produces a new result, the server sends a `PushMessage`:

```json
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" },
    { "id": "c3", "name": "Carol" }
  ]
}
```

Push messages are only sent when the query result actually changes. If a mutation does not affect the subscribed query's result, no push is sent.

Push messages are not correlated with any request — they have no `id` field. The `subscriptionId` and `channel` fields identify which subscription produced the notification.

Multiple subscriptions can be active on the same connection. Each receives its own push messages independently.

---

## store.unsubscribe

Cancels an active subscription. After unsubscribing, no further push messages are sent for that subscription.

**Request:**

```json
{
  "id": 3,
  "type": "store.unsubscribe",
  "subscriptionId": "sub-1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| subscriptionId | `string` | yes | The subscription ID returned by `store.subscribe`. |

**Response:**

```json
{
  "id": 3,
  "type": "result",
  "data": { "unsubscribed": true }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `subscriptionId`. |
| `NOT_FOUND` | Subscription does not exist (already unsubscribed or invalid ID). |

---

## Subscription Cleanup

When a client disconnects, all its subscriptions are automatically cleaned up. There is no need to explicitly unsubscribe before closing the connection.

---

## store.transaction

Executes multiple operations atomically within a single transaction. Either all operations succeed and are committed, or the entire transaction is rolled back on failure.

**Request:**

```json
{
  "id": 4,
  "type": "store.transaction",
  "operations": [
    { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
    { "op": "insert", "bucket": "logs", "data": { "action": "user_created" } }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| operations | `array` | yes | Array of operation objects. Must contain at least one operation. |

### Transaction Operations

Each operation in the `operations` array must have an `op` field and a `bucket` field. Additional fields depend on the operation type.

| op | Required Fields | Description |
|----|-----------------|-------------|
| `get` | `bucket`, `key` | Read a record by key. Returns `null` if not found. |
| `insert` | `bucket`, `data` | Insert a new record. |
| `update` | `bucket`, `key`, `data` | Update an existing record by key. |
| `delete` | `bucket`, `key` | Delete a record by key. Returns `{ deleted: true }`. |
| `where` | `bucket`, `filter` | Filter records by field values. |
| `findOne` | `bucket`, `filter` | Return first matching record or `null`. |
| `count` | `bucket` | Count records. Optional `filter` field. |

**Response:**

```json
{
  "id": 4,
  "type": "result",
  "data": {
    "results": [
      { "index": 0, "data": { "id": "a1", "name": "Alice", "_version": 1 } },
      { "index": 1, "data": { "id": "x1", "action": "user_created", "_version": 1 } }
    ]
  }
}
```

The `results` array contains one entry per operation, in the same order as the input. Each entry has an `index` (0-based) and `data` (the operation result).

### Read-Your-Own-Writes

Operations within a transaction can read the results of preceding operations. For example, an `update` followed by a `get` for the same key returns the updated record:

```json
{
  "id": 5,
  "type": "store.transaction",
  "operations": [
    { "op": "update", "bucket": "users", "key": "u1", "data": { "credits": 200 } },
    { "op": "get", "bucket": "users", "key": "u1" }
  ]
}
```

### Rollback

If any operation within the transaction fails (e.g., schema validation error), the entire transaction is rolled back — no changes are persisted.

### Subscription Push

Committed transactions trigger subscription pushes just like individual mutations. If a transaction inserts two records into a subscribed bucket, subscribers receive a single push with the updated query result.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `operations`, empty array, invalid operation format, missing required fields within operations. |
| `CONFLICT` | Transaction conflict (concurrent modification of the same record). |
| `INTERNAL_ERROR` | Unknown bucket within the transaction context. |

---

## See Also

- [Store Operations](./04-store-operations.md) — CRUD, queries, and aggregations
- [Protocol](./03-protocol.md) — PushMessage format and connection lifecycle
- [Errors](./10-errors.md) — Error codes
- [Configuration](./02-configuration.md) — `connectionLimits.maxSubscriptionsPerConnection`
