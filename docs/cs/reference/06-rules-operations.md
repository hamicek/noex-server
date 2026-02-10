# Rules operace

Operace rule enginu zpřístupněné přes WebSocket protokol. Každá operace je `ClientRequest` s `type` začínajícím `rules.`. Vyžaduje instanci `RuleEngine` nakonfigurovanou na serveru (volba `rules` v `ServerConfig`).

Pokud není nakonfigurován žádný rule engine, všechny `rules.*` operace vrátí `RULES_NOT_AVAILABLE`.

---

## Události

### rules.emit

Vyšle událost na téma. Vrátí objekt události vytvořený rule enginem.

**Požadavek:**

```json
{
  "id": 1,
  "type": "rules.emit",
  "topic": "order.created",
  "data": { "orderId": "ORD-001", "total": 99 }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| topic | `string` | ano | Téma události (např. `"order.created"`). |
| data | `object` | ne | Payload události. Výchozí `{}`, pokud je vynecháno. |
| correlationId | `string` | ne | Korelační ID pro trasování událostí. Pokud je uvedeno, použije se `emitCorrelated` místo `emit`. |
| causationId | `string` | ne | ID příčiny (použije se pouze společně s `correlationId`). |

**Odpověď:**

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

**Odpověď (korelovaná):**

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

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `topic`, neplatný typ `data` nebo neplatné `correlationId`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

## Fakta

### rules.setFact

Nastaví fakt v úložišti faktů rule enginu. Vrátí objekt faktu s klíčem a hodnotou.

**Požadavek:**

```json
{
  "id": 3,
  "type": "rules.setFact",
  "key": "user:1:name",
  "value": "Alice"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| key | `string` | ano | Klíč faktu. Segmenty odděleny `:` (např. `"user:1:name"`). |
| value | `unknown` | ano | Hodnota faktu. Jakákoliv JSON-serializovatelná hodnota. Nesmí být `undefined`. |

**Odpověď:**

```json
{
  "id": 3,
  "type": "result",
  "data": { "key": "user:1:name", "value": "Alice" }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `key` nebo `value`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

### rules.getFact

Načte fakt podle klíče. Vrátí hodnotu faktu, nebo `null`, pokud klíč neexistuje.

**Požadavek:**

```json
{
  "id": 4,
  "type": "rules.getFact",
  "key": "user:1:name"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| key | `string` | ano | Klíč faktu. |

**Odpověď (nalezeno):**

```json
{
  "id": 4,
  "type": "result",
  "data": "Alice"
}
```

**Odpověď (nenalezeno):**

```json
{
  "id": 4,
  "type": "result",
  "data": null
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `key`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

### rules.deleteFact

Smaže fakt podle klíče. Vrátí `{ deleted: true }`, pokud fakt existoval, `{ deleted: false }` jinak.

**Požadavek:**

```json
{
  "id": 5,
  "type": "rules.deleteFact",
  "key": "user:1:name"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| key | `string` | ano | Klíč faktu. |

**Odpověď (existoval):**

```json
{
  "id": 5,
  "type": "result",
  "data": { "deleted": true }
}
```

**Odpověď (neexistoval):**

```json
{
  "id": 5,
  "type": "result",
  "data": { "deleted": false }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `key`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

### rules.queryFacts

Dotazuje fakta podle glob vzoru. Znak `:` je oddělovač segmentů — `*` odpovídá jednomu segmentu.

- `user:*:name` odpovídá `user:1:name`, `user:2:name`, ale ne `user:1` ani `user:1:name:extra`.
- `user:*` odpovídá `user:1`, `user:2`, ale ne `user:1:name`.
- `*` odpovídá všem klíčům nejvyšší úrovně.

**Požadavek:**

```json
{
  "id": 6,
  "type": "rules.queryFacts",
  "pattern": "user:*:name"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| pattern | `string` | ano | Glob vzor s `:` jako oddělovačem segmentů. |

**Odpověď:**

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

Vrátí prázdné pole `[]`, pokud žádné fakty neodpovídají.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `pattern`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

### rules.getAllFacts

Vrátí všechny fakty v rule enginu.

**Požadavek:**

```json
{
  "id": 7,
  "type": "rules.getAllFacts"
}
```

Žádná další pole nejsou vyžadována.

**Odpověď:**

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

Vrátí prázdné pole `[]`, pokud žádné fakty neexistují.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

## Subscriptions

### rules.subscribe

Přihlásí se k odběru událostí odpovídajících vzoru tématu. Vrátí `subscriptionId`. Když je vyslána odpovídající událost, server odešle `PushMessage` na kanálu `"event"`.

**Požadavek:**

```json
{
  "id": 8,
  "type": "rules.subscribe",
  "pattern": "order.*"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| pattern | `string` | ano | Vzor tématu. `*` odpovídá jednomu segmentu tématu (např. `order.*` odpovídá `order.created`). |

**Odpověď:**

```json
{
  "id": 8,
  "type": "result",
  "data": { "subscriptionId": "sub-1" }
}
```

Na rozdíl od `store.subscribe`, rules subscriptions nevracejí počáteční data — neexistuje počáteční stav, který by se dal poskytnout.

### Formát push zprávy

Když je vyslána odpovídající událost, server odešle:

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

Push `data` obsahuje:
- `topic` — téma události, které odpovídá vzoru.
- `event` — kompletní objekt události.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `pattern`. |
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

### rules.unsubscribe

Zruší aktivní rules subscription.

**Požadavek:**

```json
{
  "id": 9,
  "type": "rules.unsubscribe",
  "subscriptionId": "sub-1"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| subscriptionId | `string` | ano | ID subscription vrácené z `rules.subscribe`. |

**Odpověď:**

```json
{
  "id": 9,
  "type": "result",
  "data": { "unsubscribed": true }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `subscriptionId`. |
| `NOT_FOUND` | Subscription neexistuje (již odhlášena nebo neplatné ID). |

---

## Úklid subscriptions

Rules subscriptions se automaticky vyčistí, když se klient odpojí, stejně jako store subscriptions.

---

## Statistiky

### rules.stats

Vrátí statistiky rule enginu.

**Požadavek:**

```json
{
  "id": 10,
  "type": "rules.stats"
}
```

Žádná další pole nejsou vyžadována.

**Odpověď:**

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

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `RULES_NOT_AVAILABLE` | Není nakonfigurován rule engine. |

---

## Viz také

- [Store operace](./04-store-operations.md) — Store CRUD a dotazy
- [Store subscriptions](./05-store-subscriptions.md) — Store subscriptions a transakce
- [Protokol](./03-protocol.md) — Formát PushMessage
- [Chyby](./10-errors.md) — Chybové kódy
- [Konfigurace](./02-configuration.md) — Volba `rules` v ServerConfig
