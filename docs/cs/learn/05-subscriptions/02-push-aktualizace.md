# Push aktualizace

Po přihlášení k odběru server automaticky posílá push zprávy při každé změně výsledku dotazu. Nemusíte pollovat — nová data přicházejí okamžitě.

## Co se naučíte

- Formát push zprávy
- Jak insert, update a delete spouštějí pushe
- Proč některé mutace push nevyvolají (deep equality)
- Skalární vs array push data
- Jak pushe fungují mezi více klienty

## Nastavení serveru

Stejné jako v [předchozí kapitole](./01-odber-dotazu.md):

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'push-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineQuery('all-users', async (ctx) => {
  return ctx.bucket('users').all();
});

store.defineQuery('user-count', async (ctx) => {
  return ctx.bucket('users').count();
});

store.defineQuery('users-by-role', async (ctx, params: { role: string }) => {
  return ctx.bucket('users').where({ role: params.role });
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Formát push zprávy

Push zprávy jsou iniciovány serverem — přicházejí bez odpovídajícího requestu. Nemají pole `id`:

```jsonc
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [ /* aktualizovaný výsledek dotazu */ ]
}
```

| Pole | Popis |
|------|-------|
| `type` | Vždy `"push"` |
| `channel` | Vždy `"subscription"` pro store subscriptions |
| `subscriptionId` | Odpovídá ID z odpovědi na subscribe |
| `data` | Kompletní aktualizovaný výsledek dotazu |

**Důležité:** Push `data` je vždy *kompletní* výsledek — ne diff. Pokud jste přihlášeni k `all-users` a je vložen třetí uživatel, push obsahuje všechny tři uživatele, ne jen nového.

## Push při insertu

```jsonc
// 1. Přihlášení k odběru
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Vložení uživatele
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

// 3. Push přijde automaticky
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }
```

## Push při update

```jsonc
// Po přihlášení a vložení Alice...

// Aktualizace jména Alice
→ { "id": 3, "type": "store.update", "bucket": "users",
    "key": "a1", "data": { "name": "Alice Smith" } }
← { "id": 3, "type": "result",
    "data": { "id": "a1", "name": "Alice Smith", "role": "user", "_version": 2 } }

// Push s aktualizovanými daty
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice Smith", "role": "user", "_version": 2 }] }
```

## Push při delete

```jsonc
// Smazání Alice
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "a1" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// Push s prázdným výsledkem
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [] }
```

## Deep equality — žádné zbytečné pushe

Server porovnává nový výsledek dotazu s předchozím pomocí hloubkového porovnání. Pokud se shodují, push se neodešle. To zabraňuje šumu:

```jsonc
// Odběr admin uživatelů (zpočátku prázdné)
→ { "id": 1, "type": "store.subscribe", "query": "users-by-role",
    "params": { "role": "admin" } }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Vložení běžného uživatele — výsledek dotazu je stále [] → žádný push
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Regular", "role": "user" } }
← { "id": 2, "type": "result", "data": { ... } }
// ← (žádný push — seznam adminů se nezměnil)

// Vložení admina — výsledek dotazu se změní → push
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Admin", "role": "admin" } }
← { "id": 3, "type": "result", "data": { ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "x1", "name": "Admin", "role": "admin", "_version": 1 }] }
```

Toto je obzvláště užitečné pro skalární dotazy jako `count` — aktualizace jména uživatele nezmění počet, takže se push neodešle.

## Skalární push data

Pro skalární dotazy je push `data` prostá hodnota, ne pole:

```jsonc
// Odběr počtu
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }

// Vložení uživatele
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 2, "type": "result", "data": { ... } }

// Push: počet je nyní 1 (ne [1], ne { count: 1 })
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 1 }
```

## Sekvenční pushe

Každá mutace, která změní výsledek dotazu, spustí samostatný push:

```jsonc
// Odběr počtu (zpočátku 0)
→ { "id": 1, "type": "store.subscribe", "query": "user-count" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": 0 } }

// Vložení prvního uživatele → push s počtem 1
→ { "id": 2, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 1 }

// Vložení druhého uživatele → push s počtem 2
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": 2 }
```

## Push mezi klienty

Subscriptions fungují napříč klienty. Když Client B zmutuje data, Client A obdrží pushe pro své aktivní subscriptions:

```text
Client A                             Server                           Client B
   │                                    │                                │
   │── subscribe "all-users" ─────────►│                                │
   │◄── { subscriptionId: "sub-1",     │                                │
   │     data: [] }                     │                                │
   │                                    │                                │
   │                                    │◄── insert { name: "Bob" } ────│
   │                                    │──► result { id: "b1" } ───────►│
   │                                    │                                │
   │◄── push { subscriptionId: "sub-1",│                                │
   │     data: [{ name: "Bob" }] } ────│                                │
```

Subscriptions každého klienta jsou nezávislé. Client A a Client B se mohou přihlásit ke stejnému dotazu a každý dostává vlastní pushe.

## Časování pushů

Push zprávy přicházejí asynchronně po odpovědi na mutaci. Server:
1. Zpracuje mutaci (insert/update/delete)
2. Odešle výsledek žádajícímu klientovi
3. Přehodnotí dotčené dotazy
4. Porovná nové výsledky s předchozími
5. Odešle push zprávy pouze tam, kde se výsledky změnily

V praxi pushe přicházejí během milisekund po mutaci. V testech lze na serveru použít `store.settle()` pro čekání na dokončení všech probíhajících přehodnocení.

## Praktický příklad

```typescript
// Přihlášení k odběru
const subResp = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const subscriptionId = subResp.data.subscriptionId;

// Nastavte push listener PŘED mutací
const pushPromise = waitForPush(ws, subscriptionId);

// Mutace
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

// Čekání na push
const push = await pushPromise;
console.log(push.data); // [{ id: "...", name: "Alice", role: "user", _version: 1 }]
```

**Tip:** Vždy nastavte push listener *před* mutací, která ho spustí. Jinak můžete push zmeškat.

## Cvičení

Přihlaste se k odběru `all-users` i `user-count`. Vložte uživatele a ověřte, že obdržíte pushe na obou subscriptions — jeden s polem uživatelů, druhý s počtem.

<details>
<summary>Řešení</summary>

```jsonc
// 1. Odběr all-users
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Odběr user-count
→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// 3. Vložení uživatele
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result",
    "data": { "id": "a1", "name": "Alice", "role": "user", "_version": 1 } }

// 4. Dva pushe:
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }

← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }
```

</details>

## Shrnutí

- Push zprávy mají formát: `{ type: "push", channel: "subscription", subscriptionId, data }`
- `data` je vždy kompletní aktualizovaný výsledek — ne diff
- Insert, update a delete na odebíraných bucketech spouštějí přehodnocení
- Pokud se výsledek nezměnil, push se neodešle (deep equality)
- Skalární dotazy pushují prosté hodnoty; array dotazy pushují pole
- Push funguje napříč klienty — mutace Client B spustí push pro Client A
- Nastavujte push listenery před mutacemi, abyste nezmeškali zprávy

---

Další: [Parametrizované dotazy](./03-parametrizovane-dotazy.md)
