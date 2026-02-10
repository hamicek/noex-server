# Graceful Shutdown

Stop the server cleanly — notify connected clients, give them time to finish work, and shut down all resources in the correct order.

## What You'll Learn

- `server.stop()` — immediate shutdown
- `server.stop({ gracePeriodMs })` — notify clients and wait before closing
- The system `shutdown` message clients receive
- The complete shutdown sequence
- What happens to new connections during shutdown
- Idempotent stop behavior

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'shutdown-demo' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Immediate Shutdown

Call `stop()` without options for an immediate shutdown:

```typescript
await server.stop();
```

This:
1. Stops accepting new connections
2. Force-closes all active connections (each GenServer's `terminate()` runs)
3. Stops the rate limiter (if configured)
4. Closes the connection registry
5. Closes the HTTP server

Each connection's `terminate()` unsubscribes all subscriptions and sends a WebSocket close frame with code `1000`.

## Graceful Shutdown with Grace Period

Pass `gracePeriodMs` to give clients time to wrap up:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

### Shutdown Sequence

```
server.stop({ gracePeriodMs: 5000 })
  │
  ▼
1. Stop accepting new connections (HTTP server closed)
  │
  ▼
2. Broadcast system shutdown message to all clients
   ← { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
  │
  ▼
3. Wait up to 5000 ms for clients to disconnect voluntarily
   (exits early if all clients disconnect before the timer)
  │
  ▼
4. Force-stop remaining connections via Supervisor
   (terminate() → unsubscribe all → ws.close(1000, 'server_shutdown'))
  │
  ▼
5. Stop rate limiter (if configured)
  │
  ▼
6. Close connection registry
  │
  ▼
7. Close HTTP server
```

### The Shutdown System Message

When a grace period is specified and there are active connections, the server broadcasts:

```jsonc
← { "type": "system",
    "event": "shutdown",
    "gracePeriodMs": 5000 }
```

This tells clients:
- The server is shutting down
- They have `gracePeriodMs` milliseconds to finish work and disconnect
- After the grace period, the server will forcefully close all remaining connections

### No Grace Period, No Message

When `gracePeriodMs` is `0` (the default), no shutdown message is sent — connections are closed immediately:

```typescript
// These are equivalent — no shutdown message is sent
await server.stop();
await server.stop({ gracePeriodMs: 0 });
```

## Client Behavior During Grace Period

Clients **can still send requests** during the grace period. The connection is fully functional until the server force-closes it:

```jsonc
// Server sends shutdown notification
← { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }

// Client can still work during grace period
→ { "id": 10, "type": "store.insert", "bucket": "tasks",
    "data": { "title": "Save this before shutdown" } }
← { "id": 10, "type": "result", "data": { "id": "abc-123", ... } }

// Client disconnects voluntarily
```

## Early Exit

If all clients disconnect before the grace period expires, `stop()` resolves immediately — it doesn't wait for the full timer:

```typescript
// Grace period is 10 seconds, but if all 3 clients
// disconnect after 200 ms, stop() resolves in ~200 ms
await server.stop({ gracePeriodMs: 10_000 });
```

## New Connections During Shutdown

Once `stop()` is called, new WebSocket connections are rejected immediately:

- The HTTP server stops accepting new TCP connections
- Any WebSocket that manages to connect during the shutdown window is closed with code `1001` and reason `'server_shutting_down'`

## Close Codes

| Code | Reason | When |
|------|--------|------|
| `1000` | `normal_closure` | Client disconnects normally |
| `1000` | `server_shutdown` | Server force-closes during/after grace period |
| `1001` | `server_shutting_down` | New connection attempt during shutdown |

## Idempotent Stop

Calling `stop()` multiple times is safe — subsequent calls return immediately:

```typescript
await server.stop();
await server.stop(); // No-op, returns immediately
```

After stop, `server.isRunning` returns `false`.

## Working Example

```typescript
const server = await NoexServer.start({ store, port: 8080 });

// Handle process signals for clean shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await server.stop({ gracePeriodMs: 5000 });
  await store.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await server.stop({ gracePeriodMs: 5000 });
  await store.stop();
  process.exit(0);
});
```

**Client-side handling:**

```typescript
// Client listens for the shutdown message
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'system' && msg.event === 'shutdown') {
    console.log(`Server shutting down in ${msg.gracePeriodMs}ms`);
    // Save state, unsubscribe, disconnect cleanly
    ws.close();
  }
});
```

## Exercise

Write a shutdown scenario:
1. Start a server with one connected client
2. The client has an active subscription
3. Initiate graceful shutdown with a 2-second grace period
4. Show what the client receives
5. The client saves a record and disconnects during the grace period

<details>
<summary>Solution</summary>

```jsonc
// Client is connected with a subscription
// (store.subscribe was called earlier, receiving push updates)

// Server calls: await server.stop({ gracePeriodMs: 2000 })

// 1. Client receives shutdown notification
← { "type": "system", "event": "shutdown", "gracePeriodMs": 2000 }

// 2. Client saves last-minute work
→ { "id": 20, "type": "store.insert", "bucket": "tasks",
    "data": { "title": "Emergency save" } }
← { "id": 20, "type": "result",
    "data": { "id": "xyz-789", "title": "Emergency save" } }

// 3. Client disconnects voluntarily
//    (WebSocket close initiated by client)

// Server-side: all clients disconnected early
// → stop() resolves immediately (before 2s timer expires)
// → Subscriptions cleaned up in terminate()
// → Rate limiter stopped, registry closed, HTTP server closed
```

</details>

## Summary

- `server.stop()` closes all connections immediately (no notification)
- `server.stop({ gracePeriodMs })` broadcasts a `system` shutdown message and waits
- Clients can still send requests during the grace period
- If all clients disconnect early, `stop()` resolves immediately
- New connections during shutdown are rejected with close code `1001`
- Each connection's `terminate()` unsubscribes all subscriptions and closes the WebSocket
- `stop()` is idempotent — safe to call multiple times
- Connection close code is `1000` with reason `"server_shutdown"` for forced closes

---

Next: [Rate Limiting](../10-resilience/01-rate-limiting.md)
