# Part 8: Authentication

Secure your server with token-based authentication, per-operation permissions, and session management.

## Chapters

### [8.1 Token Authentication](./01-token-auth.md)

Set up authentication:
- `AuthConfig` with `validate` function
- `auth.login` flow — token to session
- `required: true` — blocking unauthenticated requests

### [8.2 Permissions](./02-permissions.md)

Control what each user can do:
- `PermissionConfig.check(session, operation, resource)`
- Role-based access patterns
- `FORBIDDEN` error code when denied

### [8.3 Session Lifecycle](./03-session-lifecycle.md)

Manage sessions over time:
- `auth.whoami` — inspect current session
- `auth.logout` — end session
- Token expiration and re-authentication

### [8.4 Audit Logging](./04-audit-logging.md)

Track operations on the server:
- `AuditConfig` with tiers (`admin`, `write`, `read`)
- `audit.query` — query the audit log
- `onEntry` callback for durable persistence

## What You'll Learn

By the end of this section, you'll be able to:
- Add token-based authentication to the server
- Implement role-based permission checks
- Manage session lifecycle including expiration and logout
- Enable and query audit logging for security and compliance

---

Start with: [Token Authentication](./01-token-auth.md)
