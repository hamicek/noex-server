# Heartbeat

Detect dead connections with server-initiated ping/pong messages. Clients that fail to respond to a ping within the next interval are closed with code `4001`.

## What You'll Learn

- `HeartbeatConfig` — `intervalMs` and `timeoutMs`
- The ping/pong protocol: `{ type: "ping", timestamp }` / `{ type: "pong", timestamp }`
- Timeout detection — close code `4001` (`heartbeat_timeout`)
- Default configuration (30s interval, 10s timeout)
- Only unresponsive connections are closed — others are unaffected

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'heartbeat-demo' });

store.defineBucket('data', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    value: { type: 'number', required: true },
  },
});

const server = await NoexServer.start({
  store,
  port: 8080,
  heartbeat: {
    intervalMs: 30_000,  // Send ping every 30 seconds
    timeoutMs: 10_000,   // (reserved for future use)
  },
});
```

## HeartbeatConfig

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;  // Ping interval in ms (default: 30_000)
  readonly timeoutMs: number;   // Reserved for future use (default: 10_000)
}
```

- **`intervalMs`** — how often the server sends a ping to each connection
- **`timeoutMs`** — currently reserved; the effective timeout equals one `intervalMs` cycle

**Defaults:**

```typescript
{
  intervalMs: 30_000,  // 30 seconds
  timeoutMs: 10_000,   // 10 seconds
}
```

Heartbeat is always enabled — there is no way to disable it. You can set a very large `intervalMs` to make it effectively inactive.

## The Ping/Pong Protocol

### Server Sends Ping

Every `intervalMs`, the server sends a ping to each connection:

```jsonc
← { "type": "ping", "timestamp": 1706745600000 }
```

The `timestamp` is `Date.now()` at the time the ping was sent.

### Client Responds with Pong

The client must respond with a pong containing the same timestamp:

```jsonc
→ { "type": "pong", "timestamp": 1706745600000 }
```

**Note:** The pong message does not require an `id` field — it is the only client message that doesn't use request/response correlation.

## Timeout Detection

On each heartbeat tick, the server checks:

1. Was a ping sent since the last pong? (`lastPingAt > 0 && lastPongAt < lastPingAt`)
2. If yes → the client didn't respond → close with code `4001`
3. If no → send a new ping

```
Tick 1: No previous ping → send ping
        ← { "type": "ping", "timestamp": T1 }

        Client responds:
        → { "type": "pong", "timestamp": T1 }

Tick 2: Pong received (lastPongAt ≥ lastPingAt) → send new ping
        ← { "type": "ping", "timestamp": T2 }

        Client does NOT respond...

Tick 3: No pong since T2 (lastPongAt < lastPingAt) → CLOSE 4001
        WebSocket closed with code 4001, reason "heartbeat_timeout"
```

The effective timeout window is one `intervalMs` cycle. If the client responds to a ping any time before the next tick, the connection stays alive.

## Close Code 4001

When a client fails to respond to a ping, the server closes the connection with:

- **Code:** `4001` (custom WebSocket close code)
- **Reason:** `"heartbeat_timeout"`

```
Client ← close(4001, "heartbeat_timeout")
```

The `4001` code is in the private use range (4000–4999), safe for application-specific signals.

## Selective Closure

Only the unresponsive connection is closed. Other connections are unaffected:

```
Connection A: responds to pings ──▶ stays alive ✓
Connection B: silent (no pong)  ──▶ closed with 4001 ✗
Connection C: responds to pings ──▶ stays alive ✓
```

After Connection B is closed, Connections A and C continue working normally.

## Delayed Pong

The client does not need to respond instantly. A pong sent any time before the next tick is accepted:

```
intervalMs: 150ms

Tick 1 (t=0ms):    ← ping { timestamp: T1 }
Client (t=100ms):  → pong { timestamp: T1 }   // 100ms delay — OK
Tick 2 (t=150ms):  lastPongAt > lastPingAt → send new ping ✓
```

As long as the pong arrives before the next heartbeat tick, the connection stays alive.

## Connection Remains Functional

Heartbeat operates independently from request/response. After multiple heartbeat exchanges, the connection is fully functional:

```jsonc
// Heartbeat exchange happens in the background
← { "type": "ping", "timestamp": 1706745600000 }
→ { "type": "pong", "timestamp": 1706745600000 }

// Client can still send requests at any time
→ { "id": 5, "type": "store.insert", "bucket": "data",
    "data": { "value": 42 } }
← { "id": 5, "type": "result",
    "data": { "id": "abc-123", "value": 42 } }

// Another heartbeat exchange
← { "type": "ping", "timestamp": 1706745630000 }
→ { "type": "pong", "timestamp": 1706745630000 }
```

## Cleanup on Server Stop

When `server.stop()` is called, heartbeat timers are cleaned up automatically:
- The `ws.on('close')` handler calls `heartbeat.stop()` which clears the interval
- No more pings are sent after the connection closes

## Why Heartbeat?

WebSocket connections can die silently (network failure, client crash, NAT timeout). Without heartbeat:

| Problem | Without Heartbeat | With Heartbeat |
|---------|------------------|----------------|
| Client crashes | Server holds dead connection indefinitely | Detected in ~30s, connection cleaned up |
| Network drops | Subscriptions leak, resources wasted | Cleaned up after one missed pong |
| NAT timeout | Connection appears alive but is dead | Ping keeps NAT mapping active |

## Working Example

**Server:**

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  heartbeat: {
    intervalMs: 30_000,
    timeoutMs: 10_000,
  },
});
```

**Client with auto-pong:**

```typescript
const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'ping') {
    // Respond to keep the connection alive
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
    return;
  }

  // Handle other messages...
});

ws.on('close', (code, reason) => {
  if (code === 4001) {
    console.log('Connection closed: heartbeat timeout');
    // Reconnect logic here
  }
});
```

## Exercise

Describe what happens in the following scenario with `heartbeat: { intervalMs: 100, timeoutMs: 50 }`:
1. Client A connects and auto-responds to pings
2. Client B connects and does NOT respond to pings
3. After 250 ms, which clients are still connected?
4. Client A sends a `store.insert` — does it succeed?

<details>
<summary>Solution</summary>

```
Timeline with intervalMs: 100ms

t=0ms:     Client A and B connect, receive welcome messages

t=100ms:   Tick 1
           Server → Client A: ping { timestamp: T1 }
           Server → Client B: ping { timestamp: T1 }
           Client A → Server: pong { timestamp: T1 }  ✓
           Client B: (silent)

t=200ms:   Tick 2
           Client A: lastPongAt ≥ lastPingAt → send new ping ✓
           Client B: lastPongAt < lastPingAt → CLOSE 4001 ✗
           Server → Client A: ping { timestamp: T2 }
           Server closes Client B with code 4001, reason "heartbeat_timeout"

t=250ms:   State check
           Client A: connected ✓ (responded to pings)
           Client B: disconnected ✗ (closed at t=200ms)

           Client A sends store.insert:
           → { "id": 1, "type": "store.insert", "bucket": "data",
               "data": { "value": 42 } }
           ← { "id": 1, "type": "result",
               "data": { "id": "...", "value": 42 } }
           Success ✓ — heartbeat doesn't affect request handling
```

</details>

## Summary

- Heartbeat sends periodic `{ type: "ping", timestamp }` — clients must reply with `{ type: "pong", timestamp }`
- Default interval: 30 seconds — configurable via `heartbeat.intervalMs`
- Clients that miss one pong cycle are closed with code `4001` (`heartbeat_timeout`)
- Only unresponsive connections are closed — others are unaffected
- Pong does not need an `id` field — it's the only client message without request/response correlation
- Delayed pong is fine as long as it arrives before the next tick
- Heartbeat is always enabled — set a large `intervalMs` to effectively disable it
- Heartbeat keeps NAT mappings alive and detects silently dead connections

---

Next: [Backpressure](./03-backpressure.md)
