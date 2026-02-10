# Základní CRUD

Základ noex-server: vytvářet, číst, aktualizovat a mazat záznamy přes WebSocket protokol. Každá operace odpovídá jednomu typu zprávy `store.*`.

## Co se naučíte

- Jak vkládat záznamy pomocí `store.insert`
- Jak načítat záznamy pomocí `store.get`
- Jak aktualizovat záznamy pomocí `store.update`
- Jak mazat záznamy pomocí `store.delete`
- Jak funguje sledování verzí přes `_version`

## Nastavení serveru

Všechny příklady v této kapitole předpokládají následující nastavení serveru:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'crud-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string' },
    role:  { type: 'string', default: 'user' },
    age:   { type: 'number' },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## store.insert

Vytvoří nový záznam. Server aplikuje výchozí hodnoty ze schématu a automaticky vygeneruje pole (např. `id`) a pak vrátí kompletní záznam.

```jsonc
// Request
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "email": "alice@example.com" } }

// Response
← { "id": 1, "type": "result",
    "data": {
      "id": "a1b2c3d4",
      "name": "Alice",
      "email": "alice@example.com",
      "role": "user",
      "_version": 1,
      "_createdAt": 1706745600000
    }
  }
```

**Povinná pole:** `bucket`, `data`

Všimněte si:
- `id` bylo automaticky vygenerováno (schéma má `generated: 'uuid'`)
- `role` dostalo výchozí hodnotu `"user"`
- `_version` začíná na 1
- `_createdAt` je Unix timestamp v milisekundách

**Chyby:**
- `VALIDATION_ERROR` — chybí `bucket`, chybí `data` nebo chybí povinná pole ze schématu
- `BUCKET_NOT_DEFINED` — bucket neexistuje

## store.get

Načte jeden záznam podle primárního klíče. Pokud klíč neexistuje, vrátí `null` (ne chybu).

```jsonc
// Request
→ { "id": 2, "type": "store.get", "bucket": "users", "key": "a1b2c3d4" }

// Response (found)
← { "id": 2, "type": "result",
    "data": { "id": "a1b2c3d4", "name": "Alice", "email": "alice@example.com", "role": "user", "_version": 1 } }

// Response (not found)
← { "id": 3, "type": "result", "data": null }
```

**Povinná pole:** `bucket`, `key`

**Důležité:** Neexistující záznam vrátí `data: null`, nikoli chybu `NOT_FOUND`. To je záměrné — ověření existence je běžná operace, ne výjimečná.

## store.update

Aktualizuje existující záznam. Změní se pouze pole uvedená v `data`; ostatní pole zůstanou zachována. `_version` se zvýší.

```jsonc
// Request
→ { "id": 4, "type": "store.update", "bucket": "users",
    "key": "a1b2c3d4", "data": { "name": "Alice Smith", "role": "admin" } }

// Response
← { "id": 4, "type": "result",
    "data": {
      "id": "a1b2c3d4",
      "name": "Alice Smith",
      "email": "alice@example.com",
      "role": "admin",
      "_version": 2
    }
  }
```

**Povinná pole:** `bucket`, `key`, `data`

Všimněte si:
- `email` nebylo v `data` aktualizace, takže zůstalo zachováno
- `_version` se zvýšilo z 1 na 2

## store.delete

Smaže záznam podle primárního klíče. Vrátí `{ deleted: true }`.

```jsonc
// Request
→ { "id": 5, "type": "store.delete", "bucket": "users", "key": "a1b2c3d4" }

// Response
← { "id": 5, "type": "result", "data": { "deleted": true } }
```

**Povinná pole:** `bucket`, `key`

Po smazání `store.get` pro stejný klíč vrátí `null`.

## Kompletní CRUD cyklus

```jsonc
// 1. INSERT
→ { "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Bob" } }
← { "id": 1, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "user", "_version": 1 } }

// 2. READ
→ { "id": 2, "type": "store.get", "bucket": "users", "key": "xyz" }
← { "id": 2, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "user", "_version": 1 } }

// 3. UPDATE
→ { "id": 3, "type": "store.update", "bucket": "users", "key": "xyz", "data": { "role": "admin" } }
← { "id": 3, "type": "result", "data": { "id": "xyz", "name": "Bob", "role": "admin", "_version": 2 } }

// 4. DELETE
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "xyz" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// 5. OVĚŘENÍ SMAZÁNÍ
→ { "id": 5, "type": "store.get", "bucket": "users", "key": "xyz" }
← { "id": 5, "type": "result", "data": null }
```

## Sledování verzí

Každý záznam má pole `_version`:
- Začíná na `1` při vložení
- Při každé aktualizaci se zvýší o 1
- Používá se pro optimistickou souběžnost v transakcích (viz část 6)

## Konzistence mezi klienty

Data jsou sdílená mezi všemi připojeními. Vložení jedním klientem je okamžitě viditelné pro ostatní:

```text
Client A                             Server                           Client B
   │                                    │                                │
   │── insert { name: "Carol" } ──────►│                                │
   │◄── result { id: "c1", ... } ──────│                                │
   │                                    │                                │
   │                                    │◄── get { key: "c1" } ─────────│
   │                                    │──► result { name: "Carol" } ──►│
```

## Cvičení

Napište posloupnost WebSocket zpráv, které:
1. Vloží uživatele se jménem "Eve" a emailem "eve@example.com"
2. Aktualizují roli uživatele na "moderator"
3. Načtou uživatele pro ověření aktualizace
4. Smažou uživatele
5. Znovu načtou pro potvrzení smazání

<details>
<summary>Řešení</summary>

```jsonc
// 1. Insert
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Eve", "email": "eve@example.com" } }
← { "id": 1, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "user", "_version": 1 } }

// 2. Update role
→ { "id": 2, "type": "store.update", "bucket": "users",
    "key": "e1", "data": { "role": "moderator" } }
← { "id": 2, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "moderator", "_version": 2 } }

// 3. Čtení pro ověření
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "e1" }
← { "id": 3, "type": "result",
    "data": { "id": "e1", "name": "Eve", "email": "eve@example.com", "role": "moderator", "_version": 2 } }

// 4. Smazání
→ { "id": 4, "type": "store.delete", "bucket": "users", "key": "e1" }
← { "id": 4, "type": "result", "data": { "deleted": true } }

// 5. Ověření smazání
→ { "id": 5, "type": "store.get", "bucket": "users", "key": "e1" }
← { "id": 5, "type": "result", "data": null }
```

</details>

## Shrnutí

- `store.insert` — vytvoří záznam, vrátí ho s vygenerovanými poli a `_version: 1`
- `store.get` — načte podle klíče, vrátí `null` (ne chybu) pokud nenalezeno
- `store.update` — částečná aktualizace, zachová neuvedená pole, zvýší `_version`
- `store.delete` — smaže záznam, vrátí `{ deleted: true }`
- Všechny operace vyžadují `bucket`; insert potřebuje `data`; get/update/delete potřebují `key`
- Data jsou sdílená mezi všemi připojeními — zápisy jsou okamžitě viditelné

---

Další: [Dotazy a filtrování](./02-dotazy-a-filtrovani.md)
