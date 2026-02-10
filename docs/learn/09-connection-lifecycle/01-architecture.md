# Architecture

How noex-server manages WebSocket connections internally — one GenServer per connection, supervised by a `simple_one_for_one` supervisor with temporary restart strategy.

## What You'll Learn

- How each WebSocket connection maps to a GenServer process
- The `ConnectionSupervisor` with `simple_one_for_one` strategy
- Why connections use `temporary` restart — crashed connections are cleaned up, not restarted
- The connection lifecycle: init, message handling, and terminate
- How the request pipeline processes each incoming message

## The Big Picture

```
NoexServer.start()
  │
  ├── HTTP Server (upgrade handler)
  │
  ├── WebSocketServer (noServer mode)
  │
  ├── ConnectionSupervisor (simple_one_for_one)
  │     │
  │     ├── ConnectionServer (GenServer) ── WebSocket A
  │     ├── ConnectionServer (GenServer) ── WebSocket B
  │     └── ConnectionServer (GenServer) ── WebSocket C
  │
  ├── ConnectionRegistry (tracks metadata)
  │
  └── RateLimiter (optional GenServer)
```

Each WebSocket connection gets its own GenServer — the `ConnectionServer`. These are managed by a single `ConnectionSupervisor` using the `simple_one_for_one` strategy from `@hamicek/noex`.

## One GenServer per Connection

When a client connects via WebSocket, the server:

1. Creates a new `ConnectionServer` GenServer as a child of the supervisor
2. Registers the connection in the `ConnectionRegistry`
3. Wires WebSocket events (`message`, `close`) to the GenServer
4. Starts a heartbeat timer

The GenServer holds all per-connection state:

```typescript
interface ConnectionState {
  readonly ws: WebSocket;
  readonly remoteAddress: string;
  readonly connectionId: string;       // "conn-1", "conn-2", ...
  readonly config: ResolvedServerConfig;
  session: AuthSession | null;         // Set after auth.login
  authenticated: boolean;
  readonly storeSubscriptions: Map<string, () => void>;
  readonly rulesSubscriptions: Map<string, () => void>;
  lastPingAt: number;                  // Heartbeat tracking
  lastPongAt: number;
}
```

Key points:
- **Isolation** — each connection's state (auth session, subscriptions, heartbeat) is fully independent
- **No shared mutable state** — connections communicate through the store and rules engine, not directly
- **Connection ID** — auto-incrementing identifier (`conn-1`, `conn-2`, ...) assigned at creation

## ConnectionSupervisor

The supervisor uses two important settings:

```typescript
Supervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    start: async (ws, remoteAddress, connectionId) => {
      const behavior = createConnectionBehavior(ws, remoteAddress, config, connectionId);
      return GenServer.start(behavior);
    },
    restart: 'temporary',
    shutdownTimeout: 5_000,
  },
});
```

- **`simple_one_for_one`** — all children use the same template; new children are started dynamically via `Supervisor.startChild()`
- **`temporary`** — if a ConnectionServer crashes, it is removed from the supervisor but **not restarted**. This is intentional: a crashed WebSocket connection cannot be resumed, so restarting would be pointless.
- **`shutdownTimeout: 5_000`** — during graceful shutdown, each child has 5 seconds to clean up

### Why Not Restart?

Unlike a long-lived process (database, cache), a WebSocket connection is inherently tied to a specific TCP socket. If the GenServer crashes:
- The WebSocket is already broken
- The client must reconnect and re-establish state (auth, subscriptions)
- Restarting would create a GenServer with a dead socket

The `temporary` strategy ensures crashed connections are cleaned up without wasting resources on futile restart attempts.

## Connection Lifecycle

### 1. Init — Welcome Message

When the GenServer starts, `init()` sends a welcome message to the client:

```jsonc
← { "type": "welcome",
    "version": "1.0.0",
    "serverTime": 1706745600000,
    "requiresAuth": false }
```

### 2. Message Handling — The Request Pipeline

Every incoming WebSocket message is cast to the GenServer as `{ type: 'ws_message', raw: string }`. The pipeline processes it through these stages:

```
Raw WebSocket message
  │
  ▼
Parse JSON ──▶ PARSE_ERROR (malformed JSON, non-object)
  │
  ▼
Validate structure ──▶ INVALID_REQUEST (missing id or type)
  │
  ▼
Pong? ──▶ Update lastPongAt, return
  │
  ▼
Check auth ──▶ UNAUTHORIZED (not logged in, session expired)
  │
  ▼
Check rate limit ──▶ RATE_LIMITED (quota exceeded)
  │
  ▼
Route request ──▶ store.* / rules.* / auth.* / server.*
  │
  ▼
Send response ──▶ { type: "result", data: ... }
```

### 3. Push Messages

Subscription callbacks cast `{ type: 'push', subscriptionId, channel, data }` to the GenServer. The GenServer checks backpressure before sending:

- If the WebSocket write buffer is below the high water mark → send the push
- If backpressured → silently drop the push (reactive queries will resend on next change)

### 4. Heartbeat Ticks

The heartbeat timer periodically casts `{ type: 'heartbeat_tick' }`. The GenServer sends a ping and checks if the previous ping was acknowledged. See [Heartbeat](../10-resilience/02-heartbeat.md) for details.

### 5. Terminate — Cleanup

When a connection ends (client disconnect, server shutdown, or heartbeat timeout), `terminate()` runs:

1. Unsubscribes all store subscriptions
2. Unsubscribes all rules subscriptions
3. Closes the WebSocket with code `1000`
   - Reason: `"normal_closure"` for normal disconnect
   - Reason: `"server_shutdown"` for server stop

```
terminate()
  │
  ├── Unsubscribe all store subscriptions
  ├── Unsubscribe all rules subscriptions
  └── Close WebSocket (code 1000)
```

## Event Wiring

WebSocket events are wired to the GenServer in the supervisor's `addConnection()`:

```
WebSocket event         →  GenServer cast
─────────────────────────────────────────
ws.on('message')        →  { type: 'ws_message', raw }
ws.on('close')          →  heartbeat.stop() + GenServer.stop(ref, 'normal')
ws.on('error')          →  (no-op — always followed by close)
setInterval(tick)       →  { type: 'heartbeat_tick' }
```

The `ws.on('error')` handler is intentionally empty — WebSocket errors are always followed by a `close` event, so cleanup happens in the close handler.

## Working Example

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'arch-demo' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
    done:  { type: 'boolean', default: false },
  },
});

const server = await NoexServer.start({ store, port: 8080 });

console.log(`Server running on port ${server.port}`);
console.log(`Connections: ${server.connectionCount}`);
console.log(`Running: ${server.isRunning}`);

// Each client that connects gets:
// 1. Its own GenServer (ConnectionServer)
// 2. A welcome message
// 3. Independent state (auth, subscriptions, heartbeat)
```

## Exercise

Draw the sequence of events that happen when:
1. A client connects via WebSocket
2. Sends `store.insert` to create a record
3. The client disconnects

Identify which components are involved at each step.

<details>
<summary>Solution</summary>

```
1. Client connects
   ─────────────────────────────────────────────────────
   HTTP Server    →  Upgrade request
   WSS            →  'connection' event
   Supervisor     →  startChild() → new ConnectionServer GenServer
   Registry       →  registerConnection(connectionId, metadata)
   Heartbeat      →  startHeartbeat(tick, intervalMs)
   GenServer init →  sends welcome message to client
   Client         ←  { type: "welcome", version: "1.0.0", ... }

2. Client sends store.insert
   ─────────────────────────────────────────────────────
   WebSocket      →  ws.on('message') fires
   GenServer      ←  cast { type: 'ws_message', raw: '...' }
   Pipeline       →  parse → checkAuth → checkRateLimit → routeRequest
   Store          →  store.insert('tasks', { title: 'Test' })
   GenServer      →  sendRaw(ws, serializeResult(id, data))
   Client         ←  { id: 1, type: "result", data: { id: "abc", ... } }

3. Client disconnects
   ─────────────────────────────────────────────────────
   WebSocket      →  ws.on('close') fires
   Heartbeat      →  heartbeat.stop() (clear interval)
   GenServer      →  GenServer.stop(ref, 'normal')
   terminate()    →  unsubscribe all store + rules subscriptions
   terminate()    →  ws.close(1000, 'normal_closure')
   Registry       →  connection removed (GenServer unregistered)
```

</details>

## Summary

- Each WebSocket connection is managed by its own `ConnectionServer` GenServer
- The `ConnectionSupervisor` uses `simple_one_for_one` with `temporary` restart — crashed connections are cleaned up, never restarted
- Connection state (auth, subscriptions, heartbeat) is fully isolated per-connection
- The request pipeline: parse → auth check → rate limit → route → respond
- `terminate()` ensures all subscriptions are cleaned up and the WebSocket is properly closed
- WebSocket errors are always followed by close events — cleanup happens once

---

Next: [Connection Registry](./02-registry.md)
