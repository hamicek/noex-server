# Permissions

Control what each authenticated user can do with per-operation permission checks.

## What You'll Learn

- `PermissionConfig.check` — the permission function signature
- How `operation` and `resource` are extracted from requests
- Role-based access patterns
- The `FORBIDDEN` error code

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession, PermissionConfig } from '@hamicek/noex-server';

const store = await Store.start({ name: 'permissions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineBucket('audit', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    action: { type: 'string', required: true },
  },
});

const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    // Admins can do everything
    if (session.roles.includes('admin')) return true;
    // Regular users can only read
    if (operation === 'store.get' || operation === 'store.all') return true;
    // Deny everything else
    return false;
  },
};

const auth: AuthConfig = {
  validate: async (token) => {
    const users: Record<string, AuthSession> = {
      'token-admin': { userId: 'alice', roles: ['admin'] },
      'token-user':  { userId: 'bob', roles: ['user'] },
    };
    return users[token] ?? null;
  },
  required: true,
  permissions,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## PermissionConfig

```typescript
interface PermissionConfig {
  check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

- **`session`** — the authenticated user's session (`userId`, `roles`, `metadata`)
- **`operation`** — the message type (e.g. `"store.insert"`, `"rules.emit"`)
- **`resource`** — extracted from the request (see below)
- **Returns** `true` to allow, `false` to deny

The `check` function is called on every request **after** authentication. It is only called when:
1. `permissions` is configured in `AuthConfig`
2. The user has an active session

## Resource Extraction

The `resource` parameter is extracted from the request based on the operation type:

### Store Operations

| Operation | Resource | Fallback |
|-----------|----------|----------|
| `store.subscribe` | `query` (query name) | `"*"` |
| `store.unsubscribe` | `subscriptionId` | `"*"` |
| All other `store.*` | `bucket` | `"*"` |

### Rules Operations

| Operation | Resource | Fallback |
|-----------|----------|----------|
| `rules.emit` | `topic` | `"*"` |
| `rules.setFact`, `rules.getFact`, `rules.deleteFact` | `key` | `"*"` |
| `rules.queryFacts`, `rules.subscribe` | `pattern` | `"*"` |
| `rules.getAllFacts`, `rules.stats` | — | `"*"` |

### Other Operations

All other operations use `"*"` as the resource.

## FORBIDDEN Error

When `check` returns `false`, the server responds with `FORBIDDEN`:

```jsonc
// Bob (role: "user") tries to insert
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Charlie" } }
← { "id": 1, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.insert on users" }
```

The error message includes both the operation and the resource for debugging.

## Role-Based Access Patterns

### Simple Role Check

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;
    if (session.roles.includes('user')) {
      return operation.startsWith('store.get') || operation === 'store.all';
    }
    return false;
  },
};
```

### Bucket-Level Permissions

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;

    // Users can read any bucket, but only write to their own data
    if (operation === 'store.get' || operation === 'store.all') return true;

    // Only managers can write to the "audit" bucket
    if (resource === 'audit') return session.roles.includes('manager');

    return session.roles.includes('editor');
  },
};
```

### Operation Allowlist

```typescript
const ROLE_PERMISSIONS: Record<string, Set<string>> = {
  admin:  new Set(['*']),
  editor: new Set(['store.get', 'store.all', 'store.insert', 'store.update', 'store.where']),
  viewer: new Set(['store.get', 'store.all', 'store.where', 'store.count']),
};

const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    for (const role of session.roles) {
      const allowed = ROLE_PERMISSIONS[role];
      if (allowed?.has('*') || allowed?.has(operation)) return true;
    }
    return false;
  },
};
```

## Combined Auth + Permissions Flow

```
Client Request
      │
      ▼
┌─────────────────┐
│ Is auth required │──▶ Yes ──▶ Authenticated? ──▶ No ──▶ UNAUTHORIZED
│ and not auth.*?  │                │
└─────────────────┘               Yes
                                   │
                                   ▼
                          ┌──────────────┐
                          │ Session       │──▶ Expired? ──▶ Yes ──▶ UNAUTHORIZED
                          │ expiration?   │
                          └──────┬───────┘
                                 │ No
                                 ▼
                          ┌──────────────┐
                          │ Permissions   │──▶ check() = false ──▶ FORBIDDEN
                          │ configured?   │
                          └──────┬───────┘
                                 │ check() = true
                                 ▼
                          Process request
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `FORBIDDEN` | `permissions.check()` returned `false` |
| `UNAUTHORIZED` | Not authenticated (when `required: true`) or session expired |

## Working Example

```typescript
// Login as admin
await sendRequest(ws, { type: 'auth.login', token: 'token-admin' });

// Admin can insert
const insertResp = await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Charlie' },
});
console.log(insertResp.data.name); // "Charlie"

// Login as regular user (on a different connection)
await sendRequest(ws2, { type: 'auth.login', token: 'token-user' });

// User can read
const getResp = await sendRequest(ws2, {
  type: 'store.get',
  bucket: 'users',
  key: insertResp.data.id,
});
console.log(getResp.data.name); // "Charlie"

// User cannot insert
const failResp = await sendRequest(ws2, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Denied' },
});
console.log(failResp.code); // "FORBIDDEN"
```

## Exercise

Implement a permission system where:
1. `admin` role can do everything
2. `editor` role can read and write to the `users` bucket, but cannot delete
3. `viewer` role can only read (get, all, where, count)

Then show requests from each role demonstrating allowed and denied operations.

<details>
<summary>Solution</summary>

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;

    if (session.roles.includes('editor')) {
      if (operation === 'store.delete') return false;
      return true;
    }

    if (session.roles.includes('viewer')) {
      const readOps = new Set(['store.get', 'store.all', 'store.where', 'store.count', 'store.findOne']);
      return readOps.has(operation);
    }

    return false;
  },
};
```

```jsonc
// Editor: insert works
→ { "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
← { "id": 1, "type": "result", "data": { "id": "a1", "name": "Alice", ... } }

// Editor: delete denied
→ { "id": 2, "type": "store.delete", "bucket": "users", "key": "a1" }
← { "id": 2, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.delete on users" }

// Viewer: read works
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "a1" }
← { "id": 3, "type": "result", "data": { "id": "a1", "name": "Alice", ... } }

// Viewer: insert denied
→ { "id": 4, "type": "store.insert", "bucket": "users", "data": { "name": "Bob" } }
← { "id": 4, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.insert on users" }
```

</details>

## Summary

- `PermissionConfig.check(session, operation, resource)` — return `true` to allow, `false` to deny
- `operation` is the message type (e.g. `store.insert`, `rules.emit`)
- `resource` is extracted from the request: bucket, topic, key, pattern, or `"*"`
- Permissions are checked **after** authentication — requires an active session
- `FORBIDDEN` includes the operation and resource in the error message
- Common patterns: role-based, bucket-level, operation allowlists

---

Next: [Session Lifecycle](./03-session-lifecycle.md)
