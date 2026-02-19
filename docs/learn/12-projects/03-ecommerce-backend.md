# E-Commerce Backend

Build a complete e-commerce backend that uses every noex-server feature: Store for product catalog, orders, and user accounts; Rules for order event processing; Auth for customer and admin access; and production configuration with rate limiting, heartbeat, and backpressure. This is the capstone project — everything you've learned comes together.

## What You'll Learn

- Multi-bucket schema design for products, orders, users, and audit logs
- Cross-bucket transactions for atomic order placement (deduct stock, create order, log action)
- Reactive subscriptions for live order status and inventory dashboards
- Rules integration for order lifecycle events and notifications
- Full auth setup with customer and admin roles, per-operation permissions
- Production configuration: rate limiting, heartbeat, backpressure

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                       E-Commerce Server                                  │
│                                                                          │
│  Store                                Rules                             │
│  ┌───────────────────────────────┐    ┌────────────────────────────┐    │
│  │ products                      │    │ Events:                    │    │
│  │   title, price, stock, active │    │   order.placed             │    │
│  │                               │    │   order.shipped            │    │
│  │ orders                        │    │   order.cancelled          │    │
│  │   userId, items, total,       │    │   inventory.low_stock      │    │
│  │   status, createdAt           │    │                            │    │
│  │                               │    │ Facts:                     │    │
│  │ users                         │    │   order:<id>:status        │    │
│  │   name, email, role, credits  │    │   product:<id>:reserved    │    │
│  │                               │    └────────────────────────────┘    │
│  │ audit-logs                    │                                      │
│  │   action, userId, details,    │    Auth                              │
│  │   timestamp                   │    ┌────────────────────────────┐    │
│  └───────────────────────────────┘    │ customer → read products,  │    │
│                                       │   own orders, place order  │    │
│  Queries                              │ admin → full access,       │    │
│  ┌───────────────────────────────┐    │   manage products, ship    │    │
│  │ product-catalog               │    └────────────────────────────┘    │
│  │ user-orders(userId)           │                                      │
│  │ order-count(userId)           │    Resilience                        │
│  │ low-stock-products            │    ┌────────────────────────────┐    │
│  │ recent-orders                 │    │ Rate limit: 100 req/min   │    │
│  └───────────────────────────────┘    │ Heartbeat: 30s / 10s      │    │
│                                       │ Backpressure: 1 MB / 0.8  │    │
│                                       └────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Complete Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';
import type { AuthSession } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'ecommerce' });
  const engine = await RuleEngine.start({ name: 'ecommerce-rules' });

  // ── Buckets ─────────────────────────────────────────────────────

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:     { type: 'string', generated: 'uuid' },
      title:  { type: 'string', required: true },
      price:  { type: 'number', required: true },
      stock:  { type: 'number', default: 0 },
      active: { type: 'boolean', default: true },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      userId:    { type: 'string', required: true },
      items:     { type: 'string', required: true }, // JSON-encoded array
      total:     { type: 'number', required: true },
      status:    { type: 'string', default: 'pending' },
      createdAt: { type: 'number', required: true },
    },
  });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      name:    { type: 'string', required: true },
      email:   { type: 'string', required: true },
      role:    { type: 'string', default: 'customer' },
      credits: { type: 'number', default: 0 },
    },
  });

  await store.defineBucket('audit-logs', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      action:    { type: 'string', required: true },
      userId:    { type: 'string', required: true },
      details:   { type: 'string', default: '' },
      timestamp: { type: 'number', required: true },
    },
  });

  // ── Queries ─────────────────────────────────────────────────────

  store.defineQuery('product-catalog', async (ctx) => {
    return ctx.bucket('products').where({ active: true });
  });

  store.defineQuery('user-orders', async (ctx, params: { userId: string }) => {
    return ctx.bucket('orders').where({ userId: params.userId });
  });

  store.defineQuery('order-count', async (ctx, params: { userId: string }) => {
    return ctx.bucket('orders').count({ userId: params.userId });
  });

  store.defineQuery('low-stock-products', async (ctx) => {
    // Returns all products — client-side filtering for stock < 10
    // In production, you'd use a more sophisticated query
    return ctx.bucket('products').all();
  });

  store.defineQuery('recent-orders', async (ctx) => {
    return ctx.bucket('orders').last(20);
  });

  // ── Auth + Permissions ──────────────────────────────────────────

  // In production, validate would verify JWTs or call an auth service
  const sessions: Record<string, AuthSession> = {
    'customer-token-alice': {
      userId: 'user-alice',
      roles: ['customer'],
    },
    'customer-token-bob': {
      userId: 'user-bob',
      roles: ['customer'],
    },
    'admin-token': {
      userId: 'admin-1',
      roles: ['admin'],
    },
  };

  const ADMIN_ONLY_OPS = new Set([
    'store.clear',
    'store.delete',  // only admins can delete products/orders
  ]);

  const CUSTOMER_ALLOWED_BUCKETS = new Set([
    'products', // read
    'orders',   // read own + place new
  ]);

  const server = await NoexServer.start({
    port: 8080,
    store,
    rules: engine,
    auth: {
      validate: async (token) => sessions[token] ?? null,
      permissions: {
        check: (session, operation, resource) => {
          // Admins can do everything
          if (session.roles.includes('admin')) return true;

          // Admin-only operations
          if (ADMIN_ONLY_OPS.has(operation)) return false;

          // Customers can only access allowed buckets
          if (operation.startsWith('store.') && !CUSTOMER_ALLOWED_BUCKETS.has(resource)) {
            // Allow audit-logs for insert only (via transactions)
            if (resource === 'audit-logs' && operation === 'store.transaction') return true;
            return false;
          }

          return true;
        },
      },
    },

    // ── Production Resilience ───────────────────────────────────

    rateLimit: {
      maxRequests: 100,
      windowMs: 60_000,   // 100 requests per minute per user
    },
    heartbeat: {
      intervalMs: 30_000,  // ping every 30 seconds
      timeoutMs: 10_000,   // close if no pong within 10 seconds
    },
    backpressure: {
      maxBufferedBytes: 1_048_576,  // 1 MB
      highWaterMark: 0.8,           // pause pushes at 80%
    },
  });

  console.log(`E-Commerce server listening on ws://localhost:${server.port}`);
  console.log(`Auth: enabled, Rate limit: 100/min, Heartbeat: 30s`);
}

main();
```

## Client Interaction: Complete Order Flow

### Step 1: Connect and Authenticate

```jsonc
// Server → Client (on connect)
{ "type": "welcome", "version": "1.0.0", "serverTime": 1706745600000, "requiresAuth": true }

// Customer Alice authenticates
// Alice → Server
{ "id": 1, "type": "auth.login", "token": "customer-token-alice" }

// Server → Alice
{ "id": 1, "type": "result", "data": { "userId": "user-alice", "roles": ["customer"] } }
```

### Step 2: Browse Products

```jsonc
// Alice → Server (subscribe to live product catalog)
{ "id": 2, "type": "store.subscribe", "query": "product-catalog" }

// Server → Alice (initial catalog)
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "data": [
    { "id": "prod-1", "title": "Wireless Keyboard", "price": 79.99, "stock": 25, "active": true, "_version": 1 },
    { "id": "prod-2", "title": "USB-C Hub", "price": 45.00, "stock": 50, "active": true, "_version": 1 },
    { "id": "prod-3", "title": "Laptop Stand", "price": 120.00, "stock": 3, "active": true, "_version": 1 }
  ] }
}
```

### Step 3: Place an Order (Cross-Bucket Transaction)

Alice orders a Wireless Keyboard. The transaction atomically:
1. Updates the product stock
2. Creates the order record
3. Writes an audit log entry

```jsonc
// Alice → Server
{ "id": 3, "type": "store.transaction", "operations": [
    { "op": "update", "bucket": "products", "key": "prod-1",
      "data": { "stock": 24 } },
    { "op": "insert", "bucket": "orders", "data": {
        "userId": "user-alice",
        "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]",
        "total": 79.99,
        "status": "pending",
        "createdAt": 1706745700000
      }
    },
    { "op": "insert", "bucket": "audit-logs", "data": {
        "action": "order_placed",
        "userId": "user-alice",
        "details": "Wireless Keyboard x1",
        "timestamp": 1706745700000
      }
    }
  ]
}

// Server → Alice
{ "id": 3, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "prod-1", "title": "Wireless Keyboard",
        "price": 79.99, "stock": 24, "active": true, "_version": 2 } },
    { "index": 1, "data": { "id": "order-1", "userId": "user-alice",
        "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]",
        "total": 79.99, "status": "pending", "createdAt": 1706745700000, "_version": 1 } },
    { "index": 2, "data": { "id": "log-1", "action": "order_placed",
        "userId": "user-alice", "details": "Wireless Keyboard x1",
        "timestamp": 1706745700000, "_version": 1 } }
  ] }
}
```

If any operation fails (e.g. product doesn't exist, validation error), the entire transaction rolls back — stock stays at 25, no order is created, no log is written.

### Step 4: Emit Order Event (Rules)

After the transaction succeeds, emit an order event for downstream processing:

```jsonc
// Alice → Server
{ "id": 4, "type": "rules.emit", "topic": "order.placed", "data": {
    "orderId": "order-1", "userId": "user-alice", "total": 79.99
  }
}

// Server → Alice
{ "id": 4, "type": "result", "data": {
    "id": "evt-1", "topic": "order.placed", "timestamp": 1706745700500,
    "data": { "orderId": "order-1", "userId": "user-alice", "total": 79.99 }
  }
}
```

### Step 5: Subscribe to Order Status

Alice subscribes to her order list for live status updates:

```jsonc
// Alice → Server
{ "id": 5, "type": "store.subscribe", "query": "user-orders",
  "params": { "userId": "user-alice" } }

// Server → Alice (initial: one pending order)
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-2", "data": [
    { "id": "order-1", "userId": "user-alice", "total": 79.99,
      "status": "pending", "createdAt": 1706745700000, "_version": 1,
      "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
  ] }
}
```

### Step 6: Admin Ships the Order

Admin authenticates and updates the order status:

```jsonc
// Admin → Server
{ "id": 1, "type": "auth.login", "token": "admin-token" }

// Server → Admin
{ "id": 1, "type": "result", "data": { "userId": "admin-1", "roles": ["admin"] } }

// Admin → Server (update order status)
{ "id": 2, "type": "store.update", "bucket": "orders", "key": "order-1",
  "data": { "status": "shipped" } }

// Server → Admin
{ "id": 2, "type": "result", "data": { "id": "order-1", "userId": "user-alice",
    "total": 79.99, "status": "shipped", "createdAt": 1706745700000, "_version": 2,
    "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
}
```

Alice's subscription receives a push with the updated order list:

```jsonc
// Server → Alice (push — order status changed to "shipped")
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "order-1", "userId": "user-alice", "total": 79.99,
      "status": "shipped", "createdAt": 1706745700000, "_version": 2,
      "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
  ]
}
```

Admin emits a shipping event:

```jsonc
// Admin → Server
{ "id": 3, "type": "rules.emit", "topic": "order.shipped", "data": {
    "orderId": "order-1", "userId": "user-alice"
  }
}
```

### Step 7: Track Order Status with Rules Facts

Use facts for quick status lookups without querying the Store:

```jsonc
// Admin → Server (set fact for order status)
{ "id": 4, "type": "rules.setFact", "key": "order:order-1:status", "value": "shipped" }

// Server → Admin
{ "id": 4, "type": "result", "data": { "key": "order:order-1:status", "value": "shipped" } }
```

Any client can query order statuses:

```jsonc
// Alice → Server
{ "id": 6, "type": "rules.queryFacts", "pattern": "order:*:status" }

// Server → Alice
{ "id": 6, "type": "result", "data": [
    { "key": "order:order-1:status", "value": "shipped" }
  ]
}
```

### Step 8: Admin Subscribes to Order Events

```jsonc
// Admin → Server
{ "id": 5, "type": "rules.subscribe", "pattern": "order.*" }

// Server → Admin
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-3" } }
```

Now when any client emits order events, the admin receives pushes:

```jsonc
// Server → Admin (push when a new order is placed by any customer)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "order.placed",
    "event": {
      "id": "evt-2", "topic": "order.placed", "timestamp": 1706745800000,
      "data": { "orderId": "order-2", "userId": "user-bob", "total": 45.00 }
    }
  }
}
```

### Step 9: Permission Enforcement

Customer tries an admin-only operation:

```jsonc
// Alice → Server (try to delete a product)
{ "id": 7, "type": "store.delete", "bucket": "products", "key": "prod-1" }

// Server → Alice
{ "id": 7, "type": "error", "code": "FORBIDDEN",
  "message": "No permission for store.delete on products" }
```

```jsonc
// Alice → Server (try to access users bucket)
{ "id": 8, "type": "store.all", "bucket": "users" }

// Server → Alice
{ "id": 8, "type": "error", "code": "FORBIDDEN",
  "message": "No permission for store.all on users" }
```

### Step 10: Rate Limiting in Action

If a client sends too many requests:

```jsonc
// After 100 requests in a minute...

// Alice → Server
{ "id": 101, "type": "store.all", "bucket": "products" }

// Server → Alice
{ "id": 101, "type": "error", "code": "RATE_LIMITED",
  "message": "Rate limit exceeded. Retry after 15000ms", "details": { "retryAfterMs": 15000 } }
```

### Step 11: Whoami and Logout

```jsonc
// Alice → Server (check session)
{ "id": 9, "type": "auth.whoami" }

// Server → Alice
{ "id": 9, "type": "result", "data": {
    "authenticated": true, "userId": "user-alice", "roles": ["customer"]
  }
}

// Alice → Server (logout)
{ "id": 10, "type": "auth.logout" }

// Server → Alice
{ "id": 10, "type": "result", "data": { "loggedOut": true } }

// Alice → Server (request after logout)
{ "id": 11, "type": "store.all", "bucket": "products" }

// Server → Alice
{ "id": 11, "type": "error", "code": "UNAUTHORIZED", "message": "Authentication required" }
```

## Detailed Breakdown

### Cross-Bucket Transactions

The order placement transaction is the most critical operation. It spans three buckets:

```text
Transaction: Place Order
  ┌─────────────────────────────────────────────────────┐
  │ 1. UPDATE products  SET stock = stock - quantity     │
  │ 2. INSERT orders    (userId, items, total, status)   │
  │ 3. INSERT audit-logs (action, userId, timestamp)     │
  │                                                       │
  │ On failure: ALL three operations roll back            │
  └─────────────────────────────────────────────────────┘
```

Without transactions, a failure between operations could leave the system in an inconsistent state — stock decremented but no order created. The transaction guarantees all-or-nothing semantics.

### Permission Design

The permission system uses a layered approach:

| Role | Products | Orders | Users | Audit Logs | Rules |
|------|----------|--------|-------|------------|-------|
| admin | full access | full access | full access | full access | full access |
| customer | read only | read own + insert | no access | insert via tx | emit + subscribe |

The `check` function receives `(session, operation, resource)` where `resource` is the bucket name. This lets you implement fine-grained access control without a middleware framework.

### Production Configuration

The three resilience features protect the server in production:

| Feature | Config | What It Does |
|---------|--------|-------------|
| Rate limiting | `100 req/min` | Prevents abuse; key is `userId` when authenticated, IP when not |
| Heartbeat | `30s interval, 10s timeout` | Detects dead connections; closes with code `4001` if no pong |
| Backpressure | `1 MB buffer, 0.8 high water mark` | Pauses push messages to slow clients at 80% buffer usage |

These work together: rate limiting prevents request floods, heartbeat cleans up stale connections, and backpressure prevents memory exhaustion from slow WebSocket consumers.

### Reactive Order Dashboard

The admin can subscribe to `recent-orders` for a live dashboard:

```jsonc
// Admin → Server
{ "id": 6, "type": "store.subscribe", "query": "recent-orders" }

// Server → Admin (initial: last 20 orders)
{ "id": 6, "type": "result", "data": { "subscriptionId": "sub-4", "data": [...] } }
```

Every time any customer places an order, the admin's subscription receives a push with the updated order list. Combined with a `rules.subscribe` on `order.*`, the admin sees both the persistent state (order records) and the event stream (order events) in real time.

### Server Stats

Monitor the server in production:

```typescript
const stats = await server.getStats();
// {
//   name: 'ecommerce',
//   port: 8080,
//   connectionCount: 42,
//   uptimeMs: 3600000,
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

### Graceful Shutdown

Stop the server with a grace period for clients to disconnect:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

The server:
1. Sends a `{ type: "system", event: "shutdown", gracePeriodMs: 5000 }` message to all clients
2. Stops accepting new connections
3. Waits up to 5 seconds for clients to disconnect gracefully
4. Closes remaining connections and cleans up all subscriptions

## Exercise

Extend the e-commerce backend with:

1. An `inventory.low_stock` event emitted via rules when a product's stock drops below 5 after an order
2. An admin subscription to `inventory.*` events for stock alerts
3. A "cancel order" flow: admin updates order status to "cancelled", restores product stock via transaction, emits `order.cancelled` event

<details>
<summary>Solution</summary>

**Low stock alert after order placement:**

```jsonc
// After the order transaction succeeds, check if stock is low:
// (Application logic — the client checks the transaction result)

// If stock < 5, emit alert:
// Admin/System → Server
{ "id": 20, "type": "rules.emit", "topic": "inventory.low_stock", "data": {
    "productId": "prod-3", "title": "Laptop Stand", "currentStock": 2
  }
}
```

**Admin subscribes to inventory alerts:**

```jsonc
// Admin → Server
{ "id": 7, "type": "rules.subscribe", "pattern": "inventory.*" }

// Server → Admin
{ "id": 7, "type": "result", "data": { "subscriptionId": "sub-5" } }

// When low stock event fires:
// Server → Admin (push)
{ "type": "push", "channel": "event", "subscriptionId": "sub-5", "data": {
    "topic": "inventory.low_stock",
    "event": {
      "id": "evt-3", "topic": "inventory.low_stock", "timestamp": 1706745900000,
      "data": { "productId": "prod-3", "title": "Laptop Stand", "currentStock": 2 }
    }
  }
}
```

**Cancel order flow (transaction):**

```jsonc
// Admin → Server (atomic: restore stock + update order + log)
{ "id": 8, "type": "store.transaction", "operations": [
    { "op": "update", "bucket": "products", "key": "prod-1",
      "data": { "stock": 25 } },
    { "op": "update", "bucket": "orders", "key": "order-1",
      "data": { "status": "cancelled" } },
    { "op": "insert", "bucket": "audit-logs", "data": {
        "action": "order_cancelled",
        "userId": "admin-1",
        "details": "Order order-1 cancelled, stock restored",
        "timestamp": 1706745950000
      }
    }
  ]
}

// Server → Admin
{ "id": 8, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "prod-1", "stock": 25, ... } },
    { "index": 1, "data": { "id": "order-1", "status": "cancelled", ... } },
    { "index": 2, "data": { "id": "log-2", "action": "order_cancelled", ... } }
  ] }
}

// Admin → Server (emit cancellation event)
{ "id": 9, "type": "rules.emit", "topic": "order.cancelled", "data": {
    "orderId": "order-1", "userId": "user-alice", "reason": "admin_cancelled"
  }
}
```

Alice's `user-orders` subscription receives a push with the updated order (status: "cancelled"). The admin's `order.*` rules subscription receives the `order.cancelled` event push. The product catalog subscription updates with restored stock. All from a single atomic transaction + one event.

</details>

## Summary

- **Multi-bucket schema**: Separate buckets for products, orders, users, and audit logs — each with its own key and validation
- **Cross-bucket transactions**: Order placement atomically updates stock, creates order, and logs the action — rollback on any failure
- **Layered permissions**: Admin gets full access; customers get read-only products, own orders, and insert-only via transactions
- **Production resilience**: Rate limiting (100 req/min per user), heartbeat (30s/10s), backpressure (1 MB/0.8) — all configured in `ServerConfig`
- **Dual push channels**: Store subscriptions for order status and product catalog; Rules subscriptions for order events and inventory alerts
- **Graceful shutdown**: `server.stop({ gracePeriodMs })` notifies clients before closing connections
- **Server stats**: `server.getStats()` provides real-time connection counts, subscription totals, and feature flags

---

Next: [Production Deployment](./04-production-deployment.md)
