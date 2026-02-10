# Parametrizované dotazy

Předávejte parametry dotazům při přihlášení k odběru. Místo definice samostatného dotazu pro každý filtr definujte jeden dotaz s parametry a nechte každého klienta zadat vlastní hodnoty.

## Co se naučíte

- Jak definovat dotazy přijímající parametry
- Jak se přihlásit k odběru s polem `params`
- Jak různí klienti mohou používat různé parametry na stejném dotazu
- Jak pushe fungují s parametrizovanými subscriptions

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'params-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    userId: { type: 'string', required: true },
    total:  { type: 'number', required: true },
    status: { type: 'string', default: 'pending' },
  },
});

// Parametrizovaný dotaz — filtruje uživatele podle role
store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});

// Parametrizovaný dotaz — filtruje objednávky podle uživatele
store.defineQuery('orders-for-user', async (ctx, params: { userId: string }) => {
  return ctx.bucket('orders').where({ userId: params.userId });
});

// Parametrizovaný skalární dotaz — počítá objednávky podle statusu
store.defineQuery('order-count-by-status', async (ctx, params: { status: string }) => {
  return ctx.bucket('orders').count({ status: params.status });
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Definice dotazů s parametry

Funkce dotazu přijímá `params` jako druhý argument:

```typescript
store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});
```

Parametry mohou být libovolná serializovatelná hodnota — objekty, řetězce, čísla. Funkce dotazu je použije pro filtrování, řazení nebo výpočet dat.

## Přihlášení s params

Předejte pole `params` spolu s `query` ve zprávě subscribe:

```jsonc
// Odběr pouze admin uživatelů
→ { "id": 1, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "admin" } }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Odběr běžných uživatelů
→ { "id": 2, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "user" } }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": [] } }
```

Každá kombinace `(query, params)` vytváří nezávislou subscription s vlastním `subscriptionId` a vlastním proudem pushů.

## Cílené pushe

S parametrizovanými subscriptions jsou pushe cílené — obdržíte aktualizace pouze tehdy, když se změní *váš* filtrovaný výsledek:

```jsonc
// Dvě aktivní subscriptions:
// sub-1: users-by-role { role: "admin" }
// sub-2: users-by-role { role: "user" }

// Vložení běžného uživatele
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob", "role": "user" } }
← { "id": 3, "type": "result", "data": { ... } }

// Pouze sub-2 obdrží push (seznam adminů se nezměnil)
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": [{ "id": "b1", "name": "Bob", "role": "user", "_version": 1 }] }
// (žádný push pro sub-1)

// Vložení admina
→ { "id": 4, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "role": "admin" } }
← { "id": 4, "type": "result", "data": { ... } }

// Pouze sub-1 obdrží push
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "admin", "_version": 1 }] }
// (žádný push pro sub-2)
```

## Více klientů, různé parametry

Různí klienti se mohou přihlásit ke stejnému dotazu s různými parametry. Každý dostává pushe pouze pro své parametry:

```text
Client A (admin dashboard)           Server           Client B (uživatelský portál)
   │                                    │                │
   │── subscribe "users-by-role"       │                │
   │   params: { role: "admin" }  ────►│                │
   │◄── sub-1, data: []                │                │
   │                                    │                │
   │                                    │◄── subscribe "users-by-role"
   │                                    │    params: { role: "user" }  ──│
   │                                    │──► sub-2, data: [] ───────────►│
   │                                    │                │
   │              ┌─── insert { role: "user" } ───┐     │
   │              │                                │     │
   │   (no push)  │    Server přehodnotí:          │     │
   │              │    sub-1 beze změny → přeskočit │     │
   │              │    sub-2 se změnil → push       │     │
   │              └────────────────────────────────┘     │
   │                                    │──► push sub-2 ►│
```

## Praktický příklad

```typescript
// Vložení počátečních dat
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice', role: 'admin' },
});
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Bob', role: 'user' },
});

// Odběr adminů
const adminSub = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'users-by-role',
  params: { role: 'admin' },
});
console.log(adminSub.data.data);
// [{ id: "a1", name: "Alice", role: "admin", _version: 1 }]

// Odběr objednávek pro konkrétního uživatele
const orderSub = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'orders-for-user',
  params: { userId: 'a1' },
});
console.log(orderSub.data.data); // []
```

## Cvičení

Definujte a použijte parametrizovaný dotaz:
1. Vložte tři uživatele: Alice (admin), Bob (user), Charlie (admin)
2. Přihlaste se k odběru `users-by-role` s `{ role: "admin" }`
3. Ověřte, že úvodní data obsahují Alice a Charlieho
4. Vložte nového admina "Dave" a ověřte, že obdržíte push se všemi třemi adminy
5. Vložte běžného uživatele "Eve" a ověřte, že žádný push nepřišel

<details>
<summary>Řešení</summary>

```jsonc
// 1. Vložení uživatelů
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "role": "admin" } }
← { "id": 1, "type": "result", "data": { "id": "a1", ... } }

→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob", "role": "user" } }
← { "id": 2, "type": "result", "data": { "id": "b1", ... } }

→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Charlie", "role": "admin" } }
← { "id": 3, "type": "result", "data": { "id": "c1", ... } }

// 2. Odběr adminů
→ { "id": 4, "type": "store.subscribe",
    "query": "users-by-role", "params": { "role": "admin" } }
← { "id": 4, "type": "result",
    "data": {
      "subscriptionId": "sub-1",
      "data": [
        { "id": "a1", "name": "Alice", "role": "admin", "_version": 1 },
        { "id": "c1", "name": "Charlie", "role": "admin", "_version": 1 }
      ]
    }
  }

// 4. Vložení admina Dave → push se 3 adminy
→ { "id": 5, "type": "store.insert", "bucket": "users",
    "data": { "name": "Dave", "role": "admin" } }
← { "id": 5, "type": "result", "data": { "id": "d1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice", "role": "admin", "_version": 1 },
      { "id": "c1", "name": "Charlie", "role": "admin", "_version": 1 },
      { "id": "d1", "name": "Dave", "role": "admin", "_version": 1 }
    ]
  }

// 5. Vložení běžného uživatele Eve → žádný push pro sub-1
→ { "id": 6, "type": "store.insert", "bucket": "users",
    "data": { "name": "Eve", "role": "user" } }
← { "id": 6, "type": "result", "data": { "id": "e1", ... } }
// (žádný push pro sub-1)
```

</details>

## Shrnutí

- Parametrizované dotazy definujte s `async (ctx, params) => { ... }` na serveru
- Přihlaste se s `"params": { ... }` ve zprávě subscribe
- Každá kombinace `(query, params)` je nezávislá subscription
- Pushe jsou cílené — odesílají se pouze při změně parametrizovaného výsledku
- Různí klienti se mohou přihlásit ke stejnému dotazu s různými parametry

---

Další: [Správa subscriptions](./04-sprava-subscriptions.md)
