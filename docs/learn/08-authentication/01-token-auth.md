# Token Authentication

Secure your server with token-based authentication. Clients send a token via `auth.login`, the server validates it with your custom function, and a session is established.

## What You'll Learn

- `AuthConfig` with the `validate` function
- The `auth.login` flow — token to session
- The `required` flag — blocking unauthenticated requests
- The welcome message `requiresAuth` field
- `AuthSession` structure

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession } from '@hamicek/noex-server';

const store = await Store.start({ name: 'auth-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

const auth: AuthConfig = {
  validate: async (token: string): Promise<AuthSession | null> => {
    // Your custom validation logic (e.g. verify JWT, check database)
    if (token === 'valid-token-alice') {
      return {
        userId: 'alice',
        roles: ['admin'],
        metadata: { email: 'alice@example.com' },
        expiresAt: Date.now() + 3600_000, // 1 hour
      };
    }
    return null; // Invalid token
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## AuthConfig

```typescript
interface AuthConfig {
  validate: (token: string) => Promise<AuthSession | null>;
  required?: boolean;        // Default: true when auth is configured
  permissions?: PermissionConfig;
}
```

- **`validate`** — receives the token string, returns an `AuthSession` on success or `null` on failure. This is where you implement JWT verification, database lookup, API key check, etc.
- **`required`** — when `true` (default), all non-auth requests require authentication. When `false`, unauthenticated clients can still send requests.
- **`permissions`** — optional per-operation permission checks (see [Permissions](./02-permissions.md))

## AuthSession

The session object returned by `validate`:

```typescript
interface AuthSession {
  userId: string;
  roles: readonly string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;   // Unix timestamp in milliseconds
}
```

- **`userId`** — unique user identifier
- **`roles`** — array of role strings for permission checks
- **`metadata`** — optional extra data (email, display name, etc.)
- **`expiresAt`** — optional expiration timestamp — the server checks this on every request

## Welcome Message

When a client connects, the server sends a welcome message indicating whether authentication is required:

```jsonc
← { "type": "welcome",
    "version": "1.0.0",
    "serverTime": 1706745600000,
    "requiresAuth": true }
```

`requiresAuth` is `true` when `auth` is configured and `required !== false`.

## auth.login

Send a token to authenticate:

```jsonc
→ { "id": 1, "type": "auth.login", "token": "valid-token-alice" }

← { "id": 1, "type": "result",
    "data": {
      "userId": "alice",
      "roles": ["admin"],
      "expiresAt": 1706749200000
    } }
```

**Required fields:**
- `token` — non-empty string

### Login Errors

```jsonc
// Missing token
→ { "id": 2, "type": "auth.login" }
← { "id": 2, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"token\": expected non-empty string" }

// Invalid token (validate returned null)
→ { "id": 3, "type": "auth.login", "token": "wrong-token" }
← { "id": 3, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Invalid token" }

// Expired token (session.expiresAt < Date.now())
→ { "id": 4, "type": "auth.login", "token": "expired-token" }
← { "id": 4, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Token has expired" }
```

## Required vs Optional Auth

### Required Auth (default)

When `required: true`, any request other than `auth.*` without a valid session returns `UNAUTHORIZED`:

```jsonc
// Not logged in yet
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }

// Login first
→ { "id": 2, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 2, "type": "result", "data": { "userId": "alice", ... } }

// Now it works
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 3, "type": "result", "data": { ... } }
```

### Optional Auth

With `required: false`, unauthenticated clients can send requests, but they don't have a session:

```typescript
const auth: AuthConfig = {
  validate: async (token) => { /* ... */ },
  required: false,
};
```

```jsonc
// Works without login
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "result", "data": { ... } }

// Login is still available for permission checks
→ { "id": 2, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 2, "type": "result", "data": { "userId": "alice", ... } }
```

## No Auth Configured

When `auth` is not passed to `NoexServer.start()`, all `auth.*` requests return `UNKNOWN_OPERATION`:

```jsonc
→ { "id": 1, "type": "auth.login", "token": "abc" }
← { "id": 1, "type": "error",
    "code": "UNKNOWN_OPERATION",
    "message": "Authentication is not configured" }
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `VALIDATION_ERROR` | Missing or invalid `token` field |
| `UNAUTHORIZED` | Invalid token, expired token, or authentication required |
| `UNKNOWN_OPERATION` | Auth is not configured on the server |

## Working Example

```typescript
const auth: AuthConfig = {
  validate: async (token) => {
    const users: Record<string, AuthSession> = {
      'token-alice': { userId: 'alice', roles: ['admin'] },
      'token-bob':   { userId: 'bob', roles: ['user'] },
    };
    return users[token] ?? null;
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });

// Client connects and receives welcome
// ← { "type": "welcome", ..., "requiresAuth": true }

// Login
const loginResp = await sendRequest(ws, {
  type: 'auth.login',
  token: 'token-alice',
});
console.log(loginResp.data.userId); // "alice"
console.log(loginResp.data.roles);  // ["admin"]

// Now all operations work
const getResp = await sendRequest(ws, {
  type: 'store.get',
  bucket: 'users',
  key: 'u1',
});
```

## Exercise

Create a server with required authentication. Write a sequence showing:
1. A client connects and sees `requiresAuth: true`
2. A `store.get` request fails with `UNAUTHORIZED`
3. `auth.login` with an invalid token fails with `UNAUTHORIZED`
4. `auth.login` with a valid token succeeds
5. The same `store.get` now works

<details>
<summary>Solution</summary>

```jsonc
// 1. Client connects
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": true }

// 2. Request without auth
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }

// 3. Bad token
→ { "id": 2, "type": "auth.login", "token": "wrong" }
← { "id": 2, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Invalid token" }

// 4. Good token
→ { "id": 3, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 3, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"], "expiresAt": ... } }

// 5. Now it works
→ { "id": 4, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 4, "type": "result", "data": { ... } }
```

</details>

## Summary

- Configure auth with `AuthConfig.validate` — your custom token-to-session function
- `auth.login` validates the token and establishes a session per-connection
- `required: true` (default) blocks all non-auth requests until login
- `required: false` allows unauthenticated access but still supports login
- Session includes `userId`, `roles`, optional `metadata` and `expiresAt`
- Welcome message tells clients whether auth is required via `requiresAuth`

---

Next: [Permissions](./02-permissions.md)
