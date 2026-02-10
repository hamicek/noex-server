# Eventy a fakta

Emitujte eventy a spravujte fakta v rules enginu přes WebSocket protokol.

## Co se naučíte

- `rules.emit` — emitování eventů s volitelnou korelací
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` — CRUD faktů
- `rules.queryFacts` — dotazování faktů podle patternu s wildcardy
- `rules.getAllFacts` — získání všech faktů
- `rules.stats` — statistiky enginu

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'events-facts-demo' });
const rules = await RuleEngine.start({ name: 'events-facts-demo' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

## rules.emit

Emituje event do rules enginu. Engine zpracuje event oproti registrovaným pravidlům a vrátí vytvořený event objekt.

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

**Povinná pole:**
- `topic` — neprázdný string

**Volitelná pole:**
- `data` — objekt (výchozí: `{}`)
- `correlationId` — neprázdný string pro korelaci eventů
- `causationId` — neprázdný string (použit pouze pokud je přítomen `correlationId`)

### Korelované eventy

Použijte `correlationId` k propojení souvisejících eventů:

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

### Validace

| Podmínka | Kód chyby |
|----------|-----------|
| `topic` chybí nebo je prázdný | `VALIDATION_ERROR` |
| `data` není objekt (pole, null, string...) | `VALIDATION_ERROR` |
| `correlationId` není neprázdný string | `VALIDATION_ERROR` |

## rules.setFact

Nastaví fakt v pracovní paměti enginu. Vrátí objekt `Fact` s metadaty:

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

**Povinná pole:**
- `key` — neprázdný string
- `value` — jakákoli hodnota (string, number, boolean, objekt, pole, null)

Nastavení stejného klíče znovu aktualizuje hodnotu a zvýší verzi:

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

Získá jeden fakt podle klíče. Vrátí hodnotu faktu, nebo `null` pokud klíč neexistuje:

```jsonc
→ { "id": 5, "type": "rules.getFact", "key": "user:123:status" }
← { "id": 5, "type": "result", "data": "active" }

// Neexistující klíč
→ { "id": 6, "type": "rules.getFact", "key": "user:999:status" }
← { "id": 6, "type": "result", "data": null }
```

## rules.deleteFact

Smaže fakt podle klíče. Vrátí `{ deleted: true }` pokud fakt existoval, `{ deleted: false }` jinak:

```jsonc
→ { "id": 7, "type": "rules.deleteFact", "key": "user:123:status" }
← { "id": 7, "type": "result", "data": { "deleted": true } }

// Již smazáno
→ { "id": 8, "type": "rules.deleteFact", "key": "user:123:status" }
← { "id": 8, "type": "result", "data": { "deleted": false } }
```

## rules.queryFacts

Dotaz na fakta pomocí patternu s wildcardy. Znak `:` je oddělovač segmentů a `*` odpovídá jednomu segmentu:

```jsonc
// Nejprve nastavíme fakta
→ { "id": 9,  "type": "rules.setFact", "key": "user:1:name", "value": "Alice" }
→ { "id": 10, "type": "rules.setFact", "key": "user:1:role", "value": "admin" }
→ { "id": 11, "type": "rules.setFact", "key": "user:2:name", "value": "Bob" }
→ { "id": 12, "type": "rules.setFact", "key": "config:theme", "value": "dark" }

// Dotaz na všechna jména uživatelů
→ { "id": 13, "type": "rules.queryFacts", "pattern": "user:*:name" }
← { "id": 13, "type": "result",
    "data": [
      { "key": "user:1:name", "value": "Alice", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:2:name", "value": "Bob", "timestamp": ..., "source": "api", "version": 1 }
    ] }

// Dotaz na všechny fakty pro user:1
→ { "id": 14, "type": "rules.queryFacts", "pattern": "user:1:*" }
← { "id": 14, "type": "result",
    "data": [
      { "key": "user:1:name", "value": "Alice", "timestamp": ..., "source": "api", "version": 1 },
      { "key": "user:1:role", "value": "admin", "timestamp": ..., "source": "api", "version": 1 }
    ] }
```

### Pravidla pattern matching

| Pattern | Odpovídá | Neodpovídá |
|---------|----------|------------|
| `user:*` | `user:1`, `user:abc` | `user:1:name` |
| `user:*:name` | `user:1:name`, `user:2:name` | `user:1`, `user:1:role` |
| `user:1:*` | `user:1:name`, `user:1:role` | `user:2:name` |
| `*` | `config`, `theme` | `user:1`, `user:1:name` |

**Klíčový poznatek:** `*` odpovídá přesně jednomu segmentu mezi oddělovači `:`.

## rules.getAllFacts

Získá všechny fakty v enginu. Vrátí pole plných `Fact` objektů:

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

Vrátí prázdné pole, pokud žádné fakty neexistují.

## rules.stats

Statistiky enginu:

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

## Kódy chyb

| Kód chyby | Příčina |
|-----------|---------|
| `VALIDATION_ERROR` | Chybějící nebo neplatné pole (topic, key, value, pattern, data, correlationId) |
| `RULES_NOT_AVAILABLE` | Engine není nakonfigurován nebo neběží |
| `INTERNAL_ERROR` | Neočekávaná chyba enginu |

## Praktický příklad

```typescript
// Emitování eventu
const emitResp = await sendRequest(ws, {
  type: 'rules.emit',
  topic: 'user.registered',
  data: { userId: 'u1', email: 'alice@example.com' },
});
console.log(emitResp.data.id); // "evt-..."

// Nastavení faktů o uživateli
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

// Dotaz na všechny fakty pro uživatele u1
const factsResp = await sendRequest(ws, {
  type: 'rules.queryFacts',
  pattern: 'user:u1:*',
});
console.log(factsResp.data.map((f: any) => ({ key: f.key, value: f.value })));
// [{ key: "user:u1:name", value: "Alice" }, { key: "user:u1:role", value: "admin" }]

// Úklid
await sendRequest(ws, { type: 'rules.deleteFact', key: 'user:u1:name' });
await sendRequest(ws, { type: 'rules.deleteFact', key: 'user:u1:role' });
```

## Cvičení

Napište sekvenci WebSocket zpráv, která:
1. Nastaví fakta pro dva produkty: `product:1:price` = 29.99 a `product:2:price` = 49.99
2. Vyhledá všechny ceny produktů pomocí patternu `product:*:price`
3. Emituje event `catalog.updated` s počtem produktů
4. Získá statistiky enginu a ověří, že event byl zpracován

<details>
<summary>Řešení</summary>

```jsonc
// 1. Nastavení cen produktů
→ { "id": 1, "type": "rules.setFact", "key": "product:1:price", "value": 29.99 }
← { "id": 1, "type": "result",
    "data": { "key": "product:1:price", "value": 29.99, "timestamp": ..., "source": "api", "version": 1 } }

→ { "id": 2, "type": "rules.setFact", "key": "product:2:price", "value": 49.99 }
← { "id": 2, "type": "result",
    "data": { "key": "product:2:price", "value": 49.99, "timestamp": ..., "source": "api", "version": 1 } }

// 2. Dotaz na všechny ceny produktů
→ { "id": 3, "type": "rules.queryFacts", "pattern": "product:*:price" }
← { "id": 3, "type": "result",
    "data": [
      { "key": "product:1:price", "value": 29.99, "timestamp": ..., "source": "api", "version": 1 },
      { "key": "product:2:price", "value": 49.99, "timestamp": ..., "source": "api", "version": 1 }
    ] }

// 3. Emitování catalog eventu
→ { "id": 4, "type": "rules.emit",
    "topic": "catalog.updated",
    "data": { "productCount": 2 } }
← { "id": 4, "type": "result",
    "data": { "id": "evt-...", "topic": "catalog.updated", "data": { "productCount": 2 }, ... } }

// 4. Kontrola statistik
→ { "id": 5, "type": "rules.stats" }
← { "id": 5, "type": "result",
    "data": { "rulesCount": 0, "factsCount": 2, "eventsProcessed": 1, ... } }
```

</details>

## Shrnutí

- `rules.emit` vytváří eventy v enginu — vrací plný event objekt s `id` a `timestamp`
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` spravují jednotlivé fakty podle klíče
- `rules.queryFacts` používá `:` jako oddělovač segmentů — `*` odpovídá přesně jednomu segmentu
- `rules.getAllFacts` vrací všechny fakty jako plné `Fact` objekty (key, value, timestamp, source, version)
- `rules.stats` poskytuje statistiky enginu (počet pravidel, faktů, zpracovaných eventů)
- Všechny operace vrátí `RULES_NOT_AVAILABLE` pokud engine není nakonfigurován

---

Další: [Rules subscriptions](./03-rules-subscriptions.md)
