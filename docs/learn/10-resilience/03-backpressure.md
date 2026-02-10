# Backpressure

Handle slow clients without running out of memory. When a client's WebSocket write buffer exceeds the high water mark, push messages are silently dropped until the buffer drains.

## What You'll Learn

- `BackpressureConfig` — `maxBufferedBytes` and `highWaterMark`
- When backpressure activates — the threshold calculation
- What gets dropped (push messages only) and what's unaffected (request/response)
- Why dropped pushes don't cause data loss — only temporary staleness
- Default configuration (1 MB buffer, 80% threshold)

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'backpressure-demo' });

store.defineBucket('events', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    payload: { type: 'string', required: true },
  },
});

store.defineQuery('all-events', async (ctx) => ctx.bucket('events').all());

const server = await NoexServer.start({
  store,
  port: 8080,
  backpressure: {
    maxBufferedBytes: 1_048_576,  // 1 MB
    highWaterMark: 0.8,           // 80%
  },
});
```

## BackpressureConfig

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;  // Total buffer capacity (default: 1_048_576)
  readonly highWaterMark: number;     // Fraction 0.0–1.0 (default: 0.8)
}
```

- **`maxBufferedBytes`** — the maximum size of the WebSocket write buffer in bytes
- **`highWaterMark`** — the fraction of `maxBufferedBytes` at which push messages start being dropped

**Defaults:**

```typescript
{
  maxBufferedBytes: 1_048_576,  // 1 MB
  highWaterMark: 0.8,           // 80%
}
```

## Threshold Calculation

Backpressure activates when:

```
ws.bufferedAmount >= maxBufferedBytes × highWaterMark
```

With defaults:

```
threshold = 1_048_576 × 0.8 = 838,861 bytes
```

When the WebSocket's internal write buffer contains 838,861 or more bytes of pending data, push messages are dropped.

## What Gets Dropped

**Only push messages** (subscription updates) are dropped during backpressure:

```
                          Buffer < threshold     Buffer ≥ threshold
                          ─────────────────      ──────────────────
Request/Response          ✓ Always sent          ✓ Always sent
Push (subscription)       ✓ Sent normally        ✗ Silently dropped
Push (rules event)        ✓ Sent normally        ✗ Silently dropped
```

Request/response is never affected by backpressure. If a client sends `store.get`, it always gets a response regardless of buffer state.

## Why Dropping Pushes Is Safe

Reactive query subscriptions automatically resend data on the next state change. Dropping a push means the client has temporarily stale data, not permanently wrong data:

```
Mutation A → push "data = [1, 2, 3]"  ──▶ DROPPED (backpressured)
                                            Client still sees old data

Mutation B → push "data = [1, 2, 3, 4]" ──▶ Buffer drained → SENT ✓
                                            Client catches up
```

The next mutation that triggers the same subscription will send the complete, up-to-date result — the client skips intermediate states but always converges to the correct final state.

## How It Works Internally

When a push message arrives at the ConnectionServer GenServer:

```
Push message received
  │
  ▼
Check: ws.bufferedAmount >= threshold?
  │
  ├── No  → Send push to client
  │
  └── Yes → Drop push (no error, no notification)
```

The check is performed on every push. Once the buffer drains below the threshold, pushes resume automatically.

## Backpressure Scenarios

### Normal Operation (Buffer Empty)

```
Client is fast, buffer stays near 0

Store mutation → push "data = [A]" → bufferedAmount: 0    → SENT ✓
Store mutation → push "data = [A,B]" → bufferedAmount: 50 → SENT ✓
```

### Slow Client (Buffer Fills Up)

```
Client is slow, not reading fast enough

Store mutation → push 1 → bufferedAmount: 200,000  → SENT ✓
Store mutation → push 2 → bufferedAmount: 500,000  → SENT ✓
Store mutation → push 3 → bufferedAmount: 850,000  → DROPPED ✗ (≥ 838,861)
Store mutation → push 4 → bufferedAmount: 900,000  → DROPPED ✗
                          Client reads some data...
Store mutation → push 5 → bufferedAmount: 100,000  → SENT ✓ (back below threshold)
```

### Custom Threshold

Set `highWaterMark: 1.0` to only drop when the buffer is completely full:

```typescript
backpressure: {
  maxBufferedBytes: 2_097_152,  // 2 MB
  highWaterMark: 1.0,           // Only drop when buffer = 2 MB
}
```

Or use a lower mark for more aggressive dropping:

```typescript
backpressure: {
  maxBufferedBytes: 524_288,  // 512 KB
  highWaterMark: 0.5,         // Start dropping at 256 KB
}
```

## No Client Notification

When pushes are dropped, the client receives no error or warning. This is by design:

- The client is already slow (that's why backpressure kicked in)
- Sending more data to a slow client would make the problem worse
- The next successful push will contain the latest state

## Comparison with Rate Limiting

| Feature | Rate Limiting | Backpressure |
|---------|--------------|--------------|
| **What it limits** | Incoming requests | Outgoing push messages |
| **When it triggers** | Too many requests per window | WebSocket write buffer full |
| **Client sees** | `RATE_LIMITED` error | Nothing (push silently dropped) |
| **Affects** | All operations | Only push messages |
| **Recovery** | Wait `retryAfterMs` | Automatic (buffer drains) |

## Working Example

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  backpressure: {
    maxBufferedBytes: 1_048_576, // 1 MB
    highWaterMark: 0.8,          // Drop pushes at 80% buffer
  },
});

// A client subscribes to all-events
// → { "id": 1, "type": "store.subscribe", "query": "all-events" }
// ← { "id": 1, "type": "result",
//     "data": { "subscriptionId": "sub-1", "initialData": [] } }

// Rapid mutations trigger push updates:
// ← { "type": "push", "channel": "subscription",
//     "subscriptionId": "sub-1", "data": [...] }   ← SENT ✓

// If client can't keep up, buffer grows...
// Push messages start being dropped when buffer ≥ 838,861 bytes

// When client catches up, pushes resume automatically
// The next push contains the latest complete state
```

## Exercise

Given the following configuration:
```typescript
backpressure: { maxBufferedBytes: 100_000, highWaterMark: 0.5 }
```

1. What is the threshold at which pushes start being dropped?
2. A client has `ws.bufferedAmount = 49_999`. Is the next push sent or dropped?
3. A client has `ws.bufferedAmount = 50_000`. Is the next push sent or dropped?
4. If 3 pushes in a row are dropped and then the buffer drains, what data does the client get on the next push?

<details>
<summary>Solution</summary>

1. **Threshold:** `100_000 × 0.5 = 50_000 bytes`

2. **49,999 bytes:** Push is **sent** ✓
   `49_999 < 50_000` → below threshold

3. **50,000 bytes:** Push is **dropped** ✗
   `50_000 >= 50_000` → at or above threshold

4. **After buffer drains:** The client receives the **latest complete result** from the reactive query — not the 3 missed intermediate states. Reactive queries always send the full current state, so the client catches up in one push. No data is permanently lost.

</details>

## Summary

- Backpressure monitors `ws.bufferedAmount` against `maxBufferedBytes × highWaterMark`
- Default: 1 MB buffer, 80% threshold (838,861 bytes)
- Only push messages (subscriptions and events) are dropped — request/response is never affected
- Dropped pushes are silent — no error sent to the client
- Reactive queries naturally resend on the next mutation — the client converges to correct state
- No permanent data loss — only temporary staleness during backpressure
- Recovery is automatic — when the buffer drains, pushes resume

---

Next: [Test Setup](../11-testing/01-test-setup.md)
