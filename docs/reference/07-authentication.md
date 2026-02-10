# Authentication

Client authentication and authorization system. Authentication is optional — when `auth` is omitted from `ServerConfig`, all auth operations return `UNKNOWN_OPERATION`. When configured, the server validates tokens via a user-provided `validate` function and enforces per-request permission checks.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
import type { AuthConfig, AuthSession, PermissionConfig } from '@hamicek/noex-server';
```

---

## Operations

### auth.login

```
{ id, type: "auth.login", token: string }
```

Authenticates the connection with a bearer token. The server calls `AuthConfig.validate(token)` to obtain a session. If the token is valid and not expired, the connection becomes authenticated and all subsequent requests are authorized under the returned session.

Re-authentication is supported — sending `auth.login` while already authenticated replaces the current session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| token | `string` | yes | Non-empty authentication token passed to `AuthConfig.validate`. |

**Returns:** `{ userId: string, roles: string[], expiresAt: number | null }`

**Errors:**

| Code | Condition |
|------|-----------|
| `VALIDATION_ERROR` | Token is missing, empty, or not a string. |
| `UNAUTHORIZED` | `validate` returned `null` (invalid token). |
| `UNAUTHORIZED` | Session `expiresAt` is in the past (token already expired). |
| `UNKNOWN_OPERATION` | Authentication is not configured on the server. |

**Example:**

```typescript
// Client sends:
{ id: 1, type: "auth.login", token: "eyJhbGciOiJIUzI1NiIs..." }

// Server responds (success):
{
  id: 1,
  type: "result",
  data: {
    userId: "user-1",
    roles: ["user"],
    expiresAt: 1700000000000
  }
}

// Server responds (invalid token):
{ id: 1, type: "error", code: "UNAUTHORIZED", message: "Invalid token" }
```

---

### auth.logout

```
{ id, type: "auth.logout" }
```

Clears the current session and sets the connection to unauthenticated. After logout, requests to protected operations will receive `UNAUTHORIZED` errors until the client logs in again.

Calling `auth.logout` when not authenticated is a no-op — it still returns `{ loggedOut: true }`.

**Parameters:** None.

**Returns:** `{ loggedOut: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `UNKNOWN_OPERATION` | Authentication is not configured on the server. |

**Example:**

```typescript
// Client sends:
{ id: 2, type: "auth.logout" }

// Server responds:
{ id: 2, type: "result", data: { loggedOut: true } }
```

---

### auth.whoami

```
{ id, type: "auth.whoami" }
```

Returns information about the current session. If the session has expired since the last request, it is automatically cleared and `{ authenticated: false }` is returned.

**Parameters:** None.

**Returns (authenticated):** `{ authenticated: true, userId: string, roles: string[], expiresAt: number | null }`

**Returns (not authenticated):** `{ authenticated: false }`

**Errors:**

| Code | Condition |
|------|-----------|
| `UNKNOWN_OPERATION` | Authentication is not configured on the server. |

**Example:**

```typescript
// Authenticated:
{ id: 3, type: "result", data: { authenticated: true, userId: "user-1", roles: ["user"], expiresAt: null } }

// Not authenticated:
{ id: 3, type: "result", data: { authenticated: false } }
```

---

## Session Lifecycle

### Connection Flow

1. Client connects — receives `WelcomeMessage` with `requiresAuth: true` (or `false` when `auth.required` is `false`).
2. Client sends `auth.login` with a token.
3. Server calls `AuthConfig.validate(token)` — an async function provided by the application.
4. If valid, the session is stored on the connection. All subsequent requests are checked against it.
5. On each request, the server checks `expiresAt` — if the session has expired, it is cleared and `UNAUTHORIZED` is returned.
6. Client can re-authenticate at any time with a new `auth.login`.
7. Client can log out with `auth.logout`.

### Session Expiration

The `expiresAt` field on `AuthSession` is an optional Unix timestamp (milliseconds). When set:

- During `auth.login`: if `expiresAt < Date.now()`, login is rejected with `"Token has expired"`.
- On subsequent requests: if the session has expired since the last check, it is cleared and `"Session expired"` is returned.
- During `auth.whoami`: expired sessions are detected and `{ authenticated: false }` is returned.

When `expiresAt` is omitted, the session never expires.

### Optional Authentication

When `AuthConfig.required` is set to `false`:

- The welcome message reports `requiresAuth: false`.
- Unauthenticated clients can access all operations.
- Clients may still log in to establish a session (useful for permission-based features).
- Permission checks are only applied when a session exists.

---

## Permissions

### PermissionConfig

When `AuthConfig.permissions` is provided, every non-auth request from an authenticated client is checked via the `check` function before execution.

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

**Parameters passed to `check`:**

| Name | Type | Description |
|------|------|-------------|
| session | `AuthSession` | Current authenticated session. |
| operation | `string` | The request type, e.g. `"store.insert"`, `"rules.emit"`. |
| resource | `string` | Extracted resource identifier (see Resource Extraction below). |

**Returns:** `true` to allow, `false` to deny with `FORBIDDEN`.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => { /* ... */ },
    permissions: {
      check: (session, operation, resource) => {
        // Admins can do anything
        if (session.roles.includes('admin')) return true;
        // Regular users cannot clear buckets
        if (operation === 'store.clear') return false;
        return true;
      },
    },
  },
});
```

### Resource Extraction

The resource string is automatically extracted from the request based on the operation namespace:

| Namespace | Extraction Logic | Example |
|-----------|-----------------|---------|
| `store.*` | `request.bucket`, or `request.query` for `store.subscribe`, or `request.subscriptionId` for `store.unsubscribe`. Falls back to `"*"`. | `"users"` |
| `rules.*` | `request.topic`, `request.key`, or `request.pattern` (in that order). Falls back to `"*"`. | `"user:created"` |
| Other | Always `"*"`. | `"*"` |

---

## Types

### AuthConfig

```typescript
interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| validate | `(token: string) => Promise<AuthSession \| null>` | — | Async function that validates a token and returns a session, or `null` for invalid tokens. |
| required | `boolean` | `true` | Whether authentication is required before accessing operations. |
| permissions | `PermissionConfig` | — | Optional per-request permission check function. |

### AuthSession

```typescript
interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | `string` | yes | Unique user identifier. Used as the rate limit key when authenticated. |
| roles | `readonly string[]` | yes | User roles, passed to the permission check function. |
| metadata | `Record<string, unknown>` | no | Arbitrary metadata attached to the session. |
| expiresAt | `number` | no | Unix timestamp (ms) when the session expires. Omit for non-expiring sessions. |

### PermissionConfig

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

---

## See Also

- [Configuration](./02-configuration.md) — ServerConfig with AuthConfig field
- [Protocol](./03-protocol.md) — WelcomeMessage with `requiresAuth` flag
- [Errors](./10-errors.md) — UNAUTHORIZED, FORBIDDEN, VALIDATION_ERROR error codes
- [Lifecycle](./08-lifecycle.md) — Rate limiting uses `userId` as key after authentication
