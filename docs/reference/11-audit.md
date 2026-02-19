# Audit Log

The audit log records operations executed against the server into an in-memory ring buffer. Each recorded operation produces an `AuditEntry` with the user, operation, result, and timestamp. The audit subsystem is opt-in — configure it via the `audit` field in `ServerConfig`.

When audit logging is not configured, `audit.query` returns `UNKNOWN_OPERATION`.

---

## Configuration

See [AuditConfig](./02-configuration.md#auditconfig) for the full interface.

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

const server = await NoexServer.start({
  store,
  audit: {
    tiers: ['admin', 'write'],
    maxEntries: 50_000,
  },
});
```

---

## Operation Tiers

Every protocol operation belongs to one of three tiers. The `tiers` array in `AuditConfig` controls which tiers are recorded.

| Tier | Description | Default |
|------|-------------|---------|
| `admin` | Structural changes — bucket/query/rule/procedure management, server stats, identity operations | **Logged** |
| `write` | Data mutations — insert, update, delete, emit, transactions, procedure calls | Not logged |
| `read` | Data reads — get, where, subscribe, facts, stats | Not logged |

### Admin Tier Operations

| Operation | Category |
|-----------|----------|
| `store.defineBucket`, `store.dropBucket`, `store.updateBucket`, `store.getBucketSchema` | Bucket management |
| `store.defineQuery`, `store.undefineQuery`, `store.listQueries` | Query management |
| `rules.registerRule`, `rules.unregisterRule`, `rules.updateRule`, `rules.enableRule`, `rules.disableRule`, `rules.getRule`, `rules.getRules`, `rules.validateRule` | Rule management |
| `procedures.register`, `procedures.unregister`, `procedures.update`, `procedures.list` | Procedure management |
| `server.stats`, `server.connections`, `audit.query` | Server management |
| `identity.login`, `identity.loginWithSecret`, `identity.logout` | Authentication |
| `identity.createUser`, `identity.deleteUser`, `identity.enableUser`, `identity.disableUser` | User management |
| `identity.changePassword`, `identity.resetPassword` | Password management |
| `identity.createRole`, `identity.deleteRole`, `identity.assignRole`, `identity.removeRole` | Role management |
| `identity.grant`, `identity.revoke`, `identity.transferOwner` | ACL management |

### Write Tier Operations

| Operation | Category |
|-----------|----------|
| `store.insert`, `store.update`, `store.delete`, `store.clear`, `store.transaction` | Store mutations |
| `rules.emit`, `rules.setFact`, `rules.deleteFact` | Rules mutations |
| `procedures.call` | Procedure execution |

### Read Tier Operations

| Operation | Category |
|-----------|----------|
| `store.get`, `store.all`, `store.where`, `store.findOne`, `store.count`, `store.first`, `store.last`, `store.paginate` | Store reads |
| `store.sum`, `store.avg`, `store.min`, `store.max` | Store aggregations |
| `store.subscribe`, `store.unsubscribe`, `store.buckets`, `store.stats` | Store subscriptions & stats |
| `rules.getFact`, `rules.queryFacts`, `rules.getAllFacts` | Facts reads |
| `rules.subscribe`, `rules.unsubscribe`, `rules.stats` | Rules subscriptions & stats |
| `procedures.get` | Procedure reads |

---

## AuditEntry

Each audit log entry contains the following fields:

```typescript
interface AuditEntry {
  readonly timestamp: number;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly operation: string;
  readonly resource: string;
  readonly result: 'success' | 'error';
  readonly error?: string;
  readonly details?: Record<string, unknown>;
  readonly remoteAddress: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| timestamp | `number` | Unix timestamp (ms) when the operation was recorded. |
| userId | `string \| null` | Authenticated user ID, or `null` for unauthenticated requests. |
| sessionId | `string \| null` | Session ID, or `null` if not applicable. |
| operation | `string` | The operation type (e.g. `'store.insert'`, `'identity.login'`). |
| resource | `string` | The target resource (typically a bucket name or topic). |
| result | `'success' \| 'error'` | Whether the operation succeeded or failed. |
| error | `string` | Error message (only present when `result` is `'error'`). |
| details | `Record<string, unknown>` | Additional operation-specific details. |
| remoteAddress | `string` | Client's remote IP address. |

Both successful and failed operations are recorded. A permission-denied attempt on `server.stats` produces an entry with `result: 'error'` and the error message.

---

## audit.query

Queries the in-memory audit log. Returns entries newest-first. Requires `admin` role.

**Request:**

```json
{
  "id": 1,
  "type": "audit.query"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | `string` | no | Filter by user ID. |
| operation | `string` | no | Filter by operation type. |
| result | `'success' \| 'error'` | no | Filter by result. |
| from | `number` | no | Start timestamp (ms, inclusive). |
| to | `number` | no | End timestamp (ms, inclusive). |
| limit | `number` | no | Maximum entries to return (positive integer). |

**Response:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "entries": [
      {
        "timestamp": 1700000001000,
        "userId": "admin-1",
        "sessionId": "sess-abc",
        "operation": "store.defineBucket",
        "resource": "users",
        "result": "success",
        "remoteAddress": "127.0.0.1"
      },
      {
        "timestamp": 1700000000000,
        "userId": "admin-1",
        "sessionId": "sess-abc",
        "operation": "server.stats",
        "resource": "",
        "result": "success",
        "remoteAddress": "127.0.0.1"
      }
    ]
  }
}
```

**Filtered request example:**

```json
{
  "id": 2,
  "type": "audit.query",
  "userId": "admin-1",
  "operation": "identity.login",
  "result": "error",
  "from": 1700000000000,
  "to": 1700100000000,
  "limit": 50
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `UNKNOWN_OPERATION` | Audit logging is not configured. |
| `FORBIDDEN` | Caller does not have `admin` role. |
| `VALIDATION_ERROR` | Invalid filter field type (e.g. non-string `userId`, non-number `from`, non-positive `limit`). |

---

## External Persistence with onEntry

The in-memory ring buffer is bounded — oldest entries are overwritten when `maxEntries` is reached. For durable storage, use the `onEntry` callback to stream entries to an external system.

### JSONL File

```typescript
import { createWriteStream } from 'node:fs';

const auditStream = createWriteStream('audit.jsonl', { flags: 'a' });

const server = await NoexServer.start({
  store,
  auth: { builtIn: true, adminSecret: process.env.ADMIN_SECRET! },
  audit: {
    tiers: ['admin', 'write'],
    onEntry: (entry) => {
      auditStream.write(JSON.stringify(entry) + '\n');
    },
  },
});
```

### Database Insert

```typescript
import { pool } from './db.js';

const server = await NoexServer.start({
  store,
  auth: { builtIn: true, adminSecret: process.env.ADMIN_SECRET! },
  audit: {
    tiers: ['admin', 'write'],
    onEntry: (entry) => {
      pool.query(
        `INSERT INTO audit_log (timestamp, user_id, operation, resource, result, error, remote_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.timestamp, entry.userId, entry.operation, entry.resource, entry.result, entry.error ?? null, entry.remoteAddress],
      ).catch(console.error);
    },
  },
});
```

> **Note:** `onEntry` is called synchronously within the request path. Keep the callback fast — offload heavy work (network I/O, slow queries) asynchronously to avoid blocking request handling.

---

## Known Limitations

- **In-memory only.** The ring buffer does not survive server restarts. Use `onEntry` for durable storage.
- **Fixed-size buffer.** Default capacity is 10,000 entries. Once full, the oldest entries are silently overwritten.
- **No pagination.** `audit.query` returns all matching entries (up to `limit`) in a single response. For large result sets, use `limit` with `from`/`to` time ranges.

---

## See Also

- [Configuration — AuditConfig](./02-configuration.md#auditconfig) — Configuration interface and defaults
- [Configuration — AuditEntry](./02-configuration.md#auditentry) — Entry field reference
- [Configuration — AuditQuery](./02-configuration.md#auditquery) — Query filter reference
- [Authentication](./07-authentication.md) — Auth operations and session lifecycle
- [Errors](./10-errors.md) — Error codes
