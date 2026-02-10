# Basic CRUD

The foundation of noex-server: create, read, update, and delete records through the WebSocket protocol. Each operation maps to a `store.*` message type.

## What You'll Learn

- How to insert records with `store.insert`
- How to retrieve records with `store.get`
- How to update records with `store.update`
- How to delete records with `store.delete`
- How version tracking works with `_version`

## Server Setup

All examples in this chapter assume this server setup:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'crud-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string' },
    role:  { type: 'string', default: 'user' },
    age:   { type: 'number' },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## store.insert

Creates a new record. The server applies schema defaults and auto-generates fields (like `id`), then returns the complete record.

```jsonc
// Request
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "email": "alice@example.com" } }

// Response
← { "id": 1, "type": "result",
    "data": {
      "id": "a1b2c3d4",
      "name": "Alice",
      "email": "alice@example.com",
      "role": "user",
      "_version": 1,
      "_createdAt": 1706745600000
    }
  }
```

**Required fields:** `bucket`, `data`

Notice:
- `id` was auto-generated (schema has `generated: 'uuid'`)
- `role` got its default value `"user"`
- `_version` starts at 1
- `_createdAt` is a Unix timestamp in milliseconds

**Errors:**
- `VALIDATION_ERROR` — missing `bucket`, missing `data`, or missing required schema fields
- `BUCKET_NOT_DEFINED` — bucket doesn't exist

## store.get

Retrieves a single record by primary key. Returns `null` (not an error) if the key doesn't exist.

```jsonc
// Request
→ { "id": 2, "type": "store.get", "bucket": "users", "key": "a1b2c3d4" }

// Response (found)
← { "id": 2, "type": "result",
    "data": { "id": "a1b2c3d4", "name": "Alice", "email": "alice@example.com", "role": "user", "_version": 1 } }

// Response (not found)
← { "id": 3, "type": "result", "data": null }
```

**Required fields:** `bucket`, `key`

**Important:** A missing record returns `data: null`, not a `NOT_FOUND` error. This is intentional — checking existence is a normal operation, not an exceptional one.

## store.update

Updates an existing record. Only the fields in `data` are changed; other fields are preserved. The `_version` is incremented.

```jsonc
// Request
→ { "id": 4, "type": "store.update", "bucket": "users",
    "key": "a1b2c3d4", "data": { "name": "Alice Smith", "role": "admin" } }

// Response
← { "id": 4, "type": "result",
    "data": {
      "id": "a1b2c3d4",
      "name": "Alice Smith",
      "email": "alice@example.com",
      "role": "admin",
      "_version": 2
    }
  }
```

**Required fields:** `bucket`, `key`, `data`

Notice:
- `email` was not in the update `data`, so it's preserved
- `_version` incremented from 1 to 2

## store.delete

Deletes a record by primary key. Returns `{ deleted: true }`.

```jsonc
// Request
→ { "id": 5, "type": "store.delete", "bucket": "users", "key": "a1b2c3d4" }

// Response
← { "id": 5, "type": "result", "data": { "deleted": true } }
```

**Required fields:** `bucket`, `key`

After deletion, `store.get` for the same key returns `null`.

## Full CRUD Lifecycle

```jsonc
// 1. INSERT
→ { "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Bob" } }
← { "id": 1, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "user", "_version": 1 } }

// 2. READ
→ { "id": 2, "type": "store.get", "bucket": "users", "key": "xyz" }
← { "id": 2, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "user", "_version": 1 } }

// 3. UPDATE
→ { "id": 3, "type": "store.update", "bucket": "users", "key": "xyz", "data": { "role": "admin" } }
← { "id": 3, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "admin", "_version": 2 } }

// 4. DELETE
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "xyz" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// 5. VERIFY DELETION
→ { "id": 5, "type": "store.get", "bucket": "users", "key": "xyz" }
← { "id": 5, "type": "result", "data": null }
```

## Version Tracking

Every record has a `_version` field:
- Starts at `1` on insert
- Increments by 1 on each update
- Used for optimistic concurrency in transactions (covered in Part 6)

## Multi-Client Consistency

Data is shared across all connections. An insert by one client is immediately visible to another:

```text
Client A                             Server                           Client B
   │                                    │                                │
   │── insert { name: "Carol" } ──────►│                                │
   │◄── result { id: "c1", ... } ──────│                                │
   │                                    │                                │
   │                                    │◄── get { key: "c1" } ─────────│
   │                                    │──► result { name: "Carol" } ──►│
```

## Exercise

Write a sequence of WebSocket messages that:
1. Inserts a user with name "Eve" and email "eve@example.com"
2. Updates the user's role to "moderator"
3. Reads the user to verify the update
4. Deletes the user
5. Reads again to confirm deletion

<details>
<summary>Solution</summary>

```jsonc
// 1. Insert
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Eve", "email": "eve@example.com" } }
← { "id": 1, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "user", "_version": 1 } }

// 2. Update role
→ { "id": 2, "type": "store.update", "bucket": "users",
    "key": "e1", "data": { "role": "moderator" } }
← { "id": 2, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "moderator", "_version": 2 } }

// 3. Read to verify
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "e1" }
← { "id": 3, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "moderator", "_version": 2 } }

// 4. Delete
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "e1" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// 5. Verify deletion
→ { "id": 5, "type": "store.get", "bucket": "users", "key": "e1" }
← { "id": 5, "type": "result", "data": null }
```

</details>

## Summary

- `store.insert` — creates a record, returns it with generated fields and `_version: 1`
- `store.get` — retrieves by key, returns `null` (not an error) if not found
- `store.update` — partial update, preserves unmentioned fields, increments `_version`
- `store.delete` — removes a record, returns `{ deleted: true }`
- All operations require `bucket`; insert needs `data`; get/update/delete need `key`
- Data is shared across all connections — writes are immediately visible

---

Next: [Queries and Filtering](./02-queries-filtering.md)
