# Nastavení

Připojte noex-rules engine k serveru a zpřístupněte eventy, fakta a subscriptions přes WebSocket.

## Co se naučíte

- Jak nainstalovat a nakonfigurovat rules engine se serverem
- Volba `rules` v `ServerConfig`
- Co se stane, když klient pošle `rules.*` požadavek bez nakonfigurovaného enginu
- Error kód `RULES_NOT_AVAILABLE`

## Instalace noex-rules

Rules engine je volitelná peer dependency:

```bash
npm install @hamicek/noex-rules
```

## Nastavení serveru

Předejte běžící instanci `RuleEngine` do `NoexServer.start()`:

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
  rules,   // ← předejte engine zde
  port: 8080,
});
```

To je vše. Když je `rules` v konfiguraci, všechny `rules.*` operace jsou dostupné přes protokol.

## Architektura

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│  WebSocket   │──────▶│  noex-server │──────▶│  noex-rules │
│  Klient      │◀──────│  (proxy)     │◀──────│  (engine)   │
└─────────────┘       └──────────────┘       └─────────────┘
                           │
                           ▼
                      ┌──────────────┐
                      │  noex-store  │
                      └──────────────┘
```

Server funguje jako proxy — validuje příchozí `rules.*` požadavky, přeposílá je enginu a vrací výsledky. Push zprávy z rules subscriptions jsou doručovány na kanálu `event`.

## Bez rules

Když `rules` **nejsou** předány do `NoexServer.start()`, jakýkoli `rules.*` požadavek vrátí chybu `RULES_NOT_AVAILABLE`:

```jsonc
→ { "id": 1, "type": "rules.emit", "topic": "order.created", "data": {} }

← { "id": 1, "type": "error",
    "code": "RULES_NOT_AVAILABLE",
    "message": "Rule engine is not configured" }
```

Toto platí pro všechny `rules.*` operace: `emit`, `setFact`, `getFact`, `deleteFact`, `queryFacts`, `getAllFacts`, `subscribe`, `unsubscribe` a `stats`.

## Dostupné operace

Jakmile je engine nakonfigurován, tyto operace jsou dostupné:

| Operace | Popis |
|---------|-------|
| `rules.emit` | Emitování eventu do enginu |
| `rules.setFact` | Nastavení hodnoty faktu |
| `rules.getFact` | Získání faktu podle klíče |
| `rules.deleteFact` | Smazání faktu podle klíče |
| `rules.queryFacts` | Dotaz na fakta podle patternu |
| `rules.getAllFacts` | Získání všech faktů |
| `rules.subscribe` | Přihlášení k odběru eventů podle patternu |
| `rules.unsubscribe` | Zrušení odběru |
| `rules.stats` | Statistiky enginu |

## Cvičení

Nastavte server se store i rules enginem. Připojte WebSocket klienta a ověřte, že:
1. `rules.stats` vrátí výsledek (engine je dostupný)
2. Po odebrání `rules` z konfigurace `rules.stats` vrátí `RULES_NOT_AVAILABLE`

<details>
<summary>Řešení</summary>

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

// S rules
const store = await Store.start({ name: 'test' });
const rules = await RuleEngine.start({ name: 'test' });
const server = await NoexServer.start({ store, rules, port: 8080 });
```

```jsonc
// rules.stats funguje
→ { "id": 1, "type": "rules.stats" }
← { "id": 1, "type": "result",
    "data": { "rulesCount": 0, "factsCount": 0, "eventsProcessed": 0, ... } }
```

```typescript
// Bez rules
const server2 = await NoexServer.start({ store, port: 8081 });
```

```jsonc
// rules.stats selže
→ { "id": 1, "type": "rules.stats" }
← { "id": 1, "type": "error",
    "code": "RULES_NOT_AVAILABLE",
    "message": "..." }
```

</details>

## Shrnutí

- Nainstalujte `@hamicek/noex-rules` a předejte instanci `RuleEngine` do `NoexServer.start({ rules })`
- Server proxuje všechny `rules.*` požadavky na engine
- Bez enginu všechny `rules.*` požadavky vrátí `RULES_NOT_AVAILABLE`
- K dispozici je devět operací: emit, setFact, getFact, deleteFact, queryFacts, getAllFacts, subscribe, unsubscribe, stats

---

Další: [Eventy a fakta](./02-eventy-a-fakta.md)
