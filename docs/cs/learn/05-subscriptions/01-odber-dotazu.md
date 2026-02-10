# Odběr dotazů

Přihlaste se k odběru pojmenovaného dotazu a okamžitě obdržíte jeho aktuální výsledek — poté dostáváte automatické push aktualizace při každé změně.

## Co se naučíte

- Jak definovat reaktivní dotazy na serveru pomocí `store.defineQuery()`
- Jak se přihlásit k odběru zprávou `store.subscribe`
- Strukturu odpovědi: `subscriptionId` + úvodní `data`
- Skalární vs array úvodní výsledky
- Zpracování chyb pro nedefinované dotazy

## Nastavení serveru

Všechny příklady v této kapitole předpokládají následující nastavení:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'subscriptions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

// Definice reaktivních dotazů PŘED spuštěním serveru
store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Definice dotazů

Reaktivní dotazy jsou pojmenované, read-only asynchronní funkce registrované na store. Popisují, *jaká data* klient obdrží. Store automaticky sleduje, na kterých bucketech a záznamech každý dotaz závisí, a ví tak, kdy má provést přehodnocení.

```typescript
// Array dotaz — vrátí všechny záznamy
store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

// Skalární dotaz — vrátí jedno číslo
store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});
```

Uvnitř funkce dotazu `ctx.bucket(name)` poskytuje read-only přístup k datům bucketu. Lze použít libovolnou čtecí metodu (`all`, `where`, `findOne`, `count`, `first`, `last`, `paginate`, `sum`, `avg`, `min`, `max`, `get`).

**Důležité:** Dotazy musí být definovány *před* tím, než se klienti přihlásí k odběru. Nelze je definovat dynamicky za běhu — jsou součástí konfigurace serveru.

## store.subscribe

Odešle požadavek na přihlášení k odběru pojmenovaného dotazu. Server odpoví unikátním `subscriptionId` a aktuálním výsledkem dotazu jako úvodními daty.

```jsonc
// Request
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }

// Response
← { "id": 1, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": []
    }
  }
```

**Povinná pole:** `query`

Odpověď `data` obsahuje dvě pole:
- **`subscriptionId`** — unikátní řetězec (např. `"sub-1"`, `"sub-2"`) identifikující tuto subscription. Použijte ho pro párování příchozích push zpráv a pro odhlášení.
- **`data`** — aktuální výsledek dotazu v okamžiku přihlášení. Totéž, co byste dostali přímým spuštěním dotazu.

## Úvodní data

Úvodní `data` odrážejí aktuální stav store v momentě přihlášení:

```jsonc
// Prázdný bucket → prázdné pole
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Po vložení uživatele → pole s jedním záznamem
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result",
    "data": { "id": "a1b2", "name": "Alice", "role": "user", "_version": 1 } }

→ { "id": 3, "type": "store.subscribe", "query": "all-users" }
← { "id": 3, "type": "result",
    "data": {
      "subscriptionId": "sub-2",
      "data": [{ "id": "a1b2", "name": "Alice", "role": "user", "_version": 1 }]
    }
  }
```

## Skalární dotazy

Dotazy vracející jednu hodnotu (jako `count()`) vrátí tuto hodnotu přímo, ne zabalenou v poli:

```jsonc
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }
```

Po vložení dvou uživatelů a novém přihlášení:

```jsonc
→ { "id": 4, "type": "store.subscribe", "query": "user-count" }
← { "id": 4, "type": "result",
    "data": { "subscriptionId": "sub-3", "data": 2 } }
```

## Zpracování chyb

| Kód chyby | Příčina |
|-----------|---------|
| `QUERY_NOT_DEFINED` | Název dotazu neodpovídá žádnému definovanému dotazu |
| `VALIDATION_ERROR` | Pole `query` chybí nebo je prázdné |

```jsonc
// Neznámý dotaz
→ { "id": 5, "type": "store.subscribe", "query": "nonexistent" }
← { "id": 5, "type": "error",
    "code": "QUERY_NOT_DEFINED",
    "message": "Query \"nonexistent\" is not defined" }

// Chybějící pole query
→ { "id": 6, "type": "store.subscribe" }
← { "id": 6, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"query\": expected non-empty string" }
```

## Praktický příklad

```typescript
// Přihlášení k odběru všech uživatelů
const subResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});

const { subscriptionId, data: initialUsers } = subResp.data;
console.log('Subscription ID:', subscriptionId); // "sub-1"
console.log('Úvodní uživatelé:', initialUsers);   // []

// Přihlášení k odběru počtu uživatelů
const countResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'user-count',
});

console.log('Úvodní počet:', countResp.data.data); // 0
```

## Cvičení

Napište posloupnost WebSocket zpráv, které:
1. Vloží dva uživatele ("Alice" a "Bob")
2. Přihlásí se k odběru `all-users` a ověří, že úvodní data obsahují oba uživatele
3. Přihlásí se k odběru `user-count` a ověří, že úvodní počet je 2

<details>
<summary>Řešení</summary>

```jsonc
// 1. Vložení uživatelů
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 1, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "id": 2, "type": "result",
    "data": { "id": "b1", "name": "Bob", "role": "user", "_version": 1 } }

// 2. Odběr all-users — úvodní data obsahují oba
→ { "id": 3, "type": "store.subscribe", "query": "all-users" }
← { "id": 3, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": [
        { "id": "a1", "name": "Alice", "role": "user", "_version": 1 },
        { "id": "b1", "name": "Bob", "role": "user", "_version": 1 }
      ]
    }
  }

// 3. Odběr user-count — úvodní počet je 2
→ { "id": 4, "type": "store.subscribe", "query": "user-count" }
← { "id": 4, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 2 } }
```

</details>

## Shrnutí

- Reaktivní dotazy definujte na serveru pomocí `store.defineQuery()` před připojením klientů
- Přihlaste se k odběru zprávou `store.subscribe` s polem `query`
- Odpověď obsahuje `subscriptionId` (pro párování pushů a odhlášení) a `data` (aktuální výsledek)
- Array dotazy vrací pole, skalární dotazy vrací hodnoty přímo
- `QUERY_NOT_DEFINED` pokud dotaz neexistuje, `VALIDATION_ERROR` pokud pole `query` chybí

---

Další: [Push aktualizace](./02-push-aktualizace.md)
