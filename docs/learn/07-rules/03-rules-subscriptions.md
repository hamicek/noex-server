# Rules Subscriptions

Subscribe to events matching a topic pattern and receive push messages when rules fire.

## What You'll Learn

- `rules.subscribe` — subscribe with a topic pattern
- Push messages on the `event` channel
- `rules.unsubscribe` — cancel a subscription
- Difference between store subscriptions and rules subscriptions
- Subscription cleanup on disconnect

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'rules-sub-demo' });
const rules = await RuleEngine.start({ name: 'rules-sub-demo' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

## rules.subscribe

Subscribe to events matching a topic pattern. Returns a `subscriptionId` used to identify push messages and to unsubscribe later:

```jsonc
→ { "id": 1, "type": "rules.subscribe", "pattern": "order.*" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-abc123" } }
```

**Required fields:**
- `pattern` — non-empty string (supports wildcards like `order.*`, `*`)

### Push Messages

When an event matches your subscription pattern, the server sends a push message on the `event` channel:

```jsonc
// Another client (or server-side code) emits an event
→ { "id": 2, "type": "rules.emit",
    "topic": "order.created",
    "data": { "orderId": "123", "total": 59.99 } }

// Your subscription receives a push:
← { "type": "push",
    "channel": "event",
    "subscriptionId": "sub-abc123",
    "data": {
      "topic": "order.created",
      "event": {
        "id": "evt-...",
        "topic": "order.created",
        "data": { "orderId": "123", "total": 59.99 },
        "timestamp": 1706745600000,
        "source": "api"
      }
    } }
```

**Push message structure:**
- `type` — always `"push"`
- `channel` — always `"event"` for rules subscriptions
- `subscriptionId` — the ID returned by `rules.subscribe`
- `data.topic` — the event topic that matched
- `data.event` — the full event object

### Pattern Matching

Topic patterns use `.` as a segment separator and `*` as a wildcard:

| Pattern | Matches | Does NOT Match |
|---------|---------|----------------|
| `order.*` | `order.created`, `order.shipped` | `order.item.added` |
| `order.created` | `order.created` | `order.shipped` |
| `*` | `login`, `logout` | `order.created` |

## rules.unsubscribe

Cancel an active subscription:

```jsonc
→ { "id": 3, "type": "rules.unsubscribe", "subscriptionId": "sub-abc123" }
← { "id": 3, "type": "result", "data": { "unsubscribed": true } }
```

Unsubscribing a non-existent subscription returns `NOT_FOUND`:

```jsonc
→ { "id": 4, "type": "rules.unsubscribe", "subscriptionId": "sub-nonexistent" }
← { "id": 4, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-nonexistent\" not found" }
```

## Store vs Rules Subscriptions

| | Store Subscriptions | Rules Subscriptions |
|---|---|---|
| **Subscribe** | `store.subscribe` (query name) | `rules.subscribe` (topic pattern) |
| **Unsubscribe** | `store.unsubscribe` | `rules.unsubscribe` |
| **Push channel** | `"subscription"` | `"event"` |
| **Triggered by** | Data changes in store | Events emitted into the engine |
| **Push data** | Query result (updated data) | `{ topic, event }` |

Both types of subscriptions share the same per-connection limit (default: 100, configurable via `connectionLimits.maxSubscriptionsPerConnection`).

## Subscription Limits

Each connection has a combined limit for store + rules subscriptions:

```jsonc
// After reaching the limit (default: 100)
→ { "id": 5, "type": "rules.subscribe", "pattern": "alerts.*" }
← { "id": 5, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 100 per connection)" }
```

## Cleanup on Disconnect

When a client disconnects, all its rules subscriptions are automatically cleaned up. The engine stops delivering events to those subscriptions — no manual cleanup required.

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `VALIDATION_ERROR` | `pattern` or `subscriptionId` missing or invalid |
| `NOT_FOUND` | Subscription not found (on unsubscribe) |
| `RATE_LIMITED` | Per-connection subscription limit exceeded |
| `RULES_NOT_AVAILABLE` | Engine not configured |

## Working Example

```typescript
// Subscribe to all order events
const subResp = await sendRequest(ws, {
  type: 'rules.subscribe',
  pattern: 'order.*',
});
const subId = subResp.data.subscriptionId;

// Set up push listener BEFORE emitting
const pushPromise = waitForPush(ws, subId);

// Emit an event (could be from another client)
await sendRequest(ws, {
  type: 'rules.emit',
  topic: 'order.created',
  data: { orderId: '123' },
});

// Receive the push
const push = await pushPromise;
console.log(push.channel);          // "event"
console.log(push.data.topic);       // "order.created"
console.log(push.data.event.data);  // { orderId: "123" }

// Clean up
await sendRequest(ws, {
  type: 'rules.unsubscribe',
  subscriptionId: subId,
});
```

## Exercise

Write a multi-client scenario where:
1. Client A subscribes to `payment.*`
2. Client B emits a `payment.received` event with `{ amount: 100 }`
3. Client A receives the push and verifies the amount
4. Client A unsubscribes

<details>
<summary>Solution</summary>

```jsonc
// Client A: subscribe
→ { "id": 1, "type": "rules.subscribe", "pattern": "payment.*" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-a1" } }

// Client B: emit event
→ { "id": 1, "type": "rules.emit",
    "topic": "payment.received",
    "data": { "amount": 100 } }
← { "id": 1, "type": "result",
    "data": { "id": "evt-...", "topic": "payment.received", ... } }

// Client A: receives push
← { "type": "push",
    "channel": "event",
    "subscriptionId": "sub-a1",
    "data": {
      "topic": "payment.received",
      "event": {
        "id": "evt-...",
        "topic": "payment.received",
        "data": { "amount": 100 },
        "timestamp": ...,
        "source": "api"
      }
    } }

// Client A: unsubscribe
→ { "id": 2, "type": "rules.unsubscribe", "subscriptionId": "sub-a1" }
← { "id": 2, "type": "result", "data": { "unsubscribed": true } }
```

</details>

## Summary

- `rules.subscribe` takes a topic `pattern` and returns a `subscriptionId`
- Push messages arrive on the `"event"` channel with `{ topic, event }` data
- `rules.unsubscribe` cancels a subscription — returns `NOT_FOUND` for unknown IDs
- Store subscriptions use channel `"subscription"`, rules use `"event"`
- Both types share the per-connection subscription limit
- Subscriptions are automatically cleaned up on disconnect

---

Next: [Token Authentication](../08-authentication/01-token-auth.md)
