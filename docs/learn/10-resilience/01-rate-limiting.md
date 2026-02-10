# Rate Limiting

Protect the server from excessive requests with a sliding window rate limiter. Rate limiting is per-IP for unauthenticated clients and per-userId for authenticated clients.

## What You'll Learn

- `RateLimitConfig` — `maxRequests` and `windowMs`
- The `RATE_LIMITED` error response with `retryAfterMs`
- Rate limit key: IP address vs userId
- How the key switches from IP to userId after login
- Subscription limits via `connectionLimits`
- Disabling rate limiting (the default)

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'ratelimit-demo' });

store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({
  store,
  port: 8080,
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000, // 1 minute
  },
});
```

## RateLimitConfig

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;  // Max requests per window
  readonly windowMs: number;     // Sliding window duration in ms
}
```

- **`maxRequests`** — maximum number of requests allowed within the window
- **`windowMs`** — the length of the sliding window in milliseconds

When omitted from `ServerConfig`, rate limiting is disabled entirely — there is no default limit.

## How It Works

The rate limiter uses a **sliding window** algorithm. Each request consumes one token from the window. When all tokens are consumed, subsequent requests are rejected until the window slides enough to free up capacity.

```
Window: 60 seconds, Max: 5 requests

Time ──▶
│ req1  req2  req3  req4  req5 │ req6 ✗ (RATE_LIMITED)
│◄──────── 60s window ────────►│
                                  │ req1 expires → req6 ✓
```

## RATE_LIMITED Error

When a client exceeds the limit, the server responds with:

```jsonc
→ { "id": 6, "type": "store.all", "bucket": "items" }

← { "id": 6, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 42000ms",
    "details": { "retryAfterMs": 42000 } }
```

- **`code`** — always `"RATE_LIMITED"`
- **`details.retryAfterMs`** — milliseconds until at least one token becomes available

Clients should use `retryAfterMs` to implement backoff rather than retrying immediately.

## Rate Limit Key

The rate limiter tracks usage per-key:

| State | Key | Scope |
|-------|-----|-------|
| Unauthenticated | IP address (e.g. `"192.168.1.10"`) | Shared across all connections from the same IP |
| Authenticated | `userId` (e.g. `"alice"`) | Independent bucket per user |

### Key Switch After Login

Before `auth.login`, requests are tracked by IP. After login, the key switches to `userId`:

```jsonc
// Before login: rate limited by IP (127.0.0.1)
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// After login: rate limited by userId ("alice") — fresh bucket
→ { "id": 2, "type": "store.all", "bucket": "items" }
← { "id": 2, "type": "result", "data": [] }
```

This means `auth.login` itself is rate-limited by IP — protecting against brute-force login attempts.

### IP Sharing

Multiple unauthenticated connections from the same IP share the same rate limit bucket:

```
Connection A (127.0.0.1): store.all  →  bucket "127.0.0.1" (1/5)
Connection B (127.0.0.1): store.all  →  bucket "127.0.0.1" (2/5)
Connection A (127.0.0.1): store.all  →  bucket "127.0.0.1" (3/5)
```

After login, each user gets an independent bucket:

```
Connection A (alice): store.all  →  bucket "alice" (1/5)
Connection B (bob):   store.all  →  bucket "bob"   (1/5)
```

## All Operations Are Rate-Limited

Rate limiting applies uniformly to all operation types — `store.*`, `rules.*`, `auth.*`, and `server.*`:

```jsonc
// These all consume from the same bucket:
→ { "id": 1, "type": "store.insert", "bucket": "items", "data": { "name": "a" } }
→ { "id": 2, "type": "store.all", "bucket": "items" }
→ { "id": 3, "type": "store.count", "bucket": "items" }
// All 3 consumed, 2 left in a maxRequests: 5 window
```

## Window Reset

After the sliding window passes, tokens are freed and requests are allowed again:

```jsonc
// Limit: 2 requests per 200 ms

→ { "id": 1, "type": "store.all", "bucket": "items" }  // ✓ (1/2)
← { "id": 1, "type": "result", "data": [] }

→ { "id": 2, "type": "store.all", "bucket": "items" }  // ✓ (2/2)
← { "id": 2, "type": "result", "data": [] }

→ { "id": 3, "type": "store.all", "bucket": "items" }  // ✗ RATE_LIMITED
← { "id": 3, "type": "error", "code": "RATE_LIMITED", ... }

// ... wait for window to expire ...

→ { "id": 4, "type": "store.all", "bucket": "items" }  // ✓ (1/2)
← { "id": 4, "type": "result", "data": [] }
```

## Subscription Limits

Separately from request rate limiting, you can limit the number of active subscriptions per connection:

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50, // Default: 100
  },
});
```

When a client tries to subscribe beyond the limit:

```jsonc
→ { "id": 101, "type": "store.subscribe", "query": "some-query" }

← { "id": 101, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 50 per connection)" }
```

The subscription limit counts both store and rules subscriptions combined.

## No Rate Limiting (Default)

When `rateLimit` is not specified in the config, there is no limit — all requests are allowed:

```typescript
// No rate limiting
const server = await NoexServer.start({ store, port: 8080 });
```

You can check whether rate limiting is enabled via stats:

```jsonc
→ { "id": 1, "type": "server.stats" }
← { "id": 1, "type": "result",
    "data": { "rateLimitEnabled": false, ... } }
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `RATE_LIMITED` | Request rate limit exceeded (includes `retryAfterMs` in details) |
| `RATE_LIMITED` | Subscription limit reached (max N per connection) |

## Working Example

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  rateLimit: {
    maxRequests: 100,   // 100 requests
    windowMs: 60_000,   // per minute
  },
  connectionLimits: {
    maxSubscriptionsPerConnection: 50,
  },
  auth: {
    validate: async (token) => {
      if (token === 'alice') return { userId: 'alice', roles: ['admin'] };
      return null;
    },
  },
});

// Before login: rate limited by IP
// → { "id": 1, "type": "auth.login", "token": "alice" }
// ← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// After login: rate limited by userId "alice"
// → { "id": 2, "type": "store.all", "bucket": "items" }
// ← { "id": 2, "type": "result", "data": [] }

// If limit exceeded:
// ← { "id": N, "type": "error",
//     "code": "RATE_LIMITED",
//     "message": "Rate limit exceeded. Retry after 42000ms",
//     "details": { "retryAfterMs": 42000 } }
```

## Exercise

Set up a server with a rate limit of 3 requests per minute and auth enabled. Show:
1. A client logs in (consuming 1 request from the IP bucket)
2. After login, the userId bucket is fresh — 3 more requests allowed
3. The 4th post-login request gets rate-limited
4. Verify `retryAfterMs` is present in the error details

<details>
<summary>Solution</summary>

```jsonc
// Rate limit: 3 requests / 60s window, auth enabled

// 1. Login (consumes from IP "127.0.0.1" bucket: 1/3)
→ { "id": 1, "type": "auth.login", "token": "alice" }
← { "id": 1, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"] } }

// 2. After login, bucket switches to "alice" — fresh 3/3
→ { "id": 2, "type": "store.all", "bucket": "items" }
← { "id": 2, "type": "result", "data": [] }

→ { "id": 3, "type": "store.insert", "bucket": "items",
    "data": { "name": "first" } }
← { "id": 3, "type": "result", "data": { "id": "...", "name": "first" } }

→ { "id": 4, "type": "store.count", "bucket": "items" }
← { "id": 4, "type": "result", "data": 1 }

// 3. 4th request — userId bucket exhausted (3/3)
→ { "id": 5, "type": "store.all", "bucket": "items" }
← { "id": 5, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 59234ms",
    "details": { "retryAfterMs": 59234 } }

// 4. retryAfterMs tells the client when to retry
//    (approximately windowMs minus elapsed time)
```

</details>

## Summary

- Configure rate limiting with `rateLimit: { maxRequests, windowMs }` — disabled by default
- Sliding window algorithm: requests are rejected with `RATE_LIMITED` when the limit is exceeded
- Error includes `details.retryAfterMs` — clients should wait before retrying
- Rate limit key: IP address for unauthenticated, userId for authenticated
- The key switches from IP to userId after `auth.login` — fresh bucket per user
- `auth.login` is rate-limited by IP — protects against brute-force attempts
- Subscription limits (`connectionLimits.maxSubscriptionsPerConnection`) cap total subscriptions per connection (default: 100)
- All operation types are rate-limited uniformly

---

Next: [Heartbeat](./02-heartbeat.md)
