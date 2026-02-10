# Rules Operations

Operations on the rule engine exposed over the WebSocket protocol. Each operation is a `ClientRequest` with a `type` starting with `rules.`. Requires a `RuleEngine` instance to be configured on the server (`rules` option in `ServerConfig`).

If no rule engine is configured, all `rules.*` operations return `RULES_NOT_AVAILABLE`.

---

## Events

### rules.emit

Emits an event on a topic. Returns the event object created by the rule engine.

**Request:**

```json
{
  "id": 1,
  "type": "rules.emit",
  "topic": "order.created",
  "data": { "orderId": "ORD-001", "total": 99 }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| topic | `string` | yes | Event topic (e.g., `"order.created"`). |
| data | `object` | no | Event payload. Defaults to `{}` if omitted. |
| correlationId | `string` | no | Correlation ID for event tracing. When provided, `emitCorrelated` is used instead of `emit`. |
| causationId | `string` | no | Causation ID (only used when `correlationId` is present). |

**Response:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "id": "evt-abc123",
    "topic": "order.created",
    "data": { "orderId": "ORD-001", "total": 99 },
    "timestamp": 1700000000000
  }
}
```

**Response (correlated):**

```json
{
  "id": 2,
  "type": "result",
  "data": {
    "id": "evt-def456",
    "topic": "payment.received",
    "data": { "amount": 50 },
    "timestamp": 1700000000000,
    "correlationId": "corr-001"
  }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `topic`, invalid `data` type, or invalid `correlationId`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

## Facts

### rules.setFact

Sets a fact in the rule engine's fact store. Returns the fact object with key and value.

**Request:**

```json
{
  "id": 3,
  "type": "rules.setFact",
  "key": "user:1:name",
  "value": "Alice"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | `string` | yes | Fact key. Segments separated by `:` (e.g., `"user:1:name"`). |
| value | `unknown` | yes | Fact value. Any JSON-serializable value. Must not be `undefined`. |

**Response:**

```json
{
  "id": 3,
  "type": "result",
  "data": { "key": "user:1:name", "value": "Alice" }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `key` or `value`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

### rules.getFact

Retrieves a fact by key. Returns the fact value, or `null` if the key does not exist.

**Request:**

```json
{
  "id": 4,
  "type": "rules.getFact",
  "key": "user:1:name"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | `string` | yes | Fact key. |

**Response (found):**

```json
{
  "id": 4,
  "type": "result",
  "data": "Alice"
}
```

**Response (not found):**

```json
{
  "id": 4,
  "type": "result",
  "data": null
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `key`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

### rules.deleteFact

Deletes a fact by key. Returns `{ deleted: true }` if the fact existed, `{ deleted: false }` otherwise.

**Request:**

```json
{
  "id": 5,
  "type": "rules.deleteFact",
  "key": "user:1:name"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | `string` | yes | Fact key. |

**Response (existed):**

```json
{
  "id": 5,
  "type": "result",
  "data": { "deleted": true }
}
```

**Response (did not exist):**

```json
{
  "id": 5,
  "type": "result",
  "data": { "deleted": false }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `key`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

### rules.queryFacts

Queries facts by a glob-like pattern. The `:` character is the segment separator — `*` matches a single segment.

- `user:*:name` matches `user:1:name`, `user:2:name`, but not `user:1` or `user:1:name:extra`.
- `user:*` matches `user:1`, `user:2`, but not `user:1:name`.
- `*` matches all top-level keys.

**Request:**

```json
{
  "id": 6,
  "type": "rules.queryFacts",
  "pattern": "user:*:name"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| pattern | `string` | yes | Glob pattern with `:` as segment separator. |

**Response:**

```json
{
  "id": 6,
  "type": "result",
  "data": [
    { "key": "user:1:name", "value": "Alice" },
    { "key": "user:2:name", "value": "Bob" }
  ]
}
```

Returns an empty array `[]` when no facts match.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `pattern`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

### rules.getAllFacts

Returns all facts in the rule engine.

**Request:**

```json
{
  "id": 7,
  "type": "rules.getAllFacts"
}
```

No additional fields required.

**Response:**

```json
{
  "id": 7,
  "type": "result",
  "data": [
    { "key": "user:1:name", "value": "Alice" },
    { "key": "system:version", "value": "1.0" }
  ]
}
```

Returns an empty array `[]` when no facts exist.

**Errors:**

| Code | Cause |
|------|-------|
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

## Subscriptions

### rules.subscribe

Subscribes to events matching a topic pattern. Returns a `subscriptionId`. When a matching event is emitted, the server sends a `PushMessage` on channel `"event"`.

**Request:**

```json
{
  "id": 8,
  "type": "rules.subscribe",
  "pattern": "order.*"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| pattern | `string` | yes | Topic pattern. `*` matches any single topic segment (e.g., `order.*` matches `order.created`). |

**Response:**

```json
{
  "id": 8,
  "type": "result",
  "data": { "subscriptionId": "sub-1" }
}
```

Unlike `store.subscribe`, rules subscriptions do not return initial data — there is no initial state to provide.

### Push Format

When a matching event is emitted, the server sends:

```json
{
  "type": "push",
  "channel": "event",
  "subscriptionId": "sub-1",
  "data": {
    "topic": "order.created",
    "event": {
      "id": "evt-abc123",
      "topic": "order.created",
      "data": { "orderId": "ORD-001" },
      "timestamp": 1700000000000
    }
  }
}
```

The push `data` contains:
- `topic` — the event topic that matched the pattern.
- `event` — the full event object.

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `pattern`. |
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

### rules.unsubscribe

Cancels an active rules subscription.

**Request:**

```json
{
  "id": 9,
  "type": "rules.unsubscribe",
  "subscriptionId": "sub-1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| subscriptionId | `string` | yes | The subscription ID returned by `rules.subscribe`. |

**Response:**

```json
{
  "id": 9,
  "type": "result",
  "data": { "unsubscribed": true }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `VALIDATION_ERROR` | Missing `subscriptionId`. |
| `NOT_FOUND` | Subscription does not exist (already unsubscribed or invalid ID). |

---

## Subscription Cleanup

Rules subscriptions are automatically cleaned up when the client disconnects, just like store subscriptions.

---

## Stats

### rules.stats

Returns rule engine statistics.

**Request:**

```json
{
  "id": 10,
  "type": "rules.stats"
}
```

No additional fields required.

**Response:**

```json
{
  "id": 10,
  "type": "result",
  "data": {
    "rulesCount": 5,
    "factsCount": 12,
    "eventsProcessed": 42
  }
}
```

**Errors:**

| Code | Cause |
|------|-------|
| `RULES_NOT_AVAILABLE` | No rule engine configured. |

---

## See Also

- [Store Operations](./04-store-operations.md) — Store CRUD and queries
- [Store Subscriptions](./05-store-subscriptions.md) — Store subscriptions and transactions
- [Protocol](./03-protocol.md) — PushMessage format
- [Errors](./10-errors.md) — Error codes
- [Configuration](./02-configuration.md) — `rules` option in ServerConfig
