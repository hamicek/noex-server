# Rules subscriptions

Přihlaste se k odběru eventů odpovídajících topic patternu a přijímejte push zprávy při vyhodnocení pravidel.

## Co se naučíte

- `rules.subscribe` — odběr s topic patternem
- Push zprávy na kanálu `event`
- `rules.unsubscribe` — zrušení odběru
- Rozdíl mezi store subscriptions a rules subscriptions
- Cleanup subscriptions při odpojení

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'rules-sub-demo' });
const rules = await RuleEngine.start({ name: 'rules-sub-demo' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

## rules.subscribe

Přihlásí se k odběru eventů odpovídajících topic patternu. Vrátí `subscriptionId` pro identifikaci push zpráv a pozdější odhlášení:

```jsonc
→ { "id": 1, "type": "rules.subscribe", "pattern": "order.*" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-abc123" } }
```

**Povinná pole:**
- `pattern` — neprázdný string (podporuje wildcardy jako `order.*`, `*`)

### Push zprávy

Když event odpovídá vašemu patternu, server pošle push zprávu na kanálu `event`:

```jsonc
// Jiný klient (nebo kód na serveru) emituje event
→ { "id": 2, "type": "rules.emit",
    "topic": "order.created",
    "data": { "orderId": "123", "total": 59.99 } }

// Váš odběr obdrží push:
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

**Struktura push zprávy:**
- `type` — vždy `"push"`
- `channel` — vždy `"event"` pro rules subscriptions
- `subscriptionId` — ID vrácené z `rules.subscribe`
- `data.topic` — topic eventu, který odpovídal
- `data.event` — plný event objekt

### Pattern matching

Topic patterny používají `.` jako oddělovač segmentů a `*` jako wildcard:

| Pattern | Odpovídá | Neodpovídá |
|---------|----------|------------|
| `order.*` | `order.created`, `order.shipped` | `order.item.added` |
| `order.created` | `order.created` | `order.shipped` |
| `*` | `login`, `logout` | `order.created` |

## rules.unsubscribe

Zruší aktivní odběr:

```jsonc
→ { "id": 3, "type": "rules.unsubscribe", "subscriptionId": "sub-abc123" }
← { "id": 3, "type": "result", "data": { "unsubscribed": true } }
```

Odhlášení neexistujícího odběru vrátí `NOT_FOUND`:

```jsonc
→ { "id": 4, "type": "rules.unsubscribe", "subscriptionId": "sub-nonexistent" }
← { "id": 4, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-nonexistent\" not found" }
```

## Store vs rules subscriptions

| | Store subscriptions | Rules subscriptions |
|---|---|---|
| **Přihlášení** | `store.subscribe` (název dotazu) | `rules.subscribe` (topic pattern) |
| **Odhlášení** | `store.unsubscribe` | `rules.unsubscribe` |
| **Push kanál** | `"subscription"` | `"event"` |
| **Spouštěč** | Změny dat ve store | Eventy emitované do enginu |
| **Push data** | Výsledek dotazu (aktualizovaná data) | `{ topic, event }` |

Oba typy subscriptions sdílejí stejný limit na připojení (výchozí: 100, konfigurovatelný přes `connectionLimits.maxSubscriptionsPerConnection`).

## Limity subscriptions

Každé připojení má kombinovaný limit pro store + rules subscriptions:

```jsonc
// Po dosažení limitu (výchozí: 100)
→ { "id": 5, "type": "rules.subscribe", "pattern": "alerts.*" }
← { "id": 5, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 100 per connection)" }
```

## Cleanup při odpojení

Když se klient odpojí, všechny jeho rules subscriptions jsou automaticky uklideny. Engine přestane doručovat eventy do těchto subscriptions — není potřeba ruční cleanup.

## Kódy chyb

| Kód chyby | Příčina |
|-----------|---------|
| `VALIDATION_ERROR` | `pattern` nebo `subscriptionId` chybí nebo je neplatný |
| `NOT_FOUND` | Subscription nenalezena (při odhlášení) |
| `RATE_LIMITED` | Překročen limit subscriptions na připojení |
| `RULES_NOT_AVAILABLE` | Engine není nakonfigurován |

## Praktický příklad

```typescript
// Přihlášení k odběru všech order eventů
const subResp = await sendRequest(ws, {
  type: 'rules.subscribe',
  pattern: 'order.*',
});
const subId = subResp.data.subscriptionId;

// Nastavení push listeneru PŘED emitováním
const pushPromise = waitForPush(ws, subId);

// Emitování eventu (může být z jiného klienta)
await sendRequest(ws, {
  type: 'rules.emit',
  topic: 'order.created',
  data: { orderId: '123' },
});

// Příjem push zprávy
const push = await pushPromise;
console.log(push.channel);          // "event"
console.log(push.data.topic);       // "order.created"
console.log(push.data.event.data);  // { orderId: "123" }

// Úklid
await sendRequest(ws, {
  type: 'rules.unsubscribe',
  subscriptionId: subId,
});
```

## Cvičení

Napište multi-klient scénář, kde:
1. Klient A se přihlásí k odběru `payment.*`
2. Klient B emituje event `payment.received` s `{ amount: 100 }`
3. Klient A obdrží push a ověří částku
4. Klient A se odhlásí z odběru

<details>
<summary>Řešení</summary>

```jsonc
// Klient A: přihlášení k odběru
→ { "id": 1, "type": "rules.subscribe", "pattern": "payment.*" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-a1" } }

// Klient B: emitování eventu
→ { "id": 1, "type": "rules.emit",
    "topic": "payment.received",
    "data": { "amount": 100 } }
← { "id": 1, "type": "result",
    "data": { "id": "evt-...", "topic": "payment.received", ... } }

// Klient A: příjem push zprávy
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

// Klient A: odhlášení
→ { "id": 2, "type": "rules.unsubscribe", "subscriptionId": "sub-a1" }
← { "id": 2, "type": "result", "data": { "unsubscribed": true } }
```

</details>

## Shrnutí

- `rules.subscribe` přijímá topic `pattern` a vrací `subscriptionId`
- Push zprávy přicházejí na kanálu `"event"` s daty `{ topic, event }`
- `rules.unsubscribe` zruší odběr — vrátí `NOT_FOUND` pro neznámá ID
- Store subscriptions používají kanál `"subscription"`, rules používají `"event"`
- Oba typy sdílejí limit subscriptions na připojení
- Subscriptions jsou automaticky uklideny při odpojení

---

Další: [Autentizace tokenem](../../08-autentizace/01-autentizace-tokenem.md)
