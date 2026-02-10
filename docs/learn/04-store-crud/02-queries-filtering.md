# Queries and Filtering

Beyond single-record CRUD, noex-server provides operations for listing, filtering, finding, and counting records.

## What You'll Learn

- How to list all records with `store.all`
- How to filter records with `store.where`
- How to find a single match with `store.findOne`
- How to count records with `store.count`

## store.all

Returns all records in a bucket as an array.

```jsonc
→ { "id": 1, "type": "store.all", "bucket": "users" }
← { "id": 1, "type": "result", "data": [
    { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 },
    { "id": "u2", "name": "Bob", "role": "user", "_version": 1 },
    { "id": "u3", "name": "Carol", "role": "user", "_version": 2 }
  ] }
```

Returns an empty array `[]` when the bucket has no records — not an error.

**Required fields:** `bucket`

## store.where

Filters records by field values. Returns all matching records as an array.

```jsonc
→ { "id": 2, "type": "store.where", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 2, "type": "result", "data": [
    { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 }
  ] }
```

The `filter` object matches records where all specified fields equal the given values (logical AND).

```jsonc
// Multiple filter fields (AND)
→ { "id": 3, "type": "store.where", "bucket": "users",
    "filter": { "role": "user", "age": 30 } }
← { "id": 3, "type": "result", "data": [
    { "id": "u2", "name": "Bob", "role": "user", "age": 30, "_version": 1 }
  ] }
```

Returns `[]` when no records match.

**Required fields:** `bucket`, `filter`

## store.findOne

Returns the first record matching the filter, or `null` if none match.

```jsonc
// Found
→ { "id": 4, "type": "store.findOne", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 4, "type": "result",
    "data": { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 } }

// Not found
→ { "id": 5, "type": "store.findOne", "bucket": "users",
    "filter": { "role": "superadmin" } }
← { "id": 5, "type": "result", "data": null }
```

**Required fields:** `bucket`, `filter`

Use `findOne` when you expect at most one result, or only care about the first match.

## store.count

Counts records. Without a filter, counts all records in the bucket. With a filter, counts matching records.

```jsonc
// Count all
→ { "id": 6, "type": "store.count", "bucket": "users" }
← { "id": 6, "type": "result", "data": 3 }

// Count with filter
→ { "id": 7, "type": "store.count", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 7, "type": "result", "data": 1 }

// Empty bucket
→ { "id": 8, "type": "store.count", "bucket": "products" }
← { "id": 8, "type": "result", "data": 0 }
```

**Required fields:** `bucket`
**Optional fields:** `filter`

The result is a number, not an object or array.

## Comparison

| Operation | Returns | Null/empty case | Filter required |
|-----------|---------|-----------------|-----------------|
| `store.all` | Array of records | `[]` | No |
| `store.where` | Array of matching records | `[]` | Yes |
| `store.findOne` | Single record or null | `null` | Yes |
| `store.count` | Number | `0` | Optional |

## Working Example

```typescript
// Seed data
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Alice', role: 'admin', age: 35 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Bob', role: 'user', age: 30 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Carol', role: 'user', age: 25 } });

// List all
const all = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
console.log(all.data.length); // 3

// Find admins
const admins = await sendRequest(ws, { type: 'store.where', bucket: 'users', filter: { role: 'admin' } });
console.log(admins.data.length); // 1

// Find one admin
const admin = await sendRequest(ws, { type: 'store.findOne', bucket: 'users', filter: { role: 'admin' } });
console.log(admin.data.name); // "Alice"

// Count users with role "user"
const count = await sendRequest(ws, { type: 'store.count', bucket: 'users', filter: { role: 'user' } });
console.log(count.data); // 2
```

## Exercise

Given a `products` bucket with fields `id`, `title`, `price`, `category`, write WebSocket messages to:
1. List all products
2. Find products in the "electronics" category
3. Find a single product in the "books" category
4. Count all products with price 0

<details>
<summary>Solution</summary>

```jsonc
// 1. All products
→ { "id": 1, "type": "store.all", "bucket": "products" }

// 2. Electronics
→ { "id": 2, "type": "store.where", "bucket": "products", "filter": { "category": "electronics" } }

// 3. First book
→ { "id": 3, "type": "store.findOne", "bucket": "products", "filter": { "category": "books" } }

// 4. Count free products
→ { "id": 4, "type": "store.count", "bucket": "products", "filter": { "price": 0 } }
```

</details>

## Summary

- `store.all` — all records in a bucket, returns `[]` if empty
- `store.where` — filter by field values (AND logic), returns `[]` if no match
- `store.findOne` — first match or `null`
- `store.count` — number of records, optionally filtered
- All return data directly (no error for empty results)

---

Next: [Pagination and Aggregations](./03-pagination-aggregations.md)
