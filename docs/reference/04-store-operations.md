# Store Operations

CRUD operations, queries, aggregations, and admin operations on the store, exposed over the WebSocket protocol. Each operation is a `ClientRequest` with a `type` starting with `store.`.

---

## CRUD

### store.insert

Inserts a new record into a bucket. Returns the inserted record with generated fields (`id`, `_version`, `_createdAt`, `_updatedAt`).

**Request:**

```json
{
  "id": 1,
  "type": "store.insert",
  "bucket": "users",
  "data": { "name": "Alice", "email": "alice@example.com" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Target bucket name. |
| data | `object` | yes | Record data. Must satisfy the bucket schema. |

**Response:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "id": "a1b2c3d4",
    "name": "Alice",
    "email": "alice@example.com",
    "role": "user",
    "_version": 1,
    "_createdAt": 1700000000000,
    "_updatedAt": 1700000000000
  }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket`, `data`, or schema validation failure (e.g., missing required field). |
| `BUCKET_NOT_DEFINED` | Bucket does not exist in the store configuration. |
| `ALREADY_EXISTS` | Unique constraint violation. |

---

### store.get

Retrieves a single record by key. Returns `null` if the key does not exist.

**Request:**

```json
{
  "id": 2,
  "type": "store.get",
  "bucket": "users",
  "key": "a1b2c3d4"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| key | `unknown` | yes | Record key (typically a string). Must not be `null` or `undefined`. |

**Response (found):**

```json
{
  "id": 2,
  "type": "result",
  "data": { "id": "a1b2c3d4", "name": "Alice", "_version": 1 }
}
```

**Response (not found):**

```json
{
  "id": 2,
  "type": "result",
  "data": null
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket` or `key`. |
| `BUCKET_NOT_DEFINED` | Bucket does not exist. |

---

### store.update

Updates an existing record by key. Returns the updated record with incremented `_version`.

**Request:**

```json
{
  "id": 3,
  "type": "store.update",
  "bucket": "users",
  "key": "a1b2c3d4",
  "data": { "name": "Alice Updated", "role": "admin" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| key | `unknown` | yes | Record key. Must not be `null` or `undefined`. |
| data | `object` | yes | Fields to update. Merged with the existing record. |

**Response:**

```json
{
  "id": 3,
  "type": "result",
  "data": {
    "id": "a1b2c3d4",
    "name": "Alice Updated",
    "role": "admin",
    "_version": 2,
    "_updatedAt": 1700000001000
  }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket`, `key`, or `data`, or schema validation failure. |
| `BUCKET_NOT_DEFINED` | Bucket does not exist. |

---

### store.delete

Deletes a record by key. Returns `{ deleted: true }` regardless of whether the record existed.

**Request:**

```json
{
  "id": 4,
  "type": "store.delete",
  "bucket": "users",
  "key": "a1b2c3d4"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| key | `unknown` | yes | Record key. Must not be `null` or `undefined`. |

**Response:**

```json
{
  "id": 4,
  "type": "result",
  "data": { "deleted": true }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket` or `key`. |
| `BUCKET_NOT_DEFINED` | Bucket does not exist. |

---

## Queries

### store.all

Returns all records in a bucket as an array.

**Request:**

```json
{
  "id": 5,
  "type": "store.all",
  "bucket": "users"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |

**Response:**

```json
{
  "id": 5,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" }
  ]
}
```

Returns an empty array `[]` if the bucket is empty.

---

### store.where

Filters records by matching field values.

**Request:**

```json
{
  "id": 6,
  "type": "store.where",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| filter | `object` | yes | Key-value pairs to match against record fields. |

**Response:**

```json
{
  "id": 6,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice", "role": "admin" }
  ]
}
```

Returns an empty array `[]` when no records match.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket` or `filter`. |

---

### store.findOne

Returns the first record matching the filter, or `null` if none match.

**Request:**

```json
{
  "id": 7,
  "type": "store.findOne",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| filter | `object` | yes | Key-value pairs to match. |

**Response (found):**

```json
{
  "id": 7,
  "type": "result",
  "data": { "id": "a1", "name": "Alice", "role": "admin" }
}
```

**Response (not found):**

```json
{
  "id": 7,
  "type": "result",
  "data": null
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket` or `filter`. |

---

### store.count

Returns the number of records, optionally filtered.

**Request (all):**

```json
{
  "id": 8,
  "type": "store.count",
  "bucket": "users"
}
```

**Request (filtered):**

```json
{
  "id": 9,
  "type": "store.count",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| filter | `object` | no | Optional filter to count only matching records. |

**Response:**

```json
{
  "id": 8,
  "type": "result",
  "data": 3
}
```

Returns `0` for an empty bucket or when no records match the filter.

---

### store.first

Returns the first N records (by insertion order).

**Request:**

```json
{
  "id": 10,
  "type": "store.first",
  "bucket": "users",
  "n": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| n | `number` | yes | Number of records. Must be a positive integer. |

**Response:**

```json
{
  "id": 10,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" }
  ]
}
```

If `n` exceeds the total count, all records are returned.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket`, missing `n`, or `n` is not a positive integer. |

---

### store.last

Returns the last N records (by insertion order).

**Request:**

```json
{
  "id": 11,
  "type": "store.last",
  "bucket": "users",
  "n": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| n | `number` | yes | Number of records. Must be a positive integer. |

**Response:**

```json
{
  "id": 11,
  "type": "result",
  "data": [
    { "id": "b2", "name": "Bob" },
    { "id": "c3", "name": "Carol" }
  ]
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket`, missing `n`, or `n` is not a positive integer. |

---

### store.paginate

Cursor-based pagination. Returns a page of records, a `hasMore` flag, and an optional `nextCursor` for fetching the next page.

**Request (first page):**

```json
{
  "id": 12,
  "type": "store.paginate",
  "bucket": "users",
  "limit": 2
}
```

**Request (next page):**

```json
{
  "id": 13,
  "type": "store.paginate",
  "bucket": "users",
  "limit": 2,
  "after": "cursor-from-previous-page"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| limit | `number` | yes | Maximum records per page. Must be a positive integer. |
| after | `unknown` | no | Cursor from a previous response's `nextCursor`. Omit for the first page. |

**Response:**

```json
{
  "id": 12,
  "type": "result",
  "data": {
    "records": [
      { "id": "a1", "name": "Alice" },
      { "id": "b2", "name": "Bob" }
    ],
    "hasMore": true,
    "nextCursor": "b2"
  }
}
```

When `hasMore` is `false`, `nextCursor` is not present (or `undefined`).

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `bucket` or `limit`, or `limit` is not a positive integer. |

---

## Aggregations

All aggregation operations accept an optional `filter` to narrow the set of records.

### store.sum

Returns the sum of a numeric field.

**Request:**

```json
{
  "id": 14,
  "type": "store.sum",
  "bucket": "products",
  "field": "price"
}
```

**Request (with filter):**

```json
{
  "id": 15,
  "type": "store.sum",
  "bucket": "products",
  "field": "price",
  "filter": { "stock": 100 }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| field | `string` | yes | Name of the numeric field to sum. |
| filter | `object` | no | Optional filter to include only matching records. |

**Response:**

```json
{
  "id": 14,
  "type": "result",
  "data": 60
}
```

---

### store.avg

Returns the average of a numeric field.

**Request:**

```json
{
  "id": 16,
  "type": "store.avg",
  "bucket": "products",
  "field": "price"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| field | `string` | yes | Name of the numeric field. |
| filter | `object` | no | Optional filter. |

**Response:**

```json
{
  "id": 16,
  "type": "result",
  "data": 20
}
```

---

### store.min

Returns the minimum value of a numeric field. Returns `null` if the bucket is empty (or no records match the filter).

**Request:**

```json
{
  "id": 17,
  "type": "store.min",
  "bucket": "products",
  "field": "price"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| field | `string` | yes | Name of the numeric field. |
| filter | `object` | no | Optional filter. |

**Response:**

```json
{
  "id": 17,
  "type": "result",
  "data": 5
}
```

**Response (empty):**

```json
{
  "id": 17,
  "type": "result",
  "data": null
}
```

---

### store.max

Returns the maximum value of a numeric field. Returns `null` if the bucket is empty (or no records match the filter).

**Request:**

```json
{
  "id": 18,
  "type": "store.max",
  "bucket": "products",
  "field": "price"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |
| field | `string` | yes | Name of the numeric field. |
| filter | `object` | no | Optional filter. |

**Response:**

```json
{
  "id": 18,
  "type": "result",
  "data": 99
}
```

---

## Admin

### store.clear

Removes all records from a bucket. Does not delete the bucket itself.

**Request:**

```json
{
  "id": 19,
  "type": "store.clear",
  "bucket": "users"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| bucket | `string` | yes | Bucket name. |

**Response:**

```json
{
  "id": 19,
  "type": "result",
  "data": { "cleared": true }
}
```

---

### store.buckets

Lists all defined buckets and their count.

**Request:**

```json
{
  "id": 20,
  "type": "store.buckets"
}
```

No additional fields required.

**Response:**

```json
{
  "id": 20,
  "type": "result",
  "data": {
    "count": 2,
    "names": ["users", "products"]
  }
}
```

---

### store.stats

Returns store statistics.

**Request:**

```json
{
  "id": 21,
  "type": "store.stats"
}
```

No additional fields required.

**Response:**

```json
{
  "id": 21,
  "type": "result",
  "data": {
    "buckets": { "count": 2, "names": ["users", "products"] },
    "records": { "users": 10, "products": 5 }
  }
}
```

---

## Common Errors

All store operations share these common error scenarios:

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing or invalid required field (`bucket`, `key`, `data`, `field`, etc.). |
| `BUCKET_NOT_DEFINED` | The requested bucket is not defined in the store configuration. |
| `UNKNOWN_OPERATION` | The `type` does not match any known `store.*` operation. |

---

## See Also

- [Store Subscriptions](./05-store-subscriptions.md) — Reactive subscriptions and transactions
- [Protocol](./03-protocol.md) — Full protocol specification
- [Errors](./10-errors.md) — Error codes and error class
- [Configuration](./02-configuration.md) — Server configuration
