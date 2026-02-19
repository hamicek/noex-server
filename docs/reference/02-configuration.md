# Configuration

All configuration interfaces and their default values for `NoexServer`.

## Import

```typescript
import type {
  ServerConfig,
  AuthConfig,
  BuiltInAuthConfig,
  AuthSession,
  PermissionConfig,
  PermissionRule,
  AuditConfig,
  AuditEntry,
  AuditQuery,
  RevocationConfig,
  ProceduresConfig,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
  ConnectionLimitsConfig,
} from '@hamicek/noex-server';
```

---

## ServerConfig

The main configuration object passed to `NoexServer.start()`.

```typescript
interface ServerConfig {
  readonly store: Store;
  readonly rules?: RuleEngine;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  readonly auth?: AuthConfig | BuiltInAuthConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly heartbeat?: HeartbeatConfig;
  readonly backpressure?: BackpressureConfig;
  readonly connectionLimits?: Partial<ConnectionLimitsConfig>;
  readonly audit?: AuditConfig;
  readonly revocation?: RevocationConfig;
  readonly procedures?: ProceduresConfig;
  readonly name?: string;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| store | `Store` | *required* | Instance of `@hamicek/noex-store`. |
| rules | `RuleEngine` | — | Instance of `@hamicek/noex-rules` (optional peer dependency). |
| port | `number` | `8080` | WebSocket server port. |
| host | `string` | `'0.0.0.0'` | WebSocket server host. |
| path | `string` | `'/'` | WebSocket endpoint path. |
| maxPayloadBytes | `number` | `1_048_576` (1 MB) | Maximum incoming message size in bytes. |
| auth | `AuthConfig \| BuiltInAuthConfig` | — | Authentication configuration. When omitted, auth is disabled. |
| rateLimit | `RateLimitConfig` | — | Rate limiting configuration. When omitted, rate limiting is disabled. |
| heartbeat | `HeartbeatConfig` | `{ intervalMs: 30_000, timeoutMs: 10_000 }` | Heartbeat ping/pong configuration. |
| backpressure | `BackpressureConfig` | `{ maxBufferedBytes: 1_048_576, highWaterMark: 0.8 }` | Write buffer backpressure configuration. |
| connectionLimits | `Partial<ConnectionLimitsConfig>` | `{ maxSubscriptionsPerConnection: 100 }` | Per-connection limits. |
| audit | `AuditConfig` | — | Audit log configuration. When omitted, audit logging is disabled. |
| revocation | `RevocationConfig` | — | Session revocation configuration. Requires auth to be configured. |
| procedures | `ProceduresConfig` | — | Procedures engine configuration. When omitted, procedures are disabled. |
| name | `string` | `'noex-server'` | Server name used for registry and logging. |

**Example:**

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = await Store.start();

const server = await NoexServer.start({
  store,
  port: 3000,
  host: '127.0.0.1',
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000 },
});
```

---

## AuthConfig

Configures token-based authentication.

```typescript
interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| validate | `(token: string) => Promise<AuthSession \| null>` | *required* | Validates a token and returns a session, or `null` if invalid. |
| required | `boolean` | `true` | Whether authentication is required. When `false`, unauthenticated clients can use all operations. |
| permissions | `PermissionConfig` | — | Permission check callback. When omitted, all authenticated users have full access. |

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      const user = await verifyJWT(token);
      if (!user) return null;
      return {
        userId: user.id,
        roles: user.roles,
        expiresAt: user.exp * 1000,
      };
    },
    permissions: {
      default: 'deny',
      rules: [
        { role: 'admin', allow: '*' },
        { role: 'user', allow: ['store.get', 'store.where', 'store.subscribe'] },
      ],
    },
  },
});
```

---

## BuiltInAuthConfig

Activates the built-in identity management system. This replaces `AuthConfig` — when `builtIn: true` is set, the server manages users, roles, sessions, and ACL internally using the store.

```typescript
interface BuiltInAuthConfig {
  readonly builtIn: true;
  readonly adminSecret: string;
  readonly sessionTtl?: number;
  readonly passwordMinLength?: number;
  readonly maxSessionsPerUser?: number;
  readonly loginRateLimit?: {
    readonly maxAttempts?: number;
    readonly windowMs?: number;
  };
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| builtIn | `true` | *required* | Discriminant that activates built-in identity management. |
| adminSecret | `string` | *required* | Secret for bootstrap login via `identity.loginWithSecret`. |
| sessionTtl | `number` | `86_400_000` (24 h) | Session TTL in milliseconds. |
| passwordMinLength | `number` | `8` | Minimum password length for user creation and password changes. |
| maxSessionsPerUser | `number` | `10` | Maximum concurrent sessions per user. Oldest session is evicted when exceeded. |
| loginRateLimit.maxAttempts | `number` | `5` | Maximum failed login attempts before lockout. |
| loginRateLimit.windowMs | `number` | `900_000` (15 min) | Time window for login rate limiting. |

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    builtIn: true,
    adminSecret: process.env.ADMIN_SECRET!,
    sessionTtl: 4 * 60 * 60 * 1000, // 4 hours
    passwordMinLength: 12,
    maxSessionsPerUser: 5,
    loginRateLimit: { maxAttempts: 3, windowMs: 10 * 60 * 1000 },
  },
});
```

---

## AuthSession

Returned by the `validate` callback. Represents an authenticated user session.

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
| userId | `string` | yes | Unique user identifier. |
| roles | `readonly string[]` | yes | User roles for permission checks. |
| metadata | `Record<string, unknown>` | no | Arbitrary metadata attached to the session. |
| expiresAt | `number` | no | Unix timestamp (ms) when the session expires. Expired sessions are rejected automatically. |

---

## PermissionConfig

Configures per-operation permission checks. Supports both declarative rules and a custom check function. When both are provided, the `check` function is called first — if it returns `undefined`, the declarative rules are evaluated.

```typescript
interface PermissionConfig {
  readonly default?: 'allow' | 'deny';
  readonly rules?: readonly PermissionRule[];
  readonly check?: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean | undefined;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| default | `'allow' \| 'deny'` | `'allow'` | Default behavior when no rule matches. |
| rules | `readonly PermissionRule[]` | — | Declarative permission rules, evaluated in order. First match wins. |
| check | `(session, operation, resource) => boolean \| undefined` | — | Custom check function. Return `true` to allow, `false` to deny, `undefined` to fall through to declarative rules. |

**Example — declarative rules:**

```typescript
permissions: {
  default: 'deny',
  rules: [
    { role: 'admin', allow: '*' },
    { role: 'writer', allow: ['store.*'], buckets: ['posts', 'comments'] },
    { role: 'reader', allow: ['store.get', 'store.where', 'store.subscribe'] },
  ],
}
```

**Example — custom check with fallthrough:**

```typescript
permissions: {
  default: 'deny',
  rules: [
    { role: 'user', allow: ['store.get', 'store.where'] },
  ],
  check: (session, operation, resource) => {
    // Admins always pass
    if (session.roles.includes('admin')) return true;
    // Fall through to declarative rules for everyone else
    return undefined;
  },
}
```

---

## PermissionRule

A single declarative permission rule evaluated by `PermissionConfig.rules`.

```typescript
interface PermissionRule {
  readonly role: string;
  readonly allow: string | readonly string[];
  readonly buckets?: readonly string[];
  readonly topics?: readonly string[];
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| role | `string` | yes | Role this rule applies to. The user's `roles` array is checked for a match. |
| allow | `string \| readonly string[]` | yes | Allowed operations — exact name, wildcard pattern (`'store.*'`, `'*'`), or array of patterns. |
| buckets | `readonly string[]` | no | Restrict to specific store buckets (only checked for `store.*` operations). |
| topics | `readonly string[]` | no | Restrict to specific rules topics (only checked for `rules.*` operations). |

Rules are evaluated in order. The first rule whose `role` matches one of the session's roles and whose `allow` pattern matches the operation (and optional `buckets`/`topics` constraint) wins. If no rule matches, `PermissionConfig.default` applies.

---

## AuditConfig

Configures the in-memory audit log. When provided, operations matching the configured tiers are recorded.

```typescript
interface AuditConfig {
  readonly tiers?: readonly OperationTier[];
  readonly maxEntries?: number;
  readonly onEntry?: (entry: AuditEntry) => void;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| tiers | `readonly OperationTier[]` | `['admin']` | Which operation tiers to log. Valid values: `'admin'`, `'write'`, `'read'`. |
| maxEntries | `number` | `10_000` | Maximum entries kept in the in-memory ring buffer. Oldest entries are overwritten. |
| onEntry | `(entry: AuditEntry) => void` | — | Callback invoked for every audit entry. Use for external persistence. |

**Example — log all mutations to a JSONL file:**

```typescript
import { createWriteStream } from 'node:fs';

const auditStream = createWriteStream('audit.jsonl', { flags: 'a' });

const server = await NoexServer.start({
  store,
  auth: { builtIn: true, adminSecret: process.env.ADMIN_SECRET! },
  audit: {
    tiers: ['admin', 'write'],
    maxEntries: 50_000,
    onEntry: (entry) => {
      auditStream.write(JSON.stringify(entry) + '\n');
    },
  },
});
```

---

## AuditEntry

A single audit log entry. Passed to `AuditConfig.onEntry` and returned by `audit.query`.

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

---

## AuditQuery

Filter object for the `audit.query` operation.

```typescript
interface AuditQuery {
  readonly userId?: string;
  readonly operation?: string;
  readonly result?: 'success' | 'error';
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| userId | `string` | Filter by user ID. |
| operation | `string` | Filter by operation type. |
| result | `'success' \| 'error'` | Filter by result. |
| from | `number` | Start timestamp (ms, inclusive). |
| to | `number` | End timestamp (ms, inclusive). |
| limit | `number` | Maximum number of entries to return. |

---

## RevocationConfig

Configures the in-memory session revocation blacklist.

```typescript
interface RevocationConfig {
  readonly blacklistTtlMs?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| blacklistTtlMs | `number` | `3_600_000` (1 h) | How long a revoked user ID remains blocked from re-authenticating. |

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  auth: { builtIn: true, adminSecret: process.env.ADMIN_SECRET! },
  revocation: { blacklistTtlMs: 24 * 60 * 60 * 1000 }, // 24 hours
});
```

---

## ProceduresConfig

Configures the server-side procedures engine.

```typescript
interface ProceduresConfig {
  readonly maxSteps?: number;
  readonly maxConditionDepth?: number;
  readonly defaultTimeoutMs?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSteps | `number` | `100` | Maximum number of steps a single procedure can execute. |
| maxConditionDepth | `number` | `5` | Maximum nesting depth for `if` condition steps. |
| defaultTimeoutMs | `number` | `30_000` (30 s) | Default timeout for procedure execution. |

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  procedures: {
    maxSteps: 200,
    maxConditionDepth: 10,
    defaultTimeoutMs: 60_000,
  },
});
```

---

## RateLimitConfig

Configures request rate limiting using a sliding window.

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| maxRequests | `number` | Maximum requests allowed within the window. |
| windowMs | `number` | Window duration in milliseconds. |

Rate limiting is keyed by `userId` (if authenticated) or by remote IP address.

**Example:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: { maxRequests: 100, windowMs: 60_000 }, // 100 req/min
});
```

---

## HeartbeatConfig

Configures the server-initiated heartbeat mechanism.

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| intervalMs | `number` | `30_000` | Interval between ping messages (ms). |
| timeoutMs | `number` | `10_000` | Maximum time to wait for a pong response (ms). If exceeded, the connection is closed with code `4001`. |

---

## BackpressureConfig

Configures write buffer backpressure detection.

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxBufferedBytes | `number` | `1_048_576` (1 MB) | Maximum write buffer size in bytes. |
| highWaterMark | `number` | `0.8` | Fraction of `maxBufferedBytes` at which push messages are dropped (0–1). |

When the WebSocket write buffer exceeds `maxBufferedBytes * highWaterMark`, push messages (subscription updates) are dropped. The client will receive the correct state on the next subscription update.

---

## ConnectionLimitsConfig

Per-connection limits.

```typescript
interface ConnectionLimitsConfig {
  readonly maxSubscriptionsPerConnection: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxSubscriptionsPerConnection | `number` | `100` | Maximum number of active subscriptions (store + rules) per single connection. Exceeding this limit returns a `RATE_LIMITED` error. |

---

## Default Values Summary

| Constant | Value |
|----------|-------|
| `DEFAULT_PORT` | `8080` |
| `DEFAULT_HOST` | `'0.0.0.0'` |
| `DEFAULT_PATH` | `'/'` |
| `DEFAULT_MAX_PAYLOAD_BYTES` | `1_048_576` (1 MB) |
| `DEFAULT_NAME` | `'noex-server'` |
| `DEFAULT_HEARTBEAT.intervalMs` | `30_000` (30 s) |
| `DEFAULT_HEARTBEAT.timeoutMs` | `10_000` (10 s) |
| `DEFAULT_BACKPRESSURE.maxBufferedBytes` | `1_048_576` (1 MB) |
| `DEFAULT_BACKPRESSURE.highWaterMark` | `0.8` |
| `DEFAULT_CONNECTION_LIMITS.maxSubscriptionsPerConnection` | `100` |
| `DEFAULT_AUDIT_TIERS` | `['admin']` |
| `DEFAULT_AUDIT_MAX_ENTRIES` | `10_000` |
| `DEFAULT_BLACKLIST_TTL_MS` | `3_600_000` (1 h) |
| `DEFAULT_MAX_STEPS` | `100` |
| `DEFAULT_MAX_CONDITION_DEPTH` | `5` |
| `DEFAULT_TIMEOUT_MS` | `30_000` (30 s) |
| `DEFAULT_SESSION_TTL` | `86_400_000` (24 h) |
| `DEFAULT_PASSWORD_MIN_LENGTH` | `8` |
| `DEFAULT_MAX_SESSIONS_PER_USER` | `10` |
| `DEFAULT_LOGIN_RATE_LIMIT.maxAttempts` | `5` |
| `DEFAULT_LOGIN_RATE_LIMIT.windowMs` | `900_000` (15 min) |

---

## See Also

- [NoexServer](./01-noex-server.md) — Server class
- [Authentication](./07-authentication.md) — Auth operations and session lifecycle
- [Lifecycle](./08-lifecycle.md) — Heartbeat, backpressure, connection limits
- [Audit](./11-audit.md) — Audit log operations
- [Built-in Identity](./12-built-in-auth.md) — Built-in identity management operations
- [Errors](./10-errors.md) — Error codes
