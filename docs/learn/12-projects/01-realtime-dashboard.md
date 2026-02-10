# Real-time Dashboard

Build a live metrics dashboard where administrators push metrics through the server and viewers see updates instantly via reactive subscriptions. This project combines Store CRUD, reactive queries, authentication, and role-based permissions.

## What You'll Learn

- Designing a metrics bucket schema for time-series-like data
- Reactive queries for live dashboard views (all metrics, filtered by name, aggregations)
- Permission-gated access: viewers subscribe to read-only views, admins mutate data
- Multi-client push: admin inserts trigger pushes to all viewer subscriptions
- Combining auth + subscriptions + permissions in a single server

## Architecture Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│                    Dashboard Server                                 │
│                                                                     │
│  Buckets                          Queries                          │
│  ┌──────────────────────┐         ┌──────────────────────────┐     │
│  │ metrics              │         │ all-metrics              │     │
│  │   name: string       │         │ metrics-by-name(name)    │     │
│  │   value: number      │         │ metric-count             │     │
│  │   unit: string       │         │ latest-metrics(n)        │     │
│  │   timestamp: number  │         └──────────────────────────┘     │
│  └──────────────────────┘                                          │
│                                                                     │
│  Auth                             Permissions                      │
│  ┌──────────────────────┐         ┌──────────────────────────┐     │
│  │ validate(token)      │         │ admin  → full access     │     │
│  │   "admin-token"      │         │ viewer → read-only       │     │
│  │   "viewer-token"     │         │   no insert/update/      │     │
│  └──────────────────────┘         │   delete/clear           │     │
│                                   └──────────────────────────┘     │
│                                                                     │
│  Clients                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                         │
│  │ Admin    │  │ Viewer 1 │  │ Viewer 2 │                         │
│  │ insert   │  │ subscribe│  │ subscribe│                         │
│  │ update   │  │ push ←   │  │ push ←   │                         │
│  │ delete   │  │          │  │          │                         │
│  └──────────┘  └──────────┘  └──────────┘                         │
└────────────────────────────────────────────────────────────────────┘
```

## Complete Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';
import type { AuthSession } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'dashboard' });

  // ── Bucket ──────────────────────────────────────────────────────

  await store.defineBucket('metrics', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      name:      { type: 'string', required: true },
      value:     { type: 'number', required: true },
      unit:      { type: 'string', default: '' },
      timestamp: { type: 'number', required: true },
    },
  });

  // ── Queries ─────────────────────────────────────────────────────

  store.defineQuery('all-metrics', async (ctx) => {
    return ctx.bucket('metrics').all();
  });

  store.defineQuery('metrics-by-name', async (ctx, params: { name: string }) => {
    return ctx.bucket('metrics').where({ name: params.name });
  });

  store.defineQuery('metric-count', async (ctx) => {
    return ctx.bucket('metrics').count();
  });

  store.defineQuery('latest-metrics', async (ctx, params: { n: number }) => {
    return ctx.bucket('metrics').last(params.n);
  });

  // ── Auth + Permissions ──────────────────────────────────────────

  const adminSession: AuthSession = {
    userId: 'admin-1',
    roles: ['admin'],
  };

  const viewerSession: AuthSession = {
    userId: 'viewer-1',
    roles: ['viewer'],
  };

  const WRITE_OPS = new Set([
    'store.insert', 'store.update', 'store.delete', 'store.clear',
    'store.transaction',
  ]);

  const server = await NoexServer.start({
    port: 8080,
    store,
    auth: {
      validate: async (token) => {
        if (token === 'admin-token') return adminSession;
        if (token === 'viewer-token') return viewerSession;
        return null;
      },
      permissions: {
        check: (session, operation) => {
          // Admins can do everything
          if (session.roles.includes('admin')) return true;
          // Viewers cannot mutate data
          if (WRITE_OPS.has(operation)) return false;
          return true;
        },
      },
    },
  });

  console.log(`Dashboard server listening on ws://localhost:${server.port}`);
}

main();
```

## Client Interaction: The Full Flow

### Step 1: Connect and Authenticate

Both admin and viewer connect and receive the welcome message:

```jsonc
// Server → Client (on connect)
{ "type": "welcome", "version": "1.0.0", "serverTime": 1706745600000, "requiresAuth": true }
```

Admin authenticates:

```jsonc
// Admin → Server
{ "id": 1, "type": "auth.login", "token": "admin-token" }

// Server → Admin
{ "id": 1, "type": "result", "data": { "userId": "admin-1", "roles": ["admin"] } }
```

Viewer authenticates:

```jsonc
// Viewer → Server
{ "id": 1, "type": "auth.login", "token": "viewer-token" }

// Server → Viewer
{ "id": 1, "type": "result", "data": { "userId": "viewer-1", "roles": ["viewer"] } }
```

### Step 2: Viewer Subscribes to Live Metrics

```jsonc
// Viewer → Server
{ "id": 2, "type": "store.subscribe", "query": "all-metrics" }

// Server → Viewer (response with subscriptionId + initial data)
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "data": [] } }
```

Subscribe to a filtered view:

```jsonc
// Viewer → Server
{ "id": 3, "type": "store.subscribe", "query": "metrics-by-name", "params": { "name": "cpu" } }

// Server → Viewer
{ "id": 3, "type": "result", "data": { "subscriptionId": "sub-2", "data": [] } }
```

Subscribe to metric count:

```jsonc
// Viewer → Server
{ "id": 4, "type": "store.subscribe", "query": "metric-count" }

// Server → Viewer (scalar initial data)
{ "id": 4, "type": "result", "data": { "subscriptionId": "sub-3", "data": 0 } }
```

### Step 3: Admin Pushes Metrics

```jsonc
// Admin → Server
{ "id": 2, "type": "store.insert", "bucket": "metrics", "data": {
    "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000
  }
}

// Server → Admin (insert result)
{ "id": 2, "type": "result", "data": {
    "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
    "timestamp": 1706745600000, "_version": 1
  }
}
```

After the query re-evaluates, all viewers with active subscriptions receive pushes:

```jsonc
// Server → Viewer (push on all-metrics subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
      "timestamp": 1706745600000, "_version": 1 }
  ]
}

// Server → Viewer (push on metrics-by-name "cpu" subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
      "timestamp": 1706745600000, "_version": 1 }
  ]
}

// Server → Viewer (push on metric-count subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-3", "data": 1 }
```

### Step 4: Viewer Tries to Mutate — Denied

```jsonc
// Viewer → Server
{ "id": 5, "type": "store.insert", "bucket": "metrics", "data": {
    "name": "hack", "value": 0, "unit": "", "timestamp": 0
  }
}

// Server → Viewer
{ "id": 5, "type": "error", "code": "FORBIDDEN", "message": "No permission for store.insert on metrics" }
```

### Step 5: Admin Batch-Inserts via Transaction

```jsonc
// Admin → Server
{ "id": 3, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "memory", "value": 4200, "unit": "MB", "timestamp": 1706745660000
      }
    },
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000
      }
    }
  ]
}

// Server → Admin
{ "id": 3, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "m-def456", "name": "memory", "value": 4200,
        "unit": "MB", "timestamp": 1706745660000, "_version": 1 } },
    { "index": 1, "data": { "id": "m-ghi789", "name": "cpu", "value": 68.1,
        "unit": "%", "timestamp": 1706745660000, "_version": 1 } }
  ] }
}
```

After the transaction commits, all affected subscriptions receive a single push with the latest query result:

```jsonc
// Server → Viewer (push on all-metrics — now 3 records)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000, "_version": 1 },
    { "id": "m-ghi789", "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000, "_version": 1 },
    { "id": "m-def456", "name": "memory", "value": 4200, "unit": "MB", "timestamp": 1706745660000, "_version": 1 }
  ]
}

// Server → Viewer (push on metrics-by-name "cpu" — now 2 cpu records)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000, "_version": 1 },
    { "id": "m-ghi789", "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000, "_version": 1 }
  ]
}

// Server → Viewer (push on metric-count — now 3)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-3", "data": 3 }
```

### Step 6: Clean Up

Viewer unsubscribes from all-metrics:

```jsonc
// Viewer → Server
{ "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-1" }

// Server → Viewer
{ "id": 6, "type": "result", "data": { "unsubscribed": true } }
```

Admin clears old metrics:

```jsonc
// Admin → Server
{ "id": 4, "type": "store.clear", "bucket": "metrics" }

// Server → Admin
{ "id": 4, "type": "result", "data": { "cleared": true } }
```

## Detailed Breakdown

### Schema Design

The `metrics` bucket stores individual data points with a `name` field for categorization (cpu, memory, disk, network). The `timestamp` field enables time-based filtering in queries. Using `generated: 'uuid'` for the key means you don't need to worry about collisions when multiple admins push metrics simultaneously.

### Reactive Queries

Four queries serve different dashboard views:

| Query | Parameters | Returns | Dashboard Use |
|-------|-----------|---------|---------------|
| `all-metrics` | none | array | Full metrics table |
| `metrics-by-name` | `{ name }` | array | Single-metric chart |
| `metric-count` | none | scalar | Counter badge |
| `latest-metrics` | `{ n }` | array | "Last N readings" widget |

Each viewer subscribes to the queries they need. When any metric is inserted, updated, or deleted, only the queries whose results actually change emit a push. For example, inserting a `cpu` metric triggers pushes to `all-metrics`, `metrics-by-name({ name: 'cpu' })`, and `metric-count`, but not to `metrics-by-name({ name: 'memory' })`.

### Permission Model

The permission check is a simple function — no framework or middleware required:

```typescript
const WRITE_OPS = new Set([
  'store.insert', 'store.update', 'store.delete', 'store.clear',
  'store.transaction',
]);

check: (session, operation) => {
  if (session.roles.includes('admin')) return true;
  if (WRITE_OPS.has(operation)) return false;
  return true;
}
```

This gives viewers read-only access (they can use `store.all`, `store.where`, `store.subscribe`, etc.) while reserving mutations for admins. The `resource` parameter (the bucket name) is available but unused here — you could extend this to restrict access to specific buckets.

### Multi-Client Push

The key insight is that subscriptions and mutations are decoupled:

1. Viewer subscribes to `all-metrics` → gets `sub-1`
2. Admin (a different connection) inserts a metric
3. Server detects the data change, re-evaluates the query
4. Server pushes the new result to the viewer's `sub-1`

This works because queries are evaluated server-side against the shared Store. Any mutation from any connection triggers re-evaluation for all subscriptions watching affected data.

## Exercise

Extend the dashboard with:

1. A new bucket `alerts` with fields `metric`, `threshold`, `severity` (low/medium/high)
2. A query `active-alerts` that returns all alerts
3. A permission rule: viewers can read alerts, but only admins can create them
4. An admin flow: when a metric exceeds a threshold, insert an alert via transaction (insert metric + insert alert atomically)

<details>
<summary>Solution</summary>

**Server-side additions:**

```typescript
await store.defineBucket('alerts', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    metric:    { type: 'string', required: true },
    threshold: { type: 'number', required: true },
    severity:  { type: 'string', default: 'low' },
    timestamp: { type: 'number', required: true },
  },
});

store.defineQuery('active-alerts', async (ctx) => {
  return ctx.bucket('alerts').all();
});
```

No permission changes needed — the existing `WRITE_OPS` set already covers `store.insert` and `store.transaction`.

**Client flow (admin detects high CPU and creates an alert):**

```jsonc
// Admin → Server (atomic: insert metric + insert alert)
{ "id": 5, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "cpu", "value": 95.2, "unit": "%", "timestamp": 1706745720000
      }
    },
    { "op": "insert", "bucket": "alerts", "data": {
        "metric": "cpu", "threshold": 90, "severity": "high", "timestamp": 1706745720000
      }
    }
  ]
}

// Server → Admin
{ "id": 5, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "m-xxx", "name": "cpu", "value": 95.2, ... } },
    { "index": 1, "data": { "id": "a-yyy", "metric": "cpu", "threshold": 90,
        "severity": "high", ... } }
  ] }
}
```

Viewers subscribed to `active-alerts` receive a push with the new alert. Viewers subscribed to `all-metrics` or `metrics-by-name({ name: 'cpu' })` receive updated metric lists. All pushes arrive from the single transaction commit.

</details>

## Summary

- **Schema design**: Use a single bucket with a `name` field for categorization and `timestamp` for time-series data
- **Reactive queries**: Define queries for each dashboard view — `all`, `where` with params, `count`, `last(n)`
- **Permissions**: A simple function with a `Set` of write operations — no framework needed
- **Multi-client push**: Mutations from one connection trigger pushes to all other connections with active subscriptions
- **Transactions**: Batch-insert multiple metrics atomically — subscribers receive a single push after the commit
- **Subscription response**: Includes `subscriptionId` and `data` (initial query result) — client can render immediately without a separate fetch

---

Next: [Chat Application](./02-chat-application.md)
