# E-commerce backend

Stavba kompletního e-commerce backendu, který využívá každou feature noex-serveru: Store pro katalog produktů, objednávky a uživatelské účty; Rules pro zpracování eventů objednávek; Auth pro přístup zákazníků a adminů; a produkční konfigurace s rate limitingem, heartbeatem a backpressure. Toto je závěrečný projekt — vše, co jste se naučili, se spojí dohromady.

## Co se naučíte

- Multi-bucket návrh schématu pro produkty, objednávky, uživatele a audit logy
- Cross-bucket transakce pro atomické zadání objednávky (odečtení skladu, vytvoření objednávky, zalogování akce)
- Reaktivní subscriptions pro živý stav objednávek a dashboard inventáře
- Integrace Rules pro eventy životního cyklu objednávek a notifikace
- Kompletní nastavení auth s rolemi zákazníka a admina, oprávněními per-operace
- Produkční konfigurace: rate limiting, heartbeat, backpressure

## Přehled architektury

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                       E-Commerce Server                                  │
│                                                                          │
│  Store                                Rules                             │
│  ┌───────────────────────────────┐    ┌────────────────────────────┐    │
│  │ products                      │    │ Eventy:                    │    │
│  │   title, price, stock, active │    │   order.placed             │    │
│  │                               │    │   order.shipped            │    │
│  │ orders                        │    │   order.cancelled          │    │
│  │   userId, items, total,       │    │   inventory.low_stock      │    │
│  │   status, createdAt           │    │                            │    │
│  │                               │    │ Fakty:                     │    │
│  │ users                         │    │   order:<id>:status        │    │
│  │   name, email, role, credits  │    │   product:<id>:reserved    │    │
│  │                               │    └────────────────────────────┘    │
│  │ audit-logs                    │                                      │
│  │   action, userId, details,    │    Auth                              │
│  │   timestamp                   │    ┌────────────────────────────┐    │
│  └───────────────────────────────┘    │ customer → čtení produktů, │    │
│                                       │   vlastní objednávky,      │    │
│  Dotazy                               │   zadání objednávky        │    │
│  ┌───────────────────────────────┐    │ admin → plný přístup,      │    │
│  │ product-catalog               │    │   správa produktů, expedice│    │
│  │ user-orders(userId)           │    └────────────────────────────┘    │
│  │ order-count(userId)           │                                      │
│  │ low-stock-products            │    Odolnost                          │
│  │ recent-orders                 │    ┌────────────────────────────┐    │
│  └───────────────────────────────┘    │ Rate limit: 100 req/min   │    │
│                                       │ Heartbeat: 30s / 10s      │    │
│                                       │ Backpressure: 1 MB / 0.8  │    │
│                                       └────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Kompletní nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';
import type { AuthSession } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'ecommerce' });
  const engine = await RuleEngine.start({ name: 'ecommerce-rules' });

  // ── Buckety ─────────────────────────────────────────────────────

  await store.defineBucket('products', {
    key: 'id',
    schema: {
      id:     { type: 'string', generated: 'uuid' },
      title:  { type: 'string', required: true },
      price:  { type: 'number', required: true },
      stock:  { type: 'number', default: 0 },
      active: { type: 'boolean', default: true },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      userId:    { type: 'string', required: true },
      items:     { type: 'string', required: true }, // JSON-encoded pole
      total:     { type: 'number', required: true },
      status:    { type: 'string', default: 'pending' },
      createdAt: { type: 'number', required: true },
    },
  });

  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      name:    { type: 'string', required: true },
      email:   { type: 'string', required: true },
      role:    { type: 'string', default: 'customer' },
      credits: { type: 'number', default: 0 },
    },
  });

  await store.defineBucket('audit-logs', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      action:    { type: 'string', required: true },
      userId:    { type: 'string', required: true },
      details:   { type: 'string', default: '' },
      timestamp: { type: 'number', required: true },
    },
  });

  // ── Dotazy ─────────────────────────────────────────────────────

  store.defineQuery('product-catalog', async (ctx) => {
    return ctx.bucket('products').where({ active: true });
  });

  store.defineQuery('user-orders', async (ctx, params: { userId: string }) => {
    return ctx.bucket('orders').where({ userId: params.userId });
  });

  store.defineQuery('order-count', async (ctx, params: { userId: string }) => {
    return ctx.bucket('orders').count({ userId: params.userId });
  });

  store.defineQuery('low-stock-products', async (ctx) => {
    // Vrací všechny produkty — filtrování pro stock < 10 na straně klienta
    // V produkci byste použili sofistikovanější dotaz
    return ctx.bucket('products').all();
  });

  store.defineQuery('recent-orders', async (ctx) => {
    return ctx.bucket('orders').last(20);
  });

  // ── Auth + Oprávnění ──────────────────────────────────────────

  // V produkci by validate ověřoval JWT nebo volal auth službu
  const sessions: Record<string, AuthSession> = {
    'customer-token-alice': {
      userId: 'user-alice',
      roles: ['customer'],
    },
    'customer-token-bob': {
      userId: 'user-bob',
      roles: ['customer'],
    },
    'admin-token': {
      userId: 'admin-1',
      roles: ['admin'],
    },
  };

  const ADMIN_ONLY_OPS = new Set([
    'store.clear',
    'store.delete',  // pouze admini mohou mazat produkty/objednávky
  ]);

  const CUSTOMER_ALLOWED_BUCKETS = new Set([
    'products', // čtení
    'orders',   // čtení vlastních + zadání nových
  ]);

  const server = await NoexServer.start({
    port: 8080,
    store,
    rules: engine,
    auth: {
      validate: async (token) => sessions[token] ?? null,
      permissions: {
        check: (session, operation, resource) => {
          // Admini mohou vše
          if (session.roles.includes('admin')) return true;

          // Admin-only operace
          if (ADMIN_ONLY_OPS.has(operation)) return false;

          // Zákazníci mají přístup pouze k povoleným bucketům
          if (operation.startsWith('store.') && !CUSTOMER_ALLOWED_BUCKETS.has(resource)) {
            // Povolení audit-logs pro insert pouze (přes transakce)
            if (resource === 'audit-logs' && operation === 'store.transaction') return true;
            return false;
          }

          return true;
        },
      },
    },

    // ── Produkční odolnost ───────────────────────────────────

    rateLimit: {
      maxRequests: 100,
      windowMs: 60_000,   // 100 požadavků za minutu na uživatele
    },
    heartbeat: {
      intervalMs: 30_000,  // ping každých 30 sekund
      timeoutMs: 10_000,   // zavřít pokud bez pong do 10 sekund
    },
    backpressure: {
      maxBufferedBytes: 1_048_576,  // 1 MB
      highWaterMark: 0.8,           // pozastavit push při 80%
    },
  });

  console.log(`E-Commerce server naslouchá na ws://localhost:${server.port}`);
  console.log(`Auth: zapnuto, Rate limit: 100/min, Heartbeat: 30s`);
}

main();
```

## Interakce klientů: Kompletní flow objednávky

### Krok 1: Připojení a autentizace

```jsonc
// Server → Klient (při připojení)
{ "type": "welcome", "version": "1.0.0", "serverTime": 1706745600000, "requiresAuth": true }

// Zákaznice Alice se autentizuje
// Alice → Server
{ "id": 1, "type": "auth.login", "token": "customer-token-alice" }

// Server → Alice
{ "id": 1, "type": "result", "data": { "userId": "user-alice", "roles": ["customer"] } }
```

### Krok 2: Procházení produktů

```jsonc
// Alice → Server (přihlášení k živému katalogu produktů)
{ "id": 2, "type": "store.subscribe", "query": "product-catalog" }

// Server → Alice (počáteční katalog)
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "data": [
    { "id": "prod-1", "title": "Wireless Keyboard", "price": 79.99, "stock": 25, "active": true, "_version": 1 },
    { "id": "prod-2", "title": "USB-C Hub", "price": 45.00, "stock": 50, "active": true, "_version": 1 },
    { "id": "prod-3", "title": "Laptop Stand", "price": 120.00, "stock": 3, "active": true, "_version": 1 }
  ] }
}
```

### Krok 3: Zadání objednávky (cross-bucket transakce)

Alice objednává Wireless Keyboard. Transakce atomicky:
1. Aktualizuje sklad produktu
2. Vytvoří záznam objednávky
3. Zapíše audit log

```jsonc
// Alice → Server
{ "id": 3, "type": "store.transaction", "operations": [
    { "op": "update", "bucket": "products", "key": "prod-1",
      "data": { "stock": 24 } },
    { "op": "insert", "bucket": "orders", "data": {
        "userId": "user-alice",
        "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]",
        "total": 79.99,
        "status": "pending",
        "createdAt": 1706745700000
      }
    },
    { "op": "insert", "bucket": "audit-logs", "data": {
        "action": "order_placed",
        "userId": "user-alice",
        "details": "Wireless Keyboard x1",
        "timestamp": 1706745700000
      }
    }
  ]
}

// Server → Alice
{ "id": 3, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "prod-1", "title": "Wireless Keyboard",
        "price": 79.99, "stock": 24, "active": true, "_version": 2 } },
    { "index": 1, "data": { "id": "order-1", "userId": "user-alice",
        "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]",
        "total": 79.99, "status": "pending", "createdAt": 1706745700000, "_version": 1 } },
    { "index": 2, "data": { "id": "log-1", "action": "order_placed",
        "userId": "user-alice", "details": "Wireless Keyboard x1",
        "timestamp": 1706745700000, "_version": 1 } }
  ] }
}
```

Pokud jakákoli operace selže (např. produkt neexistuje, chyba validace), celá transakce se rollbackne — sklad zůstane na 25, objednávka se nevytvoří, log se nezapíše.

### Krok 4: Emitování eventu objednávky (Rules)

Po úspěchu transakce emitujte event objednávky pro downstream zpracování:

```jsonc
// Alice → Server
{ "id": 4, "type": "rules.emit", "topic": "order.placed", "data": {
    "orderId": "order-1", "userId": "user-alice", "total": 79.99
  }
}

// Server → Alice
{ "id": 4, "type": "result", "data": {
    "id": "evt-1", "topic": "order.placed", "timestamp": 1706745700500,
    "data": { "orderId": "order-1", "userId": "user-alice", "total": 79.99 }
  }
}
```

### Krok 5: Přihlášení ke stavu objednávky

Alice se přihlásí k seznamu svých objednávek pro živé aktualizace stavu:

```jsonc
// Alice → Server
{ "id": 5, "type": "store.subscribe", "query": "user-orders",
  "params": { "userId": "user-alice" } }

// Server → Alice (počáteční: jedna pending objednávka)
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-2", "data": [
    { "id": "order-1", "userId": "user-alice", "total": 79.99,
      "status": "pending", "createdAt": 1706745700000, "_version": 1,
      "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
  ] }
}
```

### Krok 6: Admin expeduje objednávku

Admin se autentizuje a aktualizuje stav objednávky:

```jsonc
// Admin → Server
{ "id": 1, "type": "auth.login", "token": "admin-token" }

// Server → Admin
{ "id": 1, "type": "result", "data": { "userId": "admin-1", "roles": ["admin"] } }

// Admin → Server (aktualizace stavu objednávky)
{ "id": 2, "type": "store.update", "bucket": "orders", "key": "order-1",
  "data": { "status": "shipped" } }

// Server → Admin
{ "id": 2, "type": "result", "data": { "id": "order-1", "userId": "user-alice",
    "total": 79.99, "status": "shipped", "createdAt": 1706745700000, "_version": 2,
    "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
}
```

Subscription Alice obdrží push s aktualizovaným seznamem objednávek:

```jsonc
// Server → Alice (push — stav objednávky změněn na "shipped")
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "order-1", "userId": "user-alice", "total": 79.99,
      "status": "shipped", "createdAt": 1706745700000, "_version": 2,
      "items": "[{\"productId\":\"prod-1\",\"quantity\":1,\"price\":79.99}]" }
  ]
}
```

Admin emituje event expedice:

```jsonc
// Admin → Server
{ "id": 3, "type": "rules.emit", "topic": "order.shipped", "data": {
    "orderId": "order-1", "userId": "user-alice"
  }
}
```

### Krok 7: Sledování stavu objednávky přes Rules fakty

Použijte fakty pro rychlé vyhledání stavu bez dotazování Store:

```jsonc
// Admin → Server (nastavení faktu pro stav objednávky)
{ "id": 4, "type": "rules.setFact", "key": "order:order-1:status", "value": "shipped" }

// Server → Admin
{ "id": 4, "type": "result", "data": { "key": "order:order-1:status", "value": "shipped" } }
```

Jakýkoli klient se může dotázat na stavy objednávek:

```jsonc
// Alice → Server
{ "id": 6, "type": "rules.queryFacts", "pattern": "order:*:status" }

// Server → Alice
{ "id": 6, "type": "result", "data": [
    { "key": "order:order-1:status", "value": "shipped" }
  ]
}
```

### Krok 8: Admin se přihlásí k eventům objednávek

```jsonc
// Admin → Server
{ "id": 5, "type": "rules.subscribe", "pattern": "order.*" }

// Server → Admin
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-3" } }
```

Nyní když jakýkoli klient emituje eventy objednávek, admin obdrží push:

```jsonc
// Server → Admin (push když novou objednávku zadá jakýkoli zákazník)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "order.placed",
    "event": {
      "id": "evt-2", "topic": "order.placed", "timestamp": 1706745800000,
      "data": { "orderId": "order-2", "userId": "user-bob", "total": 45.00 }
    }
  }
}
```

### Krok 9: Vynucení oprávnění

Zákazník zkouší admin-only operaci:

```jsonc
// Alice → Server (pokus smazat produkt)
{ "id": 7, "type": "store.delete", "bucket": "products", "key": "prod-1" }

// Server → Alice
{ "id": 7, "type": "error", "code": "FORBIDDEN",
  "message": "No permission for store.delete on products" }
```

```jsonc
// Alice → Server (pokus přistoupit k bucketu users)
{ "id": 8, "type": "store.all", "bucket": "users" }

// Server → Alice
{ "id": 8, "type": "error", "code": "FORBIDDEN",
  "message": "No permission for store.all on users" }
```

### Krok 10: Rate limiting v akci

Pokud klient pošle příliš mnoho požadavků:

```jsonc
// Po 100 požadavcích za minutu...

// Alice → Server
{ "id": 101, "type": "store.all", "bucket": "products" }

// Server → Alice
{ "id": 101, "type": "error", "code": "RATE_LIMITED",
  "message": "Rate limit exceeded. Retry after 15000ms", "details": { "retryAfterMs": 15000 } }
```

### Krok 11: Whoami a odhlášení

```jsonc
// Alice → Server (kontrola session)
{ "id": 9, "type": "auth.whoami" }

// Server → Alice
{ "id": 9, "type": "result", "data": {
    "authenticated": true, "userId": "user-alice", "roles": ["customer"]
  }
}

// Alice → Server (odhlášení)
{ "id": 10, "type": "auth.logout" }

// Server → Alice
{ "id": 10, "type": "result", "data": { "loggedOut": true } }

// Alice → Server (požadavek po odhlášení)
{ "id": 11, "type": "store.all", "bucket": "products" }

// Server → Alice
{ "id": 11, "type": "error", "code": "UNAUTHORIZED", "message": "Authentication required" }
```

## Podrobný rozbor

### Cross-bucket transakce

Transakce zadání objednávky je nejkritičtější operace. Přesahuje tři buckety:

```text
Transakce: Zadání objednávky
  ┌─────────────────────────────────────────────────────┐
  │ 1. UPDATE products  SET stock = stock - quantity     │
  │ 2. INSERT orders    (userId, items, total, status)   │
  │ 3. INSERT audit-logs (action, userId, timestamp)     │
  │                                                       │
  │ Při selhání: VŠECHNY tři operace se rollbacknou      │
  └─────────────────────────────────────────────────────┘
```

Bez transakcí by selhání mezi operacemi mohlo nechat systém v nekonzistentním stavu — sklad snížen, ale objednávka nevytvořena. Transakce garantuje sémantiku vše-nebo-nic.

### Návrh oprávnění

Systém oprávnění používá vrstvený přístup:

| Role | Produkty | Objednávky | Uživatelé | Audit logy | Rules |
|------|----------|------------|-----------|------------|-------|
| admin | plný přístup | plný přístup | plný přístup | plný přístup | plný přístup |
| customer | pouze čtení | čtení vlastních + insert | bez přístupu | insert přes tx | emit + subscribe |

Funkce `check` přijímá `(session, operation, resource)`, kde `resource` je název bucketu. To umožňuje implementovat jemné řízení přístupu bez middleware frameworku.

### Produkční konfigurace

Tři features odolnosti chrání server v produkci:

| Feature | Konfigurace | Co dělá |
|---------|-------------|---------|
| Rate limiting | `100 req/min` | Prevence zneužití; klíč je `userId` při autentizaci, IP jinak |
| Heartbeat | `30s interval, 10s timeout` | Detekce mrtvých spojení; zavření s kódem `4001` pokud bez pong |
| Backpressure | `1 MB buffer, 0.8 high water mark` | Pozastavení push zpráv pomalým klientům při 80% využití bufferu |

Tyto spolupracují: rate limiting zabraňuje záplavám požadavků, heartbeat čistí neaktivní spojení a backpressure zabraňuje vyčerpání paměti pomalými WebSocket konzumenty.

### Reaktivní dashboard objednávek

Admin se může přihlásit k `recent-orders` pro živý dashboard:

```jsonc
// Admin → Server
{ "id": 6, "type": "store.subscribe", "query": "recent-orders" }

// Server → Admin (počáteční: posledních 20 objednávek)
{ "id": 6, "type": "result", "data": { "subscriptionId": "sub-4", "data": [...] } }
```

Pokaždé, když jakýkoli zákazník zadá objednávku, subscription admina obdrží push s aktualizovaným seznamem objednávek. V kombinaci s `rules.subscribe` na `order.*` admin vidí jak persistentní stav (záznamy objednávek), tak event stream (eventy objednávek) v reálném čase.

### Statistiky serveru

Monitoring serveru v produkci:

```typescript
const stats = await server.getStats();
// {
//   name: 'ecommerce',
//   port: 8080,
//   connectionCount: 42,
//   uptimeMs: 3600000,
//   authEnabled: true,
//   rateLimitEnabled: true,
//   rulesEnabled: true,
//   connections: {
//     active: 42,
//     authenticated: 40,
//     totalStoreSubscriptions: 85,
//     totalRulesSubscriptions: 12,
//   },
//   store: { ... },
//   rules: { ... },
// }
```

### Elegantní ukončení

Zastavení serveru s grace period pro odpojení klientů:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

Server:
1. Odešle zprávu `{ type: "system", event: "shutdown", gracePeriodMs: 5000 }` všem klientům
2. Přestane přijímat nová spojení
3. Čeká až 5 sekund na dobrovolné odpojení klientů
4. Zavře zbývající spojení a vyčistí všechny subscriptions

## Cvičení

Rozšiřte e-commerce backend o:

1. Event `inventory.low_stock` emitovaný přes rules, když sklad produktu klesne pod 5 po objednávce
2. Admin subscription k `inventory.*` eventům pro alerty skladu
3. Flow „zrušení objednávky": admin aktualizuje stav objednávky na „cancelled", obnoví sklad produktu přes transakci, emituje event `order.cancelled`

<details>
<summary>Řešení</summary>

**Alert nízkého skladu po zadání objednávky:**

```jsonc
// Po úspěchu transakce objednávky zkontrolujte, zda je sklad nízký:
// (Aplikační logika — klient kontroluje výsledek transakce)

// Pokud stock < 5, emitujte alert:
// Admin/Systém → Server
{ "id": 20, "type": "rules.emit", "topic": "inventory.low_stock", "data": {
    "productId": "prod-3", "title": "Laptop Stand", "currentStock": 2
  }
}
```

**Admin se přihlásí k alertům inventáře:**

```jsonc
// Admin → Server
{ "id": 7, "type": "rules.subscribe", "pattern": "inventory.*" }

// Server → Admin
{ "id": 7, "type": "result", "data": { "subscriptionId": "sub-5" } }

// Když se spustí event nízkého skladu:
// Server → Admin (push)
{ "type": "push", "channel": "event", "subscriptionId": "sub-5", "data": {
    "topic": "inventory.low_stock",
    "event": {
      "id": "evt-3", "topic": "inventory.low_stock", "timestamp": 1706745900000,
      "data": { "productId": "prod-3", "title": "Laptop Stand", "currentStock": 2 }
    }
  }
}
```

**Flow zrušení objednávky (transakce):**

```jsonc
// Admin → Server (atomicky: obnovení skladu + aktualizace objednávky + log)
{ "id": 8, "type": "store.transaction", "operations": [
    { "op": "update", "bucket": "products", "key": "prod-1",
      "data": { "stock": 25 } },
    { "op": "update", "bucket": "orders", "key": "order-1",
      "data": { "status": "cancelled" } },
    { "op": "insert", "bucket": "audit-logs", "data": {
        "action": "order_cancelled",
        "userId": "admin-1",
        "details": "Objednávka order-1 zrušena, sklad obnoven",
        "timestamp": 1706745950000
      }
    }
  ]
}

// Server → Admin
{ "id": 8, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "prod-1", "stock": 25, ... } },
    { "index": 1, "data": { "id": "order-1", "status": "cancelled", ... } },
    { "index": 2, "data": { "id": "log-2", "action": "order_cancelled", ... } }
  ] }
}

// Admin → Server (emitování eventu zrušení)
{ "id": 9, "type": "rules.emit", "topic": "order.cancelled", "data": {
    "orderId": "order-1", "userId": "user-alice", "reason": "admin_cancelled"
  }
}
```

Subscription Alice `user-orders` obdrží push s aktualizovanou objednávkou (status: „cancelled"). Subscription admina `order.*` pro rules obdrží push eventu `order.cancelled`. Subscription katalogu produktů se aktualizuje s obnoveným skladem. Vše z jedné atomické transakce + jednoho eventu.

</details>

## Shrnutí

- **Multi-bucket schéma**: Oddělené buckety pro produkty, objednávky, uživatele a audit logy — každý s vlastním klíčem a validací
- **Cross-bucket transakce**: Zadání objednávky atomicky aktualizuje sklad, vytvoří objednávku a zaloguje akci — rollback při jakémkoli selhání
- **Vrstvená oprávnění**: Admin dostane plný přístup; zákazníci read-only produkty, vlastní objednávky a insert-only přes transakce
- **Produkční odolnost**: Rate limiting (100 req/min na uživatele), heartbeat (30s/10s), backpressure (1 MB/0.8) — vše nakonfigurované v `ServerConfig`
- **Dva push kanály**: Store subscriptions pro stav objednávek a katalog produktů; Rules subscriptions pro eventy objednávek a alerty inventáře
- **Elegantní ukončení**: `server.stop({ gracePeriodMs })` notifikuje klienty před zavřením spojení
- **Statistiky serveru**: `server.getStats()` poskytuje počty spojení, celky subscriptions a feature flags v reálném čase

---

Tímto končí příručka učení. Postavili jste tři kompletní projekty, které demonstrují každou feature noex-serveru spolupracující. Pro detaily API viz [README](../../README.md). Pro hluboké ponory do jednotlivých features začněte od [Části 1: Úvod](../01-uvod/01-proc-websocket-server.md).
