# Audit Logging

Track every operation on your server with the built-in audit log. The audit subsystem records who did what, when, and whether it succeeded — useful for security auditing, debugging, and compliance.

## What You'll Learn

- Enabling audit logging with `AuditConfig`
- Configuring which operation tiers to log
- Querying the audit log via `audit.query`
- Using `onEntry` for durable file persistence
- Ring buffer behavior and known limitations

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuditConfig, AuthConfig, AuthSession } from '@hamicek/noex-server';

const store = await Store.start({ name: 'audit-demo' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
    done:  { type: 'boolean', default: false },
  },
});

const auth: AuthConfig = {
  validate: async (token): Promise<AuthSession | null> => {
    if (token === 'admin-token') {
      return { userId: 'admin-1', roles: ['admin'] };
    }
    if (token === 'user-token') {
      return { userId: 'user-1', roles: ['writer'] };
    }
    return null;
  },
};

const server = await NoexServer.start({
  store,
  auth,
  audit: {
    tiers: ['admin', 'write'],
  },
  port: 8080,
});
```

This enables audit logging for all admin and write operations. Read operations (e.g. `store.get`) are not logged.

## Operation Tiers

Every protocol operation belongs to one of three tiers:

| Tier | What it covers | Default |
|------|---------------|---------|
| `admin` | Bucket/query/rule/procedure management, server stats, identity operations | **Logged** |
| `write` | Data mutations — insert, update, delete, emit, transactions | Not logged |
| `read` | Data reads — get, where, subscribe, stats | Not logged |

When you omit `tiers`, only `['admin']` is logged. To log everything:

```typescript
const server = await NoexServer.start({
  store,
  auth,
  audit: {
    tiers: ['admin', 'write', 'read'],
  },
  port: 8080,
});
```

> **Tip:** Logging all three tiers on a busy server can produce a high volume of entries. Start with `['admin']` or `['admin', 'write']` and add `'read'` only when needed.

## What Gets Recorded

Each operation produces an `AuditEntry`:

```typescript
interface AuditEntry {
  readonly timestamp: number;         // Unix timestamp (ms)
  readonly userId: string | null;     // Authenticated user, or null
  readonly sessionId: string | null;  // Session ID, or null
  readonly operation: string;         // e.g. 'store.insert'
  readonly resource: string;          // e.g. bucket name or topic
  readonly result: 'success' | 'error';
  readonly error?: string;            // Error message (when result is 'error')
  readonly details?: Record<string, unknown>;
  readonly remoteAddress: string;     // Client IP address
}
```

Both successful and failed operations are recorded. A permission-denied attempt produces an entry with `result: 'error'` and the corresponding error message.

## Querying the Audit Log

Use `audit.query` to retrieve entries. This operation requires the `admin` role.

### All Entries

```jsonc
→ { "id": 1, "type": "audit.query" }
← { "id": 1, "type": "result",
    "data": {
      "entries": [
        {
          "timestamp": 1700000002000,
          "userId": "admin-1",
          "sessionId": "sess-abc",
          "operation": "store.insert",
          "resource": "tasks",
          "result": "success",
          "remoteAddress": "127.0.0.1"
        },
        {
          "timestamp": 1700000001000,
          "userId": "admin-1",
          "sessionId": "sess-abc",
          "operation": "store.defineBucket",
          "resource": "tasks",
          "result": "success",
          "remoteAddress": "127.0.0.1"
        }
      ]
    } }
```

Entries are returned **newest-first**.

### Filtering

All filter fields are optional and combinable:

```jsonc
→ { "id": 2, "type": "audit.query",
    "userId": "admin-1",
    "operation": "store.insert",
    "result": "success",
    "from": 1700000000000,
    "to": 1700100000000,
    "limit": 10 }
← { "id": 2, "type": "result",
    "data": { "entries": [ ... ] } }
```

| Filter | Type | Description |
|--------|------|-------------|
| `userId` | `string` | Only entries from this user. |
| `operation` | `string` | Only entries for this operation type. |
| `result` | `'success' \| 'error'` | Only successes or only errors. |
| `from` | `number` | Start timestamp (ms, inclusive). |
| `to` | `number` | End timestamp (ms, inclusive). |
| `limit` | `number` | Maximum number of entries to return (positive integer). |

### Access Control

Only users with the `admin` role can query the audit log:

```jsonc
// writer tries to query audit log
→ { "id": 3, "type": "audit.query" }
← { "id": 3, "type": "error",
    "code": "FORBIDDEN",
    "message": "Insufficient permissions" }
```

## Durable Persistence with onEntry

The in-memory ring buffer is bounded (default: 10,000 entries). Oldest entries are silently overwritten when full. For durable storage, use the `onEntry` callback.

### JSONL File Persistence

```typescript
import { createWriteStream } from 'node:fs';

const auditStream = createWriteStream('audit.jsonl', { flags: 'a' });

const server = await NoexServer.start({
  store,
  auth,
  audit: {
    tiers: ['admin', 'write'],
    onEntry: (entry) => {
      auditStream.write(JSON.stringify(entry) + '\n');
    },
  },
  port: 8080,
});
```

Each line in `audit.jsonl` is a self-contained JSON object:

```json
{"timestamp":1700000001000,"userId":"admin-1","sessionId":"sess-abc","operation":"store.insert","resource":"tasks","result":"success","remoteAddress":"127.0.0.1"}
{"timestamp":1700000002000,"userId":"user-1","sessionId":"sess-def","operation":"store.update","resource":"tasks","result":"success","remoteAddress":"127.0.0.1"}
```

> **Note:** `onEntry` is called synchronously within the request path. The `createWriteStream` write is non-blocking (buffered by Node.js), so this pattern is safe. Avoid `fs.writeFileSync` or other blocking calls — they will stall request processing.

### Ring Buffer Size

Control the in-memory capacity with `maxEntries`:

```typescript
const server = await NoexServer.start({
  store,
  auth,
  audit: {
    maxEntries: 50_000,   // Keep last 50K entries in memory
    tiers: ['admin'],
  },
  port: 8080,
});
```

When `audit.query` is used without `onEntry`, only the last `maxEntries` operations are available.

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `UNKNOWN_OPERATION` | Audit logging is not configured. |
| `FORBIDDEN` | Caller does not have `admin` role. |
| `VALIDATION_ERROR` | Invalid filter value (e.g. non-string `userId`, non-number `from`, non-positive `limit`). |

## Working Example

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession, AuditConfig } from '@hamicek/noex-server';

// 1. Store
const store = await Store.start({ name: 'audit-example' });
store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    message: { type: 'string', required: true },
  },
});

// 2. Auth
const auth: AuthConfig = {
  validate: async (token): Promise<AuthSession | null> => {
    if (token === 'admin-token') {
      return { userId: 'admin-1', roles: ['admin'] };
    }
    return null;
  },
};

// 3. Audit with file persistence
const collected: string[] = [];
const audit: AuditConfig = {
  tiers: ['admin', 'write'],
  maxEntries: 1_000,
  onEntry: (entry) => {
    collected.push(JSON.stringify(entry));
  },
};

// 4. Start server
const server = await NoexServer.start({ store, auth, audit, port: 8080 });

// --- Client side (after connecting and logging in as admin) ---

// Insert a record (write tier → audited)
// → { "id": 1, "type": "store.insert", "bucket": "logs", "data": { "message": "hello" } }
// ← { "id": 1, "type": "result", "data": { "id": "...", "message": "hello" } }

// Query audit log — see the insert
// → { "id": 2, "type": "audit.query", "operation": "store.insert" }
// ← { "id": 2, "type": "result", "data": { "entries": [{ "operation": "store.insert", ... }] } }

// Query only errors from the last hour
// → { "id": 3, "type": "audit.query", "result": "error", "from": 1700000000000 }
// ← { "id": 3, "type": "result", "data": { "entries": [] } }
```

## Exercise

Set up a server with audit logging (`tiers: ['admin', 'write']`) and an `onEntry` callback that collects entries into an array. Then:

1. Login as admin
2. Insert a record into a bucket
3. Query the audit log filtered by `operation: 'store.insert'`
4. Verify the entry contains the correct `userId`, `resource`, and `result`
5. Verify the `onEntry` array also captured the same entry

<details>
<summary>Solution</summary>

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession, AuditConfig, AuditEntry } from '@hamicek/noex-server';
import { WebSocket } from 'ws';

// Setup
const store = await Store.start({ name: 'audit-exercise' });
store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

const auth: AuthConfig = {
  validate: async (token): Promise<AuthSession | null> => {
    if (token === 'admin') return { userId: 'admin-1', roles: ['admin'] };
    return null;
  },
};

const collected: AuditEntry[] = [];
const audit: AuditConfig = {
  tiers: ['admin', 'write'],
  onEntry: (entry) => collected.push(entry),
};

const server = await NoexServer.start({ store, auth, audit, port: 0, host: '127.0.0.1' });

// Connect
const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
await new Promise((resolve) => ws.once('message', resolve)); // welcome

// Helper
let nextId = 1;
function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = nextId++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.off('message', handler); resolve(msg); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

// 1. Login
await send({ type: 'auth.login', token: 'admin' });

// 2. Insert
await send({ type: 'store.insert', bucket: 'items', data: { name: 'Widget' } });

// 3. Query audit log
const resp = await send({ type: 'audit.query', operation: 'store.insert' });
const entries = (resp.data as any).entries;

// 4. Verify
console.log(entries[0].userId);    // "admin-1"
console.log(entries[0].resource);  // "items"
console.log(entries[0].result);    // "success"

// 5. onEntry also captured it
const match = collected.find((e) => e.operation === 'store.insert');
console.log(match?.userId);    // "admin-1"
console.log(match?.resource);  // "items"

// Cleanup
ws.close();
await server.stop();
await store.stop();
```

</details>

## Summary

- Enable audit logging with the `audit` field in `ServerConfig` — `{ tiers: ['admin'] }` is the minimum
- Three tiers: `admin` (default), `write`, `read` — each covers a category of operations
- Both successes and failures are recorded with full context (`AuditEntry`)
- Use `audit.query` to retrieve entries (newest-first) with optional filters (`userId`, `operation`, `result`, `from`, `to`, `limit`)
- Only `admin` role users can query the audit log
- The ring buffer is in-memory with a default capacity of 10,000 entries
- Use `onEntry` to stream entries to a file, database, or any external system for durable storage

---

Next: [Architecture](../09-connection-lifecycle/01-architecture.md)
