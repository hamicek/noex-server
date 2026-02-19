# Built-in Identity

The built-in identity system provides a complete authentication and authorization solution without external dependencies. It manages users, sessions, roles, ACL (access control lists), and resource ownership — all stored in the noex-store itself using system buckets (`_users`, `_roles`, `_user_roles`, `_acl`, `_sessions`, `_resource_owners`).

Activate it by passing `{ builtIn: true }` in the `auth` field of `ServerConfig`. When built-in auth is active, the 27 `identity.*` operations become available and the custom `auth.login` / `auth.logout` / `auth.whoami` operations are replaced by their identity equivalents.

---

## Configuration

See [BuiltInAuthConfig](./02-configuration.md#builtinauthconfig) for the full interface.

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

const server = await NoexServer.start({
  store,
  auth: {
    builtIn: true,
    adminSecret: process.env.ADMIN_SECRET!,
    sessionTtl: 24 * 60 * 60 * 1000,     // 24 hours (default)
    passwordMinLength: 8,                  // default
    maxSessionsPerUser: 10,                // default
    loginRateLimit: {
      maxAttempts: 5,                      // default
      windowMs: 15 * 60 * 1000,           // 15 minutes (default)
    },
  },
});
```

---

## System Roles

Four system roles are created automatically on first start. They cannot be deleted.

| Role | Description | Permissions |
|------|-------------|-------------|
| `superadmin` | Full access to everything | `*` — bypasses all permission checks |
| `admin` | Structural operations, data mutations, reads, and user management | `store.*`, `rules.*`, `procedures.*`, `server.*`, `audit.*`, user CRUD, role assignment, ACL management |
| `writer` | Data mutations and reads | Store CRUD, facts, events, procedure calls |
| `reader` | Read-only access | Store reads, aggregations, subscriptions, facts reads, procedure reads |

### Permission Resolution

Permission checks follow this order (first match wins):

1. **Superadmin** — always allowed
2. **User ACL** on the target resource
3. **Role ACL** on the target resource
4. **Resource ownership** — owner has full access
5. **Role permissions** — declarative `allow` patterns from the role definition
6. **Default** — deny

---

## Bootstrap Flow

When no users exist yet, use `identity.loginWithSecret` with the `adminSecret` to authenticate as the virtual superadmin (`__superadmin__`). Then create your first real admin user and assign them a role.

```typescript
// 1. Login with admin secret
{ id: 1, type: "identity.loginWithSecret", secret: "my-secret" }

// 2. Create an admin user
{ id: 2, type: "identity.createUser", username: "admin", password: "secure-password-123" }

// 3. Assign admin role (use the userId from step 2 response)
{ id: 3, type: "identity.assignRole", userId: "<user-id>", roleName: "admin" }
```

---

## Authentication Operations

### identity.login

```
{ id, type: "identity.login", username: string, password: string }
```

Authenticates with username and password. Creates a new session. Rate-limited per username and per IP.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| username | `string` | yes | User's username. |
| password | `string` | yes | User's password. |

**Returns:** `LoginResult`

```json
{
  "token": "session-token-abc",
  "expiresAt": 1700086400000,
  "user": {
    "id": "user-1",
    "username": "admin",
    "roles": ["admin"]
  }
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| `UNAUTHORIZED` | Invalid credentials. |
| `UNAUTHORIZED` | Account disabled. |
| `RATE_LIMITED` | Too many failed login attempts. |
| `VALIDATION_ERROR` | Missing or empty `username` / `password`. |

---

### identity.loginWithSecret

```
{ id, type: "identity.loginWithSecret", secret: string }
```

Bootstrap login with the `adminSecret`. Authenticates as the virtual superadmin user (`__superadmin__`). Rate-limited per IP.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| secret | `string` | yes | The `adminSecret` from `BuiltInAuthConfig`. |

**Returns:** `LoginResult` — same shape as `identity.login`, with `userId: "__superadmin__"` and `roles: ["superadmin"]`.

**Errors:**

| Code | Condition |
|------|-----------|
| `UNAUTHORIZED` | Invalid secret. |
| `RATE_LIMITED` | Too many failed attempts from this IP. |
| `VALIDATION_ERROR` | Missing or empty `secret`. |

---

### identity.logout

```
{ id, type: "identity.logout" }
```

Destroys the current session and clears connection authentication state. Safe to call when not authenticated (no-op).

**Parameters:** None.

**Returns:** `{ loggedOut: true }`

---

### identity.whoami

```
{ id, type: "identity.whoami" }
```

Returns information about the current session. Does not require authentication — returns `{ authenticated: false }` for unauthenticated connections.

**Parameters:** None.

**Returns (authenticated):**

```json
{
  "authenticated": true,
  "userId": "user-1",
  "roles": ["admin"],
  "expiresAt": 1700086400000
}
```

**Returns (not authenticated):** `{ authenticated: false }`

---

### identity.refreshSession

```
{ id, type: "identity.refreshSession" }
```

Refreshes the current session — deletes the old session token and creates a new one with a fresh expiry. The connection's auth state is updated in place.

**Requires:** Active session.

**Parameters:** None.

**Returns:** `LoginResult` — new token and expiry.

**Errors:**

| Code | Condition |
|------|-----------|
| `UNAUTHORIZED` | No active session, or session expired/invalid. |

---

## User CRUD Operations

All user CRUD operations require `admin` or `superadmin` role unless noted otherwise.

### identity.createUser

```
{ id, type: "identity.createUser", username: string, password: string, ... }
```

Creates a new user account.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| username | `string` | yes | Unique username (3–64 characters). |
| password | `string` | yes | Password (minimum 8 characters by default). |
| displayName | `string` | no | Display name. |
| email | `string` | no | Email address. |
| enabled | `boolean` | no | Account enabled state. Default: `true`. |
| metadata | `object` | no | Arbitrary metadata. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `UserInfo`

```json
{
  "id": "generated-uuid",
  "username": "alice",
  "displayName": "Alice",
  "enabled": true,
  "_createdAt": 1700000000000,
  "_updatedAt": 1700000000000
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `VALIDATION_ERROR` | Username too short/long, password too short. |
| `ALREADY_EXISTS` | Username already taken. |

---

### identity.getUser

```
{ id, type: "identity.getUser", userId: string }
```

Returns a user by ID (password hash is never exposed).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | User ID. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `UserInfo`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `NOT_FOUND` | User does not exist. |

---

### identity.updateUser

```
{ id, type: "identity.updateUser", userId: string, ... }
```

Updates user profile fields. Users can update their own profile; admins can update anyone.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | User ID. |
| displayName | `string` | no | New display name. |
| email | `string` | no | New email. |
| metadata | `object` | no | New metadata (replaces existing). |

**Requires:** Self or `admin`/`superadmin` role.

**Returns:** `UserInfo`

**Errors:**

| Code | Condition |
|------|-----------|
| `UNAUTHORIZED` | Not authenticated. |
| `FORBIDDEN` | Not self and not admin/superadmin. |
| `NOT_FOUND` | User does not exist. |

---

### identity.deleteUser

```
{ id, type: "identity.deleteUser", userId: string }
```

Hard-deletes a user and all associated data (sessions, role assignments, ACL entries, ownership records). The virtual superadmin cannot be deleted.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | User ID. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ deleted: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin, or attempting to delete the virtual superadmin. |
| `NOT_FOUND` | User does not exist. |

---

### identity.listUsers

```
{ id, type: "identity.listUsers" }
```

Lists all users with offset-based pagination.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| page | `number` | no | Page number (1-based). Default: `1`. |
| pageSize | `number` | no | Items per page (1–200). Default: `50`. |

**Requires:** `admin` or `superadmin` role.

**Returns:**

```json
{
  "users": [ { "id": "...", "username": "...", ... } ],
  "total": 42,
  "page": 1,
  "pageSize": 50
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |

---

### identity.enableUser

```
{ id, type: "identity.enableUser", userId: string }
```

Enables a disabled user account.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | User ID. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `UserInfo`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `NOT_FOUND` | User does not exist. |

---

### identity.disableUser

```
{ id, type: "identity.disableUser", userId: string }
```

Disables a user account and invalidates all their sessions. The virtual superadmin cannot be disabled.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | User ID. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `UserInfo`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin, or attempting to disable the virtual superadmin. |
| `NOT_FOUND` | User does not exist. |

---

## Password Operations

### identity.changePassword

```
{ id, type: "identity.changePassword", userId: string, currentPassword: string, newPassword: string }
```

Changes the caller's own password. Verifies the current password, then sets the new one and invalidates all sessions (forces re-login).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | Must be the caller's own user ID. |
| currentPassword | `string` | yes | Current password for verification. |
| newPassword | `string` | yes | New password (minimum 8 characters). |

**Requires:** Authenticated. Must be own user ID.

**Returns:** `{ changed: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `UNAUTHORIZED` | Current password is incorrect. |
| `FORBIDDEN` | Attempting to change another user's password. |
| `VALIDATION_ERROR` | New password too short. |
| `NOT_FOUND` | User does not exist. |

---

### identity.resetPassword

```
{ id, type: "identity.resetPassword", userId: string, newPassword: string }
```

Admin operation — resets a user's password without knowing the current one. Invalidates all sessions for the target user.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | Target user ID. |
| newPassword | `string` | yes | New password (minimum 8 characters). |

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ reset: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `VALIDATION_ERROR` | New password too short. |
| `NOT_FOUND` | User does not exist. |

---

## Role Management Operations

### identity.createRole

```
{ id, type: "identity.createRole", name: string, ... }
```

Creates a custom role.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | `string` | yes | Unique role name (1–64 characters). |
| description | `string` | no | Human-readable description. |
| permissions | `RolePermission[]` | no | Permission rules for the role. Default: `[]`. |

**Requires:** `superadmin` role.

**Returns:** `RoleInfo`

```json
{
  "id": "generated-uuid",
  "name": "moderator",
  "description": "Can moderate content",
  "system": false,
  "permissions": [
    { "allow": ["store.update", "store.delete"], "buckets": ["posts", "comments"] }
  ],
  "_createdAt": 1700000000000,
  "_updatedAt": 1700000000000
}
```

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not superadmin. |
| `VALIDATION_ERROR` | Name empty or too long. |
| `ALREADY_EXISTS` | Role name already exists. |

---

### identity.updateRole

```
{ id, type: "identity.updateRole", roleId: string, ... }
```

Updates a role's description and/or permissions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| roleId | `string` | yes | Role ID. |
| description | `string` | no | New description. |
| permissions | `RolePermission[]` | no | New permission rules (replaces existing). |

**Requires:** `superadmin` role.

**Returns:** `RoleInfo`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not superadmin. |
| `NOT_FOUND` | Role does not exist. |

---

### identity.deleteRole

```
{ id, type: "identity.deleteRole", roleId: string }
```

Deletes a custom role and cascades — removes all user-role assignments referencing it. System roles cannot be deleted.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| roleId | `string` | yes | Role ID. |

**Requires:** `superadmin` role.

**Returns:** `{ deleted: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not superadmin, or attempting to delete a system role. |
| `NOT_FOUND` | Role does not exist. |

---

### identity.listRoles

```
{ id, type: "identity.listRoles" }
```

Lists all roles (system and custom).

**Parameters:** None.

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ roles: RoleInfo[] }`

---

### identity.assignRole

```
{ id, type: "identity.assignRole", userId: string, roleName: string }
```

Assigns a role to a user by role name.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | Target user ID. |
| roleName | `string` | yes | Role name to assign. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ assigned: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `NOT_FOUND` | User or role does not exist. |
| `ALREADY_EXISTS` | User already has this role. |

---

### identity.removeRole

```
{ id, type: "identity.removeRole", userId: string, roleName: string }
```

Removes a role from a user by role name.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | Target user ID. |
| roleName | `string` | yes | Role name to remove. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ removed: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `NOT_FOUND` | Role does not exist, or user does not have the role. |

---

### identity.getUserRoles

```
{ id, type: "identity.getUserRoles", userId: string }
```

Returns all roles assigned to a user.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| userId | `string` | yes | Target user ID. |

**Requires:** `admin` or `superadmin` role.

**Returns:** `{ roles: RoleInfo[] }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not admin/superadmin. |
| `NOT_FOUND` | User does not exist. |

---

## ACL & Ownership Operations

ACL provides fine-grained access control at the resource level. Each ACL entry grants specific operations (`read`, `write`, `admin`) to a subject (user or role) on a resource (bucket, topic, procedure, or query).

### ACL Operations

| Operation | Maps to |
|-----------|---------|
| `read` | Store reads, subscriptions, aggregations; Rules fact reads, subscriptions; Procedure reads |
| `write` | Store mutations, transactions; Rules emit, fact mutations; Procedure calls |
| `admin` | Bucket/query management; Rule management; Procedure management; Server stats; Audit queries |

### Resource Types

| Type | Description |
|------|-------------|
| `bucket` | Store bucket |
| `topic` | Rules topic |
| `procedure` | Registered procedure |
| `query` | Defined query |

---

### identity.grant

```
{ id, type: "identity.grant", subjectType, subjectId, resourceType, resourceName, operations }
```

Grants access to a subject on a resource. If an ACL entry already exists for the same subject + resource, the new operations are merged into it.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| subjectType | `'user' \| 'role'` | yes | Subject type. |
| subjectId | `string` | yes | User ID or role ID. |
| resourceType | `'bucket' \| 'topic' \| 'procedure' \| 'query'` | yes | Resource type. |
| resourceName | `string` | yes | Resource name. |
| operations | `string[]` | yes | Operations to grant: `'read'`, `'write'`, `'admin'`. |

**Requires:** Superadmin, admin, resource owner, or user with `admin` ACL on the resource.

**Returns:** `{ granted: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller lacks ACL management permission on this resource. |
| `NOT_FOUND` | Subject user or role does not exist. |
| `VALIDATION_ERROR` | Invalid operation value or empty operations array. |

**Example:**

```json
{
  "id": 1,
  "type": "identity.grant",
  "subjectType": "user",
  "subjectId": "user-123",
  "resourceType": "bucket",
  "resourceName": "orders",
  "operations": ["read", "write"]
}
```

---

### identity.revoke

```
{ id, type: "identity.revoke", subjectType, subjectId, resourceType, resourceName, operations? }
```

Revokes access from a subject on a resource. If `operations` is provided, only those operations are removed from the entry. If omitted, the entire ACL entry is deleted.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| subjectType | `'user' \| 'role'` | yes | Subject type. |
| subjectId | `string` | yes | User ID or role ID. |
| resourceType | `'bucket' \| 'topic' \| 'procedure' \| 'query'` | yes | Resource type. |
| resourceName | `string` | yes | Resource name. |
| operations | `string[]` | no | Specific operations to revoke. Omit to revoke all. |

**Requires:** Superadmin, admin, resource owner, or user with `admin` ACL on the resource.

**Returns:** `{ revoked: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller lacks ACL management permission on this resource. |
| `NOT_FOUND` | ACL entry does not exist. |

---

### identity.getAcl

```
{ id, type: "identity.getAcl", resourceType, resourceName }
```

Returns all ACL entries for a resource, enriched with subject names and ownership information.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| resourceType | `'bucket' \| 'topic' \| 'procedure' \| 'query'` | yes | Resource type. |
| resourceName | `string` | yes | Resource name. |

**Requires:** Authenticated.

**Returns:**

```json
{
  "entries": [
    {
      "subjectType": "user",
      "subjectId": "user-123",
      "subjectName": "alice",
      "operations": ["read", "write"],
      "isOwner": true
    },
    {
      "subjectType": "role",
      "subjectId": "role-456",
      "subjectName": "editors",
      "operations": ["read", "write"],
      "isOwner": false
    }
  ]
}
```

---

### identity.myAccess

```
{ id, type: "identity.myAccess" }
```

Returns the effective access for the current user — combines role permissions, ACL entries, and ownership into a single view.

**Parameters:** None.

**Requires:** Authenticated.

**Returns:**

```json
{
  "user": {
    "id": "user-123",
    "username": "alice",
    "roles": ["writer"]
  },
  "resources": [
    {
      "resourceType": "bucket",
      "resourceName": "orders",
      "operations": ["admin", "read", "write"],
      "isOwner": true
    }
  ]
}
```

---

### identity.getOwner

```
{ id, type: "identity.getOwner", resourceType, resourceName }
```

Returns the owner of a resource, or `null` if no owner is set.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| resourceType | `'bucket' \| 'topic' \| 'procedure' \| 'query'` | yes | Resource type. |
| resourceName | `string` | yes | Resource name. |

**Requires:** Authenticated.

**Returns (has owner):**

```json
{
  "owner": {
    "userId": "user-123",
    "username": "alice",
    "resourceType": "bucket",
    "resourceName": "orders"
  }
}
```

**Returns (no owner):** `{ owner: null }`

---

### identity.transferOwner

```
{ id, type: "identity.transferOwner", resourceType, resourceName, newOwnerId }
```

Transfers ownership of a resource to a different user.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| resourceType | `'bucket' \| 'topic' \| 'procedure' \| 'query'` | yes | Resource type. |
| resourceName | `string` | yes | Resource name. |
| newOwnerId | `string` | yes | User ID of the new owner. |

**Requires:** Current owner or `superadmin` role.

**Returns:** `{ transferred: true }`

**Errors:**

| Code | Condition |
|------|-----------|
| `FORBIDDEN` | Caller is not the current owner or superadmin. |
| `NOT_FOUND` | Resource has no owner, or new owner user does not exist. |

---

## Types

### LoginResult

```typescript
interface LoginResult {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName?: string;
    readonly roles: readonly string[];
  };
}
```

### UserInfo

```typescript
interface UserInfo {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}
```

### RoleInfo

```typescript
interface RoleInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly system: boolean;
  readonly permissions: readonly RolePermission[];
  readonly _createdAt: number;
  readonly _updatedAt: number;
}
```

### RolePermission

```typescript
interface RolePermission {
  readonly allow: string | readonly string[];
  readonly buckets?: readonly string[];
  readonly topics?: readonly string[];
}
```

### AclEntry

```typescript
interface AclEntry {
  readonly subjectType: 'user' | 'role';
  readonly subjectId: string;
  readonly subjectName: string;
  readonly operations: readonly string[];
  readonly isOwner: boolean;
}
```

### OwnerInfo

```typescript
interface OwnerInfo {
  readonly userId: string;
  readonly username: string;
  readonly resourceType: 'bucket' | 'topic' | 'procedure' | 'query';
  readonly resourceName: string;
}
```

### EffectiveAccessResult

```typescript
interface EffectiveAccessResult {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly roles: readonly string[];
  };
  readonly resources: ReadonlyArray<{
    readonly resourceType: 'bucket' | 'topic' | 'procedure' | 'query';
    readonly resourceName: string;
    readonly operations: readonly string[];
    readonly isOwner: boolean;
  }>;
}
```

### ListUsersResult

```typescript
interface ListUsersResult {
  readonly users: readonly UserInfo[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
```

---

## Known Limitations

- **Sessions are in-memory.** Stored in the `_sessions` system bucket (noex-store). Server restart clears all sessions — all users must re-login.
- **No external session store hook.** There is no built-in mechanism to persist sessions to Redis or another external store.
- **Password hashing is synchronous on the event loop.** Uses `scrypt` via Node.js `crypto` — individual hash calls are fast but blocking.
- **Login rate limiting is in-memory.** Rate limit counters are not shared across server instances. In a multi-instance setup, each instance tracks its own counters.

---

## See Also

- [Configuration — BuiltInAuthConfig](./02-configuration.md#builtinauthconfig) — Configuration interface and defaults
- [Authentication](./07-authentication.md) — Custom auth with `validate` function (alternative to built-in)
- [Audit](./11-audit.md) — All identity operations belong to the `admin` audit tier
- [Errors](./10-errors.md) — Error codes reference
