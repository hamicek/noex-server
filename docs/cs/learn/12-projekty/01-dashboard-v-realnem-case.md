# Dashboard v reálném čase

Stavba dashboardu s živými metrikami, kde administrátoři posílají metriky přes server a diváci vidí aktualizace okamžitě přes reaktivní subscriptions. Tento projekt kombinuje Store CRUD, reaktivní dotazy, autentizaci a oprávnění založená na rolích.

## Co se naučíte

- Návrh schématu metrics bucketu pro data podobná časovým řadám
- Reaktivní dotazy pro živé pohledy dashboardu (všechny metriky, filtrované podle názvu, agregace)
- Přístup chráněný oprávněními: diváci se přihlásí k read-only pohledům, admini mutují data
- Multi-client push: admin insert vyvolá push všem viewer subscriptions
- Kombinace auth + subscriptions + oprávnění v jednom serveru

## Přehled architektury

```text
┌────────────────────────────────────────────────────────────────────┐
│                    Dashboard Server                                 │
│                                                                     │
│  Buckety                          Dotazy                           │
│  ┌──────────────────────┐         ┌──────────────────────────┐     │
│  │ metrics              │         │ all-metrics              │     │
│  │   name: string       │         │ metrics-by-name(name)    │     │
│  │   value: number      │         │ metric-count             │     │
│  │   unit: string       │         │ latest-metrics(n)        │     │
│  │   timestamp: number  │         └──────────────────────────┘     │
│  └──────────────────────┘                                          │
│                                                                     │
│  Auth                             Oprávnění                        │
│  ┌──────────────────────┐         ┌──────────────────────────┐     │
│  │ validate(token)      │         │ admin  → plný přístup    │     │
│  │   "admin-token"      │         │ viewer → pouze čtení     │     │
│  │   "viewer-token"     │         │   žádný insert/update/   │     │
│  └──────────────────────┘         │   delete/clear           │     │
│                                   └──────────────────────────┘     │
│                                                                     │
│  Klienti                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                         │
│  │ Admin    │  │ Divák 1  │  │ Divák 2  │                         │
│  │ insert   │  │ subscribe│  │ subscribe│                         │
│  │ update   │  │ push ←   │  │ push ←   │                         │
│  │ delete   │  │          │  │          │                         │
│  └──────────┘  └──────────┘  └──────────┘                         │
└────────────────────────────────────────────────────────────────────┘
```

## Kompletní nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';
import type { AuthSession } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'dashboard' });

  // ── Bucket ──────────────────────────────────────────────────────

  await store.defineBucket('metrics', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      name:      { type: 'string', required: true },
      value:     { type: 'number', required: true },
      unit:      { type: 'string', default: '' },
      timestamp: { type: 'number', required: true },
    },
  });

  // ── Dotazy ─────────────────────────────────────────────────────

  store.defineQuery('all-metrics', async (ctx) => {
    return ctx.bucket('metrics').all();
  });

  store.defineQuery('metrics-by-name', async (ctx, params: { name: string }) => {
    return ctx.bucket('metrics').where({ name: params.name });
  });

  store.defineQuery('metric-count', async (ctx) => {
    return ctx.bucket('metrics').count();
  });

  store.defineQuery('latest-metrics', async (ctx, params: { n: number }) => {
    return ctx.bucket('metrics').last(params.n);
  });

  // ── Auth + Oprávnění ──────────────────────────────────────────

  const adminSession: AuthSession = {
    userId: 'admin-1',
    roles: ['admin'],
  };

  const viewerSession: AuthSession = {
    userId: 'viewer-1',
    roles: ['viewer'],
  };

  const WRITE_OPS = new Set([
    'store.insert', 'store.update', 'store.delete', 'store.clear',
    'store.transaction',
  ]);

  const server = await NoexServer.start({
    port: 8080,
    store,
    auth: {
      validate: async (token) => {
        if (token === 'admin-token') return adminSession;
        if (token === 'viewer-token') return viewerSession;
        return null;
      },
      permissions: {
        check: (session, operation) => {
          // Admini mohou vše
          if (session.roles.includes('admin')) return true;
          // Diváci nemohou mutovat data
          if (WRITE_OPS.has(operation)) return false;
          return true;
        },
      },
    },
  });

  console.log(`Dashboard server naslouchá na ws://localhost:${server.port}`);
}

main();
```

## Interakce klientů: Kompletní flow

### Krok 1: Připojení a autentizace

Admin i divák se připojí a obdrží welcome zprávu:

```jsonc
// Server → Klient (při připojení)
{ "type": "welcome", "version": "1.0.0", "serverTime": 1706745600000, "requiresAuth": true }
```

Admin se autentizuje:

```jsonc
// Admin → Server
{ "id": 1, "type": "auth.login", "token": "admin-token" }

// Server → Admin
{ "id": 1, "type": "result", "data": { "userId": "admin-1", "roles": ["admin"] } }
```

Divák se autentizuje:

```jsonc
// Divák → Server
{ "id": 1, "type": "auth.login", "token": "viewer-token" }

// Server → Divák
{ "id": 1, "type": "result", "data": { "userId": "viewer-1", "roles": ["viewer"] } }
```

### Krok 2: Divák se přihlásí k živým metrikám

```jsonc
// Divák → Server
{ "id": 2, "type": "store.subscribe", "query": "all-metrics" }

// Server → Divák (odpověď se subscriptionId + počáteční data)
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "data": [] } }
```

Přihlášení k filtrovanému pohledu:

```jsonc
// Divák → Server
{ "id": 3, "type": "store.subscribe", "query": "metrics-by-name", "params": { "name": "cpu" } }

// Server → Divák
{ "id": 3, "type": "result", "data": { "subscriptionId": "sub-2", "data": [] } }
```

Přihlášení k počtu metrik:

```jsonc
// Divák → Server
{ "id": 4, "type": "store.subscribe", "query": "metric-count" }

// Server → Divák (skalární počáteční data)
{ "id": 4, "type": "result", "data": { "subscriptionId": "sub-3", "data": 0 } }
```

### Krok 3: Admin posílá metriky

```jsonc
// Admin → Server
{ "id": 2, "type": "store.insert", "bucket": "metrics", "data": {
    "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000
  }
}

// Server → Admin (výsledek insertu)
{ "id": 2, "type": "result", "data": {
    "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
    "timestamp": 1706745600000, "_version": 1
  }
}
```

Po přehodnocení dotazu všichni diváci s aktivními subscriptions obdrží push:

```jsonc
// Server → Divák (push na all-metrics subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
      "timestamp": 1706745600000, "_version": 1 }
  ]
}

// Server → Divák (push na metrics-by-name "cpu" subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%",
      "timestamp": 1706745600000, "_version": 1 }
  ]
}

// Server → Divák (push na metric-count subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-3", "data": 1 }
```

### Krok 4: Divák zkouší mutovat — zamítnuto

```jsonc
// Divák → Server
{ "id": 5, "type": "store.insert", "bucket": "metrics", "data": {
    "name": "hack", "value": 0, "unit": "", "timestamp": 0
  }
}

// Server → Divák
{ "id": 5, "type": "error", "code": "FORBIDDEN", "message": "No permission for store.insert on metrics" }
```

### Krok 5: Admin dávkově vkládá přes transakci

```jsonc
// Admin → Server
{ "id": 3, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "memory", "value": 4200, "unit": "MB", "timestamp": 1706745660000
      }
    },
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000
      }
    }
  ]
}

// Server → Admin
{ "id": 3, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "m-def456", "name": "memory", "value": 4200,
        "unit": "MB", "timestamp": 1706745660000, "_version": 1 } },
    { "index": 1, "data": { "id": "m-ghi789", "name": "cpu", "value": 68.1,
        "unit": "%", "timestamp": 1706745660000, "_version": 1 } }
  ] }
}
```

Po commitnutí transakce všechny dotčené subscriptions obdrží jeden push s nejnovějším výsledkem dotazu:

```jsonc
// Server → Divák (push na all-metrics — nyní 3 záznamy)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000, "_version": 1 },
    { "id": "m-ghi789", "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000, "_version": 1 },
    { "id": "m-def456", "name": "memory", "value": 4200, "unit": "MB", "timestamp": 1706745660000, "_version": 1 }
  ]
}

// Server → Divák (push na metrics-by-name "cpu" — nyní 2 cpu záznamy)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "m-abc123", "name": "cpu", "value": 72.5, "unit": "%", "timestamp": 1706745600000, "_version": 1 },
    { "id": "m-ghi789", "name": "cpu", "value": 68.1, "unit": "%", "timestamp": 1706745660000, "_version": 1 }
  ]
}

// Server → Divák (push na metric-count — nyní 3)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-3", "data": 3 }
```

### Krok 6: Úklid

Divák se odhlásí z all-metrics:

```jsonc
// Divák → Server
{ "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-1" }

// Server → Divák
{ "id": 6, "type": "result", "data": { "unsubscribed": true } }
```

Admin vymaže staré metriky:

```jsonc
// Admin → Server
{ "id": 4, "type": "store.clear", "bucket": "metrics" }

// Server → Admin
{ "id": 4, "type": "result", "data": { "cleared": true } }
```

## Podrobný rozbor

### Návrh schématu

Bucket `metrics` ukládá jednotlivé datové body s polem `name` pro kategorizaci (cpu, memory, disk, network). Pole `timestamp` umožňuje filtrování na základě času v dotazech. Použití `generated: 'uuid'` pro klíč znamená, že se nemusíte starat o kolize, když více adminů posílá metriky současně.

### Reaktivní dotazy

Čtyři dotazy slouží různým pohledům dashboardu:

| Dotaz | Parametry | Vrací | Použití v dashboardu |
|-------|-----------|-------|----------------------|
| `all-metrics` | žádné | pole | Kompletní tabulka metrik |
| `metrics-by-name` | `{ name }` | pole | Graf jedné metriky |
| `metric-count` | žádné | skalár | Odznak počítadla |
| `latest-metrics` | `{ n }` | pole | Widget „Posledních N odečtů" |

Každý divák se přihlásí k dotazům, které potřebuje. Když se jakákoli metrika vloží, aktualizuje nebo smaže, pouze dotazy, jejichž výsledky se skutečně změní, emitují push. Například vložení `cpu` metriky vyvolá push pro `all-metrics`, `metrics-by-name({ name: 'cpu' })` a `metric-count`, ale ne pro `metrics-by-name({ name: 'memory' })`.

### Model oprávnění

Kontrola oprávnění je jednoduchá funkce — žádný framework ani middleware není potřeba:

```typescript
const WRITE_OPS = new Set([
  'store.insert', 'store.update', 'store.delete', 'store.clear',
  'store.transaction',
]);

check: (session, operation) => {
  if (session.roles.includes('admin')) return true;
  if (WRITE_OPS.has(operation)) return false;
  return true;
}
```

Toto dává divákům read-only přístup (mohou používat `store.all`, `store.where`, `store.subscribe`, atd.), zatímco mutace jsou vyhrazeny adminům. Parametr `resource` (název bucketu) je dostupný, ale zde nepoužitý — mohli byste ho rozšířit pro omezení přístupu ke konkrétním bucketům.

### Multi-client push

Klíčové zjištění je, že subscriptions a mutace jsou oddělené:

1. Divák se přihlásí k `all-metrics` → dostane `sub-1`
2. Admin (jiné spojení) vloží metriku
3. Server detekuje změnu dat, přehodnotí dotaz
4. Server pošle nový výsledek divákovi na `sub-1`

Toto funguje, protože dotazy se vyhodnocují na straně serveru proti sdílenému Store. Jakákoli mutace z jakéhokoli spojení vyvolá přehodnocení pro všechny subscriptions sledující dotčená data.

## Cvičení

Rozšiřte dashboard o:

1. Nový bucket `alerts` s poli `metric`, `threshold`, `severity` (low/medium/high)
2. Dotaz `active-alerts`, který vrací všechny alerty
3. Pravidlo oprávnění: diváci mohou číst alerty, ale pouze admini je mohou vytvářet
4. Admin flow: když metrika překročí threshold, vložte alert přes transakci (insert metriky + insert alertu atomicky)

<details>
<summary>Řešení</summary>

**Doplnění na straně serveru:**

```typescript
await store.defineBucket('alerts', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    metric:    { type: 'string', required: true },
    threshold: { type: 'number', required: true },
    severity:  { type: 'string', default: 'low' },
    timestamp: { type: 'number', required: true },
  },
});

store.defineQuery('active-alerts', async (ctx) => {
  return ctx.bucket('alerts').all();
});
```

Žádné změny oprávnění nejsou potřeba — existující set `WRITE_OPS` již pokrývá `store.insert` a `store.transaction`.

**Klientský flow (admin detekuje vysoké CPU a vytvoří alert):**

```jsonc
// Admin → Server (atomicky: insert metriky + insert alertu)
{ "id": 5, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "metrics", "data": {
        "name": "cpu", "value": 95.2, "unit": "%", "timestamp": 1706745720000
      }
    },
    { "op": "insert", "bucket": "alerts", "data": {
        "metric": "cpu", "threshold": 90, "severity": "high", "timestamp": 1706745720000
      }
    }
  ]
}

// Server → Admin
{ "id": 5, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "m-xxx", "name": "cpu", "value": 95.2, ... } },
    { "index": 1, "data": { "id": "a-yyy", "metric": "cpu", "threshold": 90,
        "severity": "high", ... } }
  ] }
}
```

Diváci přihlášení k `active-alerts` obdrží push s novým alertem. Diváci přihlášení k `all-metrics` nebo `metrics-by-name({ name: 'cpu' })` obdrží aktualizované seznamy metrik. Všechny push zprávy přijdou z jednoho commitu transakce.

</details>

## Shrnutí

- **Návrh schématu**: Použijte jeden bucket s polem `name` pro kategorizaci a `timestamp` pro data časových řad
- **Reaktivní dotazy**: Definujte dotazy pro každý pohled dashboardu — `all`, `where` s parametry, `count`, `last(n)`
- **Oprávnění**: Jednoduchá funkce se `Set` zápisových operací — žádný framework není potřeba
- **Multi-client push**: Mutace z jednoho spojení vyvolají push všem ostatním spojením s aktivními subscriptions
- **Transakce**: Dávkové vložení více metrik atomicky — odběratelé obdrží jeden push po commitu
- **Odpověď subscription**: Obsahuje `subscriptionId` a `data` (počáteční výsledek dotazu) — klient může renderovat okamžitě bez separátního fetche

---

Další: [Chatovací aplikace](./02-chatovaci-aplikace.md)
