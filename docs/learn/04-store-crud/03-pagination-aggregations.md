# Pagination and Aggregations

For large datasets, you need pagination. For analytics, you need aggregations. This chapter covers both.

## What You'll Learn

- How to get first/last N records
- How cursor-based pagination works
- How to compute sum, avg, min, max over numeric fields

## store.first / store.last

Get the first or last N records from a bucket.

```jsonc
// First 2 records
→ { "id": 1, "type": "store.first", "bucket": "users", "n": 2 }
← { "id": 1, "type": "result", "data": [
    { "id": "u1", "name": "Alice", ... },
    { "id": "u2", "name": "Bob", ... }
  ] }

// Last 2 records
→ { "id": 2, "type": "store.last", "bucket": "users", "n": 2 }
← { "id": 2, "type": "result", "data": [
    { "id": "u4", "name": "Dave", ... },
    { "id": "u5", "name": "Eve", ... }
  ] }
```

**Required fields:** `bucket`, `n` (positive integer)

If `n` exceeds the total count, all records are returned. `n: 0` or negative values return `VALIDATION_ERROR`.

## store.paginate

Cursor-based pagination for iterating through records in pages.

**First page:**

```jsonc
→ { "id": 3, "type": "store.paginate", "bucket": "users", "limit": 2 }
← { "id": 3, "type": "result", "data": {
    "records": [
      { "id": "u1", "name": "Alice", ... },
      { "id": "u2", "name": "Bob", ... }
    ],
    "hasMore": true,
    "nextCursor": "eyJ..."
  } }
```

**Next page** (using `nextCursor` from the previous response):

```jsonc
→ { "id": 4, "type": "store.paginate", "bucket": "users", "limit": 2, "after": "eyJ..." }
← { "id": 4, "type": "result", "data": {
    "records": [
      { "id": "u3", "name": "Carol", ... },
      { "id": "u4", "name": "Dave", ... }
    ],
    "hasMore": true,
    "nextCursor": "eyK..."
  } }
```

**Last page:**

```jsonc
→ { "id": 5, "type": "store.paginate", "bucket": "users", "limit": 2, "after": "eyK..." }
← { "id": 5, "type": "result", "data": {
    "records": [
      { "id": "u5", "name": "Eve", ... }
    ],
    "hasMore": false
  } }
```

**Required fields:** `bucket`, `limit`
**Optional fields:** `after` (cursor from previous page)

When `hasMore` is `false`, there are no more pages. The `nextCursor` field is absent on the last page.

### Pagination Loop

```typescript
let cursor: string | undefined;
const allRecords = [];

do {
  const payload: Record<string, unknown> = {
    type: 'store.paginate',
    bucket: 'users',
    limit: 100,
  };
  if (cursor) payload.after = cursor;

  const resp = await sendRequest(ws, payload);
  allRecords.push(...resp.data.records);
  cursor = resp.data.hasMore ? resp.data.nextCursor : undefined;
} while (cursor);

console.log(`Fetched ${allRecords.length} records`);
```

## Aggregations

Compute numeric aggregations over a bucket's records.

### store.sum

```jsonc
→ { "id": 6, "type": "store.sum", "bucket": "products", "field": "price" }
← { "id": 6, "type": "result", "data": 60 }
```

### store.avg

```jsonc
→ { "id": 7, "type": "store.avg", "bucket": "products", "field": "price" }
← { "id": 7, "type": "result", "data": 20 }
```

### store.min

```jsonc
→ { "id": 8, "type": "store.min", "bucket": "products", "field": "price" }
← { "id": 8, "type": "result", "data": 5 }
```

### store.max

```jsonc
→ { "id": 9, "type": "store.max", "bucket": "products", "field": "price" }
← { "id": 9, "type": "result", "data": 99 }
```

**Required fields:** `bucket`, `field`
**Optional fields:** `filter`

All aggregations accept an optional `filter` to narrow the dataset:

```jsonc
// Sum of prices where stock >= 100
→ { "id": 10, "type": "store.sum", "bucket": "products", "field": "price",
    "filter": { "stock": 100 } }
← { "id": 10, "type": "result", "data": 5 }
```

**Empty bucket behavior:** `min` and `max` return `null` for empty buckets. `sum` returns `0`. `avg` returns `0` or `null` depending on the dataset.

## Working Example

```typescript
// Seed products
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Widget', price: 10, stock: 50 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Gadget', price: 25, stock: 30 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Doohickey', price: 5, stock: 100 } });

// Aggregations
const total = await sendRequest(ws, { type: 'store.sum', bucket: 'products', field: 'price' });
console.log('Total value:', total.data); // 40

const avg = await sendRequest(ws, { type: 'store.avg', bucket: 'products', field: 'price' });
console.log('Avg price:', avg.data); // ~13.33

const cheapest = await sendRequest(ws, { type: 'store.min', bucket: 'products', field: 'price' });
console.log('Cheapest:', cheapest.data); // 5

const priciest = await sendRequest(ws, { type: 'store.max', bucket: 'products', field: 'price' });
console.log('Most expensive:', priciest.data); // 25

// Paginate
const page1 = await sendRequest(ws, { type: 'store.paginate', bucket: 'products', limit: 2 });
console.log('Page 1:', page1.data.records.length, 'hasMore:', page1.data.hasMore);
```

## Exercise

Given a `orders` bucket with fields `id`, `total`, `status`, `customerId`, write messages to:
1. Get the sum of all order totals
2. Get the average order total for orders with status "completed"
3. Get the maximum order total
4. Paginate through all orders, 10 per page

<details>
<summary>Solution</summary>

```jsonc
// 1. Sum of all totals
→ { "id": 1, "type": "store.sum", "bucket": "orders", "field": "total" }

// 2. Average of completed orders
→ { "id": 2, "type": "store.avg", "bucket": "orders", "field": "total",
    "filter": { "status": "completed" } }

// 3. Max total
→ { "id": 3, "type": "store.max", "bucket": "orders", "field": "total" }

// 4. First page
→ { "id": 4, "type": "store.paginate", "bucket": "orders", "limit": 10 }
// If hasMore is true, send:
→ { "id": 5, "type": "store.paginate", "bucket": "orders", "limit": 10, "after": "<nextCursor>" }
```

</details>

## Summary

- `store.first`/`store.last` — get N records from start or end
- `store.paginate` — cursor-based pagination with `limit`, `after`, `hasMore`, `nextCursor`
- `store.sum`/`store.avg`/`store.min`/`store.max` — numeric aggregations on a field
- All aggregations support optional `filter`
- `min`/`max` return `null` for empty datasets

---

Next: [Metadata and Stats](./04-metadata-stats.md)
