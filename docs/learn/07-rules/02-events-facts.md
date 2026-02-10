# Events and Facts

Emit events and manage facts in the rules engine over the WebSocket protocol.

## What You'll Learn

- `rules.emit` — emit events with optional correlation
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` — fact CRUD
- `rules.queryFacts` — query facts by pattern with wildcards
- `rules.getAllFacts` — retrieve all facts
- `rules.stats` — engine statistics

## Server Setup

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'events-facts-demo' });
const rules = await RuleEngine.start({ name: 'events-facts-demo' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

## rules.emit

Emit an event into the rules engine. The engine processes the event against registered rules and returns the created event object.

```jsonc
→ { "id": 1, "type": "rules.emit",
    "topic": "order.created",
    "data": { "orderId": "abc", "total": 99.90 } }

← { "id": 1, "type": "result",
    "data": {
      "id": "evt-...",
      "topic": "order.created",
      "data": { "orderId": "abc", "total": 99.90 },
      "timestamp": 1706745600000,
      "source": "api"
    } }
```

**Required fields:**
- `topic` — non-empty string

**Optional fields:**
- `data` — object (default: `{}`)
- `correlationId` — non-empty string for event correlation
- `causationId` — non-empty string (only used when `correlationId` is present)

### Correlated Events

Use `correlationId` to link related events together:

```jsonc
→ { "id": 2, "type": "rules.emit",
    "topic": "payment.received",
    "data": { "amount": 99.90 },
    "correlationId": "order-abc",
    "causationId": "evt-original" }

← { "id": 2, "type": "result",
    "data": {
      "id": "evt-...",
      "topic": "payment.received",
      "data": { "amount": 99.90 },
      "timestamp": 1706745600000,
      "correlationId": "order-abc",
      "causationId": "evt-original",
      "source": "api"
    } }
```

### Validation

| Condition | Error Code |
|-----------|-----------|
| `topic` missing or empty | `VALIDATION_ERROR` |
| `data` is not an object (array, null, string...) | `VALIDATION_ERROR` |
| `correlationId` is not a non-empty string | `VALIDATION_ERROR` |

## rules.setFact

Set a fact in the engine's working memory. Returns a `Fact` object with metadata:

```jsonc
→ { "id": 3, "type": "rules.setFact",
    "key": "user:123:status",
    "value": "active" }

← { "id": 3, "type": "result",
    "data": {
      "key": "user:123:status",
      "value": "active",
      "timestamp": 1706745600000,
      "source": "api",
      "version": 1
    } }
```

**Required fields:**
- `key` — non-empty string
- `value` — any value (string, number, boolean, object, array, null)

Setting the same key again updates the value and increments the version:

```jsonc
→ { "id": 4, "type": "rules.setFact",
    "key": "user:123:status",
    "value": "inactive" }

← { "id": 4, "type": "result",
    "data": {
      "key": "user:123:status",
      "value": "inactive",
      "timestamp": 1706745600001,
      "source": "api",
      "version": 2
    } }
```

## rules.getFact

Retrieve a single fact by key. Returns the fact value, or `null` if the key doesn't exist:

```jsonc
→ { "id": 5, "type": "rules.getFact", "key": "user:123:status" }
← { "id": 5, "type": "result", "data": "active" }

// Non-existent key
→ { "id": 6, "type": "rules.getFact", "key": "user:999:status" }
← { "id": 6, "type": "result", "data": null }
```

## rules.deleteFact

Delete a fact by key. Returns `{ deleted: true }` if the fact existed, `{ deleted: false }` otherwise:

```jsonc
→ { "id": 7, "type": "rules.deleteFact", "key": "user:123:status" }
← { "id": 7, "type": "result", "data": { "deleted": true } }

// Already deleted
→ { "id": 8, "type": "rules.deleteFact", "key": "user:123:status" }
← { "id": 8, "type": "result", "data": { "deleted": false } }
```

## rules.queryFacts

Query facts using a pattern with wildcards. The `:` character is the segment separator and `*` matches a single segment:

```jsonc
// Set some facts first
→ { "id": 9,  "type": "rules.setFact", "key": "user:1:name", "value": "Alice" }
→ { "id": 10, "type": "rules.setFact", "key": "user:1:role", "value": "admin" }
→ { "id": 11, "type": "rules.setFact", "key": "user:2:name", "value": "Bob" }
→ { "id": 12, "type": "rules.setFact", "key": "config:theme", "value": "dark" }

// Query all user names
→ { "id": 13, "type": "rules.queryFacts", "pattern": "user:*:name" }
← { "id": 13, "type": "result",
    "data": [
      { "key": "user:1:name", "value": "Alice", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:2:name", "value": "Bob", "timestamp": ..., "source": "api", "version": 1 }
    ] }

// Query all facts for user:1
→ { "id": 14, "type": "rules.queryFacts", "pattern": "user:1:*" }
← { "id": 14, "type": "result",
    "data": [
      { "key": "user:1:name", "value": "Alice", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:1:role", "value": "admin", "timestamp": ..., "source": "api", "version": 1 }
    ] }
```

### Pattern Matching Rules

| Pattern | Matches | Does NOT Match |
|---------|---------|----------------|
| `user:*` | `user:1`, `user:abc` | `user:1:name` |
| `user:*:name` | `user:1:name`, `user:2:name` | `user:1`, `user:1:role` |
| `user:1:*` | `user:1:name`, `user:1:role` | `user:2:name` |
| `*` | `config`, `theme` | `user:1`, `user:1:name` |

**Key insight:** `*` matches exactly one segment between `:` separators.

## rules.getAllFacts

Retrieve all facts in the engine. Returns an array of full `Fact` objects:

```jsonc
→ { "id": 15, "type": "rules.getAllFacts" }
← { "id": 15, "type": "result",
    "data": [
      { "key": "user:1:name", "value": "Alice", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:1:role", "value": "admin", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:2:name", "value": "Bob", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "config:theme", "value": "dark", "timestamp": ..., "source": "api", "version": 1 }
    ] }
```

Returns an empty array when no facts exist.

## rules.stats

Get engine statistics:

```jsonc
→ { "id": 16, "type": "rules.stats" }
← { "id": 16, "type": "result",
    "data": {
      "rulesCount": 5,
      "factsCount": 4,
      "timersCount": 0,
      "eventsProcessed": 12,
      "rulesExecuted": 8,
      "avgProcessingTimeMs": 0.45,
      "tracing": { "enabled": false, "entriesCount": 0, "maxEntries": 1000 }
    } }
```

## Error Codes

| Error Code | Cause |
|-----------|-------|
| `VALIDATION_ERROR` | Missing or invalid field (topic, key, value, pattern, data, correlationId) |
| `RULES_NOT_AVAILABLE` | Engine not configured or not running |
| `INTERNAL_ERROR` | Unexpected engine error |

## Working Example

```typescript
// Emit an event
const emitResp = await sendRequest(ws, {
  type: 'rules.emit',
  topic: 'user.registered',
  data: { userId: 'u1', email: 'alice@example.com' },
});
console.log(emitResp.data.id); // "evt-..."

// Set facts about the user
await sendRequest(ws, {
  type: 'rules.setFact',
  key: 'user:u1:name',
  value: 'Alice',
});
await sendRequest(ws, {
  type: 'rules.setFact',
  key: 'user:u1:role',
  value: 'admin',
});

// Query all facts for user u1
const factsResp = await sendRequest(ws, {
  type: 'rules.queryFacts',
  pattern: 'user:u1:*',
});
console.log(factsResp.data.map((f: any) => ({ key: f.key, value: f.value })));
// [{ key: "user:u1:name", value: "Alice" }, { key: "user:u1:role", value: "admin" }]

// Clean up
await sendRequest(ws, { type: 'rules.deleteFact', key: 'user:u1:name' });
await sendRequest(ws, { type: 'rules.deleteFact', key: 'user:u1:role' });
```

## Exercise

Write a sequence of WebSocket messages that:
1. Sets facts for two products: `product:1:price` = 29.99 and `product:2:price` = 49.99
2. Queries all product prices using the pattern `product:*:price`
3. Emits a `catalog.updated` event with the number of products
4. Retrieves the engine stats to verify the event was processed

<details>
<summary>Solution</summary>

```jsonc
// 1. Set product prices
→ { "id": 1, "type": "rules.setFact", "key": "product:1:price", "value": 29.99 }
← { "id": 1, "type": "result",
    "data": { "key": "product:1:price", "value": 29.99, "timestamp": ..., "source": "api", "version": 1 } }

→ { "id": 2, "type": "rules.setFact", "key": "product:2:price", "value": 49.99 }
← { "id": 2, "type": "result",
    "data": { "key": "product:2:price", "value": 49.99, "timestamp": ..., "source": "api", "version": 1 } }

// 2. Query all product prices
→ { "id": 3, "type": "rules.queryFacts", "pattern": "product:*:price" }
← { "id": 3, "type": "result",
    "data": [
      { "key": "product:1:price", "value": 29.99, "timestamp": ..., "source": "api", "version": 1 },
      { "key": "product:2:price", "value": 49.99, "timestamp": ..., "source": "api", "version": 1 }
    ] }

// 3. Emit catalog event
→ { "id": 4, "type": "rules.emit",
    "topic": "catalog.updated",
    "data": { "productCount": 2 } }
← { "id": 4, "type": "result",
    "data": { "id": "evt-...", "topic": "catalog.updated", "data": { "productCount": 2 }, ... } }

// 4. Check stats
→ { "id": 5, "type": "rules.stats" }
← { "id": 5, "type": "result",
    "data": { "rulesCount": 0, "factsCount": 2, "eventsProcessed": 1, ... } }
```

</details>

## Summary

- `rules.emit` creates events in the engine — returns the full event object with `id` and `timestamp`
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` manage individual facts by key
- `rules.queryFacts` uses `:` as segment separator — `*` matches exactly one segment
- `rules.getAllFacts` returns all facts as full `Fact` objects (key, value, timestamp, source, version)
- `rules.stats` provides engine statistics (rules count, facts count, events processed)
- All operations return `RULES_NOT_AVAILABLE` if the engine is not configured

---

Next: [Rules Subscriptions](./03-rules-subscriptions.md)
