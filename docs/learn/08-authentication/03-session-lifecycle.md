# Session Lifecycle

Inspect, end, and handle expiration of authenticated sessions.

## What You'll Learn

- `auth.whoami` — inspect the current session
- `auth.logout` — end a session
- Session expiration and automatic cleanup
- Re-authentication after expiry or logout
- Per-connection isolation of auth state

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession } from '@hamicek/noex-server';

const store = await Store.start({ name: 'session-demo' });

store.defineBucket('notes', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    text: { type: 'string', required: true },
  },
});

const auth: AuthConfig = {
  validate: async (token) => {
    if (token === 'token-alice') {
      return {
        userId: 'alice',
        roles: ['admin'],
        expiresAt: Date.now() + 3600_000, // 1 hour from now
      };
    }
    if (token === 'token-short') {
      return {
        userId: 'bob',
        roles: ['user'],
        expiresAt: Date.now() + 5_000, // Expires in 5 seconds
      };
    }
    return null;
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## auth.whoami

Inspect the current session without side effects:

```jsonc
// After login
→ { "id": 1, "type": "auth.whoami" }
← { "id": 1, "type": "result",
    "data": {
      "authenticated": true,
      "userId": "alice",
      "roles": ["admin"],
      "expiresAt": 1706749200000
    } }
```

When not authenticated:

```jsonc
→ { "id": 2, "type": "auth.whoami" }
← { "id": 2, "type": "result",
    "data": { "authenticated": false } }
```

**Note:** `auth.whoami` also checks session expiration. If the session has expired, it clears the session and returns `{ authenticated: false }`:

```jsonc
// Session expired since last request
→ { "id": 3, "type": "auth.whoami" }
← { "id": 3, "type": "result",
    "data": { "authenticated": false } }
```

## auth.logout

End the current session:

```jsonc
→ { "id": 4, "type": "auth.logout" }
← { "id": 4, "type": "result", "data": { "loggedOut": true } }
```

After logout:
- The session is cleared
- If `required: true`, further non-auth requests return `UNAUTHORIZED`
- The client can login again with `auth.login`

```jsonc
// After logout, requests are blocked (when required: true)
→ { "id": 5, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 5, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }
```

## Session Expiration

When `expiresAt` is set on the session, the server checks it on every request:

```
Login ──▶ Session active ──▶ ... ──▶ expiresAt reached
                                          │
                                          ▼
                                    Session cleared
                                          │
                                          ▼
                                    UNAUTHORIZED
                                    "Session expired"
```

### Expiration on Regular Requests

```jsonc
// Login with short-lived token (5 seconds)
→ { "id": 1, "type": "auth.login", "token": "token-short" }
← { "id": 1, "type": "result",
    "data": { "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// Works immediately
→ { "id": 2, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 2, "type": "result", "data": null }

// After 5 seconds...
→ { "id": 3, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 3, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Session expired" }
```

### Expiration on whoami

`auth.whoami` detects expiration and returns `authenticated: false` instead of throwing an error:

```jsonc
// Session expired
→ { "id": 4, "type": "auth.whoami" }
← { "id": 4, "type": "result",
    "data": { "authenticated": false } }
```

### Expiration on Login

If `validate` returns a session where `expiresAt` is already in the past, the login itself fails:

```jsonc
→ { "id": 5, "type": "auth.login", "token": "already-expired-token" }
← { "id": 5, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Token has expired" }
```

## Re-Authentication

After logout or session expiration, a client can login again:

```jsonc
// 1. Login
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// 2. Work...
→ { "id": 2, "type": "store.insert", "bucket": "notes", "data": { "text": "hello" } }
← { "id": 2, "type": "result", "data": { ... } }

// 3. Logout
→ { "id": 3, "type": "auth.logout" }
← { "id": 3, "type": "result", "data": { "loggedOut": true } }

// 4. Re-login (same or different token)
→ { "id": 4, "type": "auth.login", "token": "token-alice" }
← { "id": 4, "type": "result", "data": { "userId": "alice", ... } }

// 5. Continue working
→ { "id": 5, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 5, "type": "result", "data": { ... } }
```

## Per-Connection Isolation

Auth state is stored per-connection. Two WebSocket connections are completely independent:

```
Connection A: auth.login("token-alice")  ──▶  session = alice
Connection B: auth.login("token-bob")    ──▶  session = bob

Connection A: auth.logout               ──▶  session = null
Connection B: auth.whoami                ──▶  still bob ✓
```

- Logging out on one connection does NOT affect other connections
- Each connection maintains its own session independently
- Subscriptions belong to the connection, not the user

## Complete Session Timeline

```
Connect
  │
  ▼
← welcome { requiresAuth: true }
  │
  ▼
→ auth.login { token: "..." }
← result { userId, roles, expiresAt }
  │
  ▼
→ store.get / rules.emit / ...     ◀── permissions checked here
← result { ... }
  │
  ▼
→ auth.whoami                      ◀── check if still valid
← result { authenticated: true, ... }
  │
  ... time passes ...
  │
  ▼
→ store.get                        ◀── expiresAt < now
← error { UNAUTHORIZED, "Session expired" }
  │
  ▼
→ auth.login { token: "new-token" }   ◀── re-authenticate
← result { userId, roles, expiresAt }
  │
  ▼
→ auth.logout
← result { loggedOut: true }
  │
  ▼
Disconnect (session and subscriptions cleaned up)
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `UNAUTHORIZED` | Not authenticated, session expired |
| `UNKNOWN_OPERATION` | Auth not configured |

## Working Example

```typescript
// Login
const loginResp = await sendRequest(ws, {
  type: 'auth.login',
  token: 'token-alice',
});
console.log(loginResp.data.userId);    // "alice"
console.log(loginResp.data.expiresAt); // 1706749200000

// Check session
const whoamiResp = await sendRequest(ws, { type: 'auth.whoami' });
console.log(whoamiResp.data.authenticated); // true
console.log(whoamiResp.data.userId);        // "alice"

// Logout
const logoutResp = await sendRequest(ws, { type: 'auth.logout' });
console.log(logoutResp.data.loggedOut); // true

// Verify session is gone
const whoami2 = await sendRequest(ws, { type: 'auth.whoami' });
console.log(whoami2.data.authenticated); // false
```

## Exercise

Write a complete session lifecycle scenario:
1. Connect and check `whoami` (should be unauthenticated)
2. Login with a token that expires in 5 seconds
3. Verify the session with `whoami`
4. Wait for the token to expire
5. Try a store operation (should fail with `Session expired`)
6. Re-authenticate with a longer-lived token
7. Verify the new session with `whoami`

<details>
<summary>Solution</summary>

```jsonc
// 1. Check initial state
→ { "id": 1, "type": "auth.whoami" }
← { "id": 1, "type": "result", "data": { "authenticated": false } }

// 2. Login with short token
→ { "id": 2, "type": "auth.login", "token": "token-short" }
← { "id": 2, "type": "result",
    "data": { "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// 3. Verify session
→ { "id": 3, "type": "auth.whoami" }
← { "id": 3, "type": "result",
    "data": { "authenticated": true, "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// 4-5. After 5 seconds, store request fails
→ { "id": 4, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 4, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Session expired" }

// 6. Re-authenticate
→ { "id": 5, "type": "auth.login", "token": "token-alice" }
← { "id": 5, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"], "expiresAt": 1706749200000 } }

// 7. Verify new session
→ { "id": 6, "type": "auth.whoami" }
← { "id": 6, "type": "result",
    "data": { "authenticated": true, "userId": "alice", "roles": ["admin"], "expiresAt": 1706749200000 } }
```

</details>

## Summary

- `auth.whoami` returns current session info — `{ authenticated, userId, roles, expiresAt }`
- `auth.logout` clears the session — `{ loggedOut: true }`
- Sessions have optional `expiresAt` — the server checks expiration on every request
- Expired sessions are automatically cleared and return `UNAUTHORIZED` ("Session expired")
- `auth.whoami` detects expiration gracefully — returns `{ authenticated: false }` instead of error
- Clients can re-authenticate after logout or expiration with a new `auth.login`
- Auth state is per-connection — independent connections, independent sessions

---

Next: [Architecture](../09-connection-lifecycle/01-architecture.md)
