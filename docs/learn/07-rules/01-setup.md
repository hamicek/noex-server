# Setup

Connect the noex-rules engine to the server and expose events, facts, and subscriptions over WebSocket.

## What You'll Learn

- How to install and configure the rules engine with the server
- The `rules` option in `ServerConfig`
- What happens when a client sends a `rules.*` request without the engine configured
- The `RULES_NOT_AVAILABLE` error code

## Installing noex-rules

The rules engine is an optional peer dependency:

```bash
npm install @hamicek/noex-rules
```

## Server Setup

Pass a running `RuleEngine` instance to `NoexServer.start()`:

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'rules-demo' });

store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    status: { type: 'string', default: 'pending' },
    total:  { type: 'number', default: 0 },
  },
});

const rules = await RuleEngine.start({ name: 'rules-demo' });

const server = await NoexServer.start({
  store,
  rules,   // ← pass the engine here
  port: 8080,
});
```

That's it. When `rules` is present in the config, all `rules.*` operations become available over the protocol.

## Architecture

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│  WebSocket   │──────▶│  noex-server │──────▶│  noex-rules │
│  Client      │◀──────│  (proxy)     │◀──────│  (engine)   │
└─────────────┘       └──────────────┘       └─────────────┘
                           │
                           ▼
                      ┌──────────────┐
                      │  noex-store  │
                      └──────────────┘
```

The server acts as a proxy — it validates incoming `rules.*` requests, forwards them to the engine, and returns results. Push messages from rule subscriptions are delivered on the `event` channel.

## Without Rules

When `rules` is **not** passed to `NoexServer.start()`, any `rules.*` request returns the `RULES_NOT_AVAILABLE` error:

```jsonc
→ { "id": 1, "type": "rules.emit", "topic": "order.created", "data": {} }

← { "id": 1, "type": "error",
    "code": "RULES_NOT_AVAILABLE",
    "message": "Rule engine is not configured" }
```

This applies to all `rules.*` operations: `emit`, `setFact`, `getFact`, `deleteFact`, `queryFacts`, `getAllFacts`, `subscribe`, `unsubscribe`, and `stats`.

## Available Operations

Once the engine is configured, these operations are available:

| Operation | Description |
|-----------|-------------|
| `rules.emit` | Emit an event into the engine |
| `rules.setFact` | Set a fact value |
| `rules.getFact` | Get a fact by key |
| `rules.deleteFact` | Delete a fact by key |
| `rules.queryFacts` | Query facts by pattern |
| `rules.getAllFacts` | Get all facts |
| `rules.subscribe` | Subscribe to events by pattern |
| `rules.unsubscribe` | Cancel a subscription |
| `rules.stats` | Get engine statistics |

## Exercise

Set up a server with both a store and a rules engine. Connect a WebSocket client and verify that:
1. `rules.stats` returns a result (engine is available)
2. After removing `rules` from the config, `rules.stats` returns `RULES_NOT_AVAILABLE`

<details>
<summary>Solution</summary>

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

// With rules
const store = await Store.start({ name: 'test' });
const rules = await RuleEngine.start({ name: 'test' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

```jsonc
// rules.stats works
→ { "id": 1, "type": "rules.stats" }
← { "id": 1, "type": "result",
    "data": { "rulesCount": 0, "factsCount": 0, "eventsProcessed": 0, ... } }
```

```typescript
// Without rules
const server2 = await NoexServer.start({ store, port: 8081 });
```

```jsonc
// rules.stats fails
→ { "id": 1, "type": "rules.stats" }
← { "id": 1, "type": "error",
    "code": "RULES_NOT_AVAILABLE",
    "message": "..." }
```

</details>

## Summary

- Install `@hamicek/noex-rules` and pass a `RuleEngine` instance to `NoexServer.start({ rules })`
- The server proxies all `rules.*` requests to the engine
- Without the engine, all `rules.*` requests return `RULES_NOT_AVAILABLE`
- Nine operations are available: emit, setFact, getFact, deleteFact, queryFacts, getAllFacts, subscribe, unsubscribe, stats

---

Next: [Events and Facts](./02-events-facts.md)
