# Production Deployment

Take your noex-server from development to production. This guide covers TLS termination, durable audit logging, session persistence strategies, monitoring, and graceful shutdown — everything you need for a reliable deployment.

## What You'll Learn

- Terminating TLS at a reverse proxy for secure `wss://` connections
- Persisting audit log entries to durable storage
- Handling in-memory session limitations across restarts
- Monitoring server health with `server.getStats()`
- Configuring graceful shutdown for zero-downtime deployments

## Architecture Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                     Production Environment                           │
│                                                                      │
│  Client (wss://)         Reverse Proxy             noex-server       │
│  ┌──────────┐           ┌──────────────┐          ┌──────────────┐  │
│  │ Browser  │──wss://──▶│    nginx     │──ws://──▶│  port 8080   │  │
│  │ Node.js  │           │  TLS @ 443   │          │  plain ws    │  │
│  │ noex-cli │           │  proxy_pass  │          │              │  │
│  └──────────┘           └──────────────┘          └──────┬───────┘  │
│                                                          │          │
│                           Persistence                    │          │
│                          ┌──────────────┐                │          │
│                          │ audit.jsonl  │◀── onEntry ────┘          │
│                          │ database     │                           │
│                          └──────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘
```

## TLS via Reverse Proxy

The server listens on plain `ws://`. Never expose it directly to the internet. Terminate TLS at a reverse proxy and forward traffic to the server.

### nginx Configuration

```nginx
upstream noex {
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/ssl/certs/api.example.com.pem;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    location / {
        proxy_pass http://noex;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Key points:

- `proxy_http_version 1.1` and the `Upgrade` / `Connection` headers are required for WebSocket proxying
- `X-Real-IP` forwards the client IP — the server records it in audit entries via `remoteAddress`
- The server itself requires no configuration change — it sees plain `ws://` traffic from the proxy

### Caddy Alternative

Caddy handles TLS automatically with Let's Encrypt:

```
api.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy natively supports WebSocket proxying — no additional headers needed.

### Client Connection

Clients connect via `wss://` — no client-side configuration beyond the URL scheme:

```typescript
import { NoexClient } from '@hamicek/noex-client';

const client = new NoexClient('wss://api.example.com');
await client.connect();
```

## Audit Log Persistence

The built-in audit log uses an in-memory ring buffer (default: 10,000 entries). When the buffer fills, oldest entries are silently overwritten. For production, persist entries to durable storage using the `onEntry` callback.

### File Persistence (JSONL)

```typescript
import fs from 'node:fs';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'production' });

const auditStream = fs.createWriteStream('audit.jsonl', { flags: 'a' });

const server = await NoexServer.start({
  store,
  audit: {
    tiers: ['admin', 'write'],
    maxEntries: 10_000,
    onEntry: (entry) => {
      auditStream.write(JSON.stringify(entry) + '\n');
    },
  },
});
```

Each line in `audit.jsonl` is a self-contained JSON object:

```json
{"timestamp":1706745600000,"userId":"alice","sessionId":"sess-1","operation":"store.insert","resource":"orders","result":"success","remoteAddress":"192.168.1.10"}
{"timestamp":1706745601000,"userId":null,"sessionId":null,"operation":"auth.login","resource":"","result":"error","error":"Invalid token","remoteAddress":"10.0.0.5"}
```

### Database Persistence

For structured querying, write entries to a database:

```typescript
import { NoexServer } from '@hamicek/noex-server';
import type { AuditEntry } from '@hamicek/noex-server';

const server = await NoexServer.start({
  store,
  audit: {
    tiers: ['admin', 'write', 'read'],
    onEntry: (entry: AuditEntry) => {
      // Insert into your database asynchronously.
      // onEntry is fire-and-forget — errors here do not affect the server.
      db.query(
        `INSERT INTO audit_log (timestamp, user_id, operation, resource, result, error, remote_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.timestamp, entry.userId, entry.operation, entry.resource,
         entry.result, entry.error ?? null, entry.remoteAddress],
      ).catch((err) => console.error('Audit write failed:', err));
    },
  },
});
```

### Tier Selection

Choose which operations to audit based on your needs:

| Tier | Operations | Use Case |
|------|-----------|----------|
| `admin` | Auth operations, identity management, audit queries | Always — security-critical |
| `write` | `store.insert`, `store.update`, `store.delete`, `store.transaction`, `rules.emit`, `rules.setFact` | Recommended — tracks data mutations |
| `read` | `store.get`, `store.all`, `store.query`, `store.subscribe`, `rules.subscribe` | High-volume — enable only when needed |

Default: `['admin']`. A typical production setting is `['admin', 'write']`.

## Session Persistence

### The Problem

The built-in identity system stores sessions in the `_sessions` bucket inside noex-store — entirely in-memory. A server restart clears all sessions, logging out every user. Custom auth (`AuthConfig.validate`) has the same limitation: session state is per-connection and lost on disconnect.

### Strategies

**1. Accept the limitation.** For internal tools and low-traffic applications, requiring re-login after a restart is acceptable. Keep session TTL short (e.g., 1 hour) so users are accustomed to re-authenticating.

**2. Use stateless tokens (JWTs).** Instead of the built-in identity system, use custom auth with JWTs:

```typescript
import jwt from 'jsonwebtoken';
import type { AuthConfig, AuthSession } from '@hamicek/noex-server';

const auth: AuthConfig = {
  validate: async (token: string): Promise<AuthSession | null> => {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
        sub: string;
        roles: string[];
        exp: number;
      };
      return {
        userId: payload.sub,
        roles: payload.roles,
        expiresAt: payload.exp * 1000,
      };
    } catch {
      return null;
    }
  },
  permissions: {
    default: 'deny',
    rules: [
      { role: 'admin', allow: '*' },
      { role: 'user', allow: ['store.get', 'store.all', 'store.query', 'store.subscribe'] },
    ],
  },
};
```

The server becomes stateless — restarts are transparent to clients. Tokens are verified on every request without server-side session storage.

**3. External session management.** Place an API gateway or auth proxy (e.g., OAuth2 Proxy, Keycloak) in front of the server. The gateway manages sessions and passes a validated identity header to noex-server.

## Monitoring

### Server Stats

Call `server.getStats()` periodically to monitor health:

```typescript
const stats = await server.getStats();
// {
//   name: 'production',
//   port: 8080,
//   host: '0.0.0.0',
//   connectionCount: 42,
//   uptimeMs: 86400000,
//   authEnabled: true,
//   rateLimitEnabled: true,
//   rulesEnabled: true,
//   connections: {
//     active: 42,
//     authenticated: 40,
//     totalStoreSubscriptions: 85,
//     totalRulesSubscriptions: 12,
//   },
//   store: { ... },
//   rules: { ... },
// }
```

### Health Check Endpoint

Expose a simple HTTP health check alongside the server (useful for load balancers and container orchestrators):

```typescript
import http from 'node:http';

const healthServer = http.createServer(async (_req, res) => {
  const stats = await server.getStats();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: stats.uptimeMs,
    connections: stats.connections.active,
  }));
});

healthServer.listen(9090, '127.0.0.1');
```

### Key Metrics to Watch

| Metric | Source | Warning Sign |
|--------|--------|-------------|
| Active connections | `connections.active` | Sudden drop (network issue) or spike (attack) |
| Unauthenticated ratio | `active - authenticated` | High ratio may indicate auth failures |
| Store subscriptions | `connections.totalStoreSubscriptions` | Growing unboundedly (subscription leak) |
| Rules subscriptions | `connections.totalRulesSubscriptions` | Same as above |
| Uptime | `uptimeMs` | Unexpected resets (crash loops) |

## Production Configuration

A complete production `ServerConfig`:

```typescript
import fs from 'node:fs';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';
import type { BuiltInAuthConfig } from '@hamicek/noex-server';

const store = await Store.start({ name: 'production' });
const engine = await RuleEngine.start({ name: 'production-rules' });

const auditStream = fs.createWriteStream('audit.jsonl', { flags: 'a' });

const auth: BuiltInAuthConfig = {
  builtIn: true,
  adminSecret: process.env.ADMIN_SECRET!,
  sessionTtl: 3_600_000,       // 1 hour
  passwordMinLength: 12,
  maxSessionsPerUser: 5,
  loginRateLimit: {
    maxAttempts: 5,
    windowMs: 900_000,          // 15 minutes
  },
};

const server = await NoexServer.start({
  store,
  rules: engine,
  port: 8080,
  host: '0.0.0.0',
  maxPayloadBytes: 1_048_576,
  auth,

  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,             // 100 req/min
  },

  heartbeat: {
    intervalMs: 30_000,
    timeoutMs: 10_000,
  },

  backpressure: {
    maxBufferedBytes: 1_048_576,  // 1 MB
    highWaterMark: 0.8,
  },

  connectionLimits: {
    maxSubscriptionsPerConnection: 50,
  },

  audit: {
    tiers: ['admin', 'write'],
    maxEntries: 10_000,
    onEntry: (entry) => {
      auditStream.write(JSON.stringify(entry) + '\n');
    },
  },
});

console.log(`Server listening on ws://0.0.0.0:${server.port}`);
```

## Graceful Shutdown

Stop the server without dropping active operations:

```typescript
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await server.stop({ gracePeriodMs: 5000 });
  auditStream.end();
  process.exit(0);
});
```

The shutdown sequence:

1. **Stop accepting new connections** — the HTTP server closes
2. **Notify clients** — sends `{ type: "system", event: "shutdown", gracePeriodMs: 5000 }` to all connected clients
3. **Wait** — up to 5 seconds for clients to disconnect gracefully
4. **Force close** — remaining connections are terminated and all subscriptions cleaned up

## Deployment Checklist

- [ ] TLS terminated at reverse proxy (nginx, Caddy, or cloud load balancer)
- [ ] `adminSecret` loaded from environment variable, not hardcoded
- [ ] Audit `onEntry` writes to durable storage (file or database)
- [ ] Rate limiting enabled (`rateLimit` configured)
- [ ] `SIGTERM` handler calls `server.stop()` with a grace period
- [ ] Health check endpoint accessible to orchestrator
- [ ] `maxPayloadBytes` set to a reasonable limit for your use case
- [ ] Subscription limit per connection set (`connectionLimits.maxSubscriptionsPerConnection`)

## Summary

- **TLS**: Terminate at a reverse proxy — the server runs plain `ws://` behind it
- **Audit persistence**: Use `onEntry` to write entries to JSONL files or a database — the in-memory ring buffer is not durable
- **Sessions**: Built-in sessions are in-memory — use JWTs for stateless auth or accept re-login on restart
- **Monitoring**: `server.getStats()` provides connection counts, subscription totals, and feature flags — expose via a health endpoint
- **Shutdown**: `server.stop({ gracePeriodMs })` notifies clients and waits before force-closing
- **Resilience**: Rate limiting, heartbeat, and backpressure protect against abuse, stale connections, and slow consumers

---

Previous: [E-Commerce Backend](./03-ecommerce-backend.md)
