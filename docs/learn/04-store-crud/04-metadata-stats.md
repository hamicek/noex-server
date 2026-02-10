# Metadata and Stats

Inspect the store's structure and statistics, and manage bucket data with `clear`.

## What You'll Learn

- How to list defined buckets with `store.buckets`
- How to get store statistics with `store.stats`
- How to clear all records from a bucket with `store.clear`

## store.buckets

Lists all defined buckets with their count.

```jsonc
→ { "id": 1, "type": "store.buckets" }
← { "id": 1, "type": "result", "data": {
    "count": 2,
    "names": ["users", "products"]
  } }
```

No additional fields needed — just `type: "store.buckets"`.

This is useful for introspection: discovering what buckets exist on the server without prior knowledge.

## store.stats

Returns aggregated store statistics.

```jsonc
→ { "id": 2, "type": "store.stats" }
← { "id": 2, "type": "result", "data": {
    "buckets": {
      "users": { "count": 42 },
      "products": { "count": 150 }
    },
    "records": { "total": 192 }
  } }
```

The exact shape of the stats object depends on the store implementation, but it always includes bucket-level record counts.

## store.clear

Removes all records from a bucket. Returns `{ cleared: true }`.

```jsonc
→ { "id": 3, "type": "store.clear", "bucket": "users" }
← { "id": 3, "type": "result", "data": { "cleared": true } }
```

**Required fields:** `bucket`

**Important:** Clearing one bucket does not affect other buckets:

```jsonc
// users has 3 records, products has 5 records
→ { "id": 4, "type": "store.clear", "bucket": "users" }
← { "id": 4, "type": "result", "data": { "cleared": true } }

// users is now empty, products still has 5
→ { "id": 5, "type": "store.count", "bucket": "users" }
← { "id": 5, "type": "result", "data": 0 }

→ { "id": 6, "type": "store.count", "bucket": "products" }
← { "id": 6, "type": "result", "data": 5 }
```

`store.clear` is a destructive operation. In production, consider restricting it with permissions:

```typescript
permissions: {
  check: (session, operation) => {
    if (operation === 'store.clear') {
      return session.roles.includes('admin');
    }
    return true;
  },
},
```

## Working Example

```typescript
// Inspect the store
const buckets = await sendRequest(ws, { type: 'store.buckets' });
console.log('Buckets:', buckets.data.names);
// ["users", "products"]

const stats = await sendRequest(ws, { type: 'store.stats' });
console.log('Stats:', stats.data);
// { buckets: { users: { count: 42 }, products: { count: 150 } }, records: { total: 192 } }

// Clear a bucket
await sendRequest(ws, { type: 'store.clear', bucket: 'users' });

// Verify
const count = await sendRequest(ws, { type: 'store.count', bucket: 'users' });
console.log('Users after clear:', count.data); // 0
```

## Complete Part 4 Operation Reference

| Operation | Required Fields | Optional Fields | Returns |
|-----------|----------------|-----------------|---------|
| `store.insert` | `bucket`, `data` | — | Record with generated fields |
| `store.get` | `bucket`, `key` | — | Record or `null` |
| `store.update` | `bucket`, `key`, `data` | — | Updated record |
| `store.delete` | `bucket`, `key` | — | `{ deleted: true }` |
| `store.all` | `bucket` | — | Array of records |
| `store.where` | `bucket`, `filter` | — | Array of matching records |
| `store.findOne` | `bucket`, `filter` | — | Record or `null` |
| `store.count` | `bucket` | `filter` | Number |
| `store.first` | `bucket`, `n` | — | Array of records |
| `store.last` | `bucket`, `n` | — | Array of records |
| `store.paginate` | `bucket`, `limit` | `after` | `{ records, hasMore, nextCursor? }` |
| `store.sum` | `bucket`, `field` | `filter` | Number |
| `store.avg` | `bucket`, `field` | `filter` | Number |
| `store.min` | `bucket`, `field` | `filter` | Number or `null` |
| `store.max` | `bucket`, `field` | `filter` | Number or `null` |
| `store.buckets` | — | — | `{ count, names }` |
| `store.stats` | — | — | Statistics object |
| `store.clear` | `bucket` | — | `{ cleared: true }` |

## Exercise

Write a monitoring script that connects to the server and periodically:
1. Lists all buckets
2. Gets the record count per bucket
3. Prints a summary

<details>
<summary>Solution</summary>

```typescript
async function monitor(ws: WebSocket) {
  const buckets = await sendRequest(ws, { type: 'store.buckets' });

  console.log(`=== Store Monitor ===`);
  console.log(`Buckets: ${buckets.data.count}`);

  for (const name of buckets.data.names) {
    const count = await sendRequest(ws, { type: 'store.count', bucket: name });
    console.log(`  ${name}: ${count.data} records`);
  }

  const stats = await sendRequest(ws, { type: 'store.stats' });
  console.log(`Total records: ${stats.data.records.total}`);
}

// Run every 10 seconds
setInterval(() => monitor(ws), 10_000);
```

</details>

## Summary

- `store.buckets` — discover defined buckets (`{ count, names }`)
- `store.stats` — aggregated store statistics
- `store.clear` — remove all records from one bucket (other buckets unaffected)
- Consider permission-gating `store.clear` in production
- Parts 1–4 cover all 18 store operations for CRUD, queries, pagination, aggregations, and metadata

---

Next: [Subscribing to Queries](../05-subscriptions/01-subscribing.md)
