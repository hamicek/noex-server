# Atomické operace

Provádějte více store operací v jedné atomické transakci — všechny uspějí, nebo všechny selžou. Žádné částečné zápisy, žádný nekonzistentní stav.

## Co se naučíte

- Formát zprávy `store.transaction`
- Podporované operace: get, insert, update, delete, where, findOne, count
- Strukturu odpovědi s indexovanými výsledky
- Read-your-own-writes v rámci transakce
- Pravidla validace a zpracování chyb

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'transactions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    name:    { type: 'string', required: true },
    role:    { type: 'string', default: 'user' },
    credits: { type: 'number', default: 0 },
  },
});

store.defineBucket('logs', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    action: { type: 'string', required: true },
    userId: { type: 'string' },
  },
});

store.defineBucket('products', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
    price: { type: 'number', default: 0 },
    stock: { type: 'number', default: 0 },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## store.transaction

Odešle dávku operací k atomickému provedení. Každá operace specifikuje typ `op`, `bucket` a pole specifická pro danou operaci.

```jsonc
// Request
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } }
    ]
  }

// Response
← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "role": "user", "credits": 0, "_version": 1 } },
        { "index": 1, "data": { "id": "b1", "name": "Bob", "role": "user", "credits": 0, "_version": 1 } }
      ]
    }
  }
```

**Povinná pole:** `operations` (neprázdné pole)

## Podporované operace

| op | Povinná pole | Volitelná | Vrací |
|----|-------------|-----------|-------|
| `get` | `bucket`, `key` | — | Záznam nebo `null` |
| `insert` | `bucket`, `data` | — | Vložený záznam |
| `update` | `bucket`, `key`, `data` | — | Aktualizovaný záznam |
| `delete` | `bucket`, `key` | — | `{ deleted: true }` |
| `where` | `bucket`, `filter` | — | Pole odpovídajících záznamů |
| `findOne` | `bucket`, `filter` | — | První shoda nebo `null` |
| `count` | `bucket` | `filter` | Číslo |

Každá operace se chová identicky jako její samostatný protějšek `store.*`, ale v rámci hranice transakce.

## Struktura odpovědi

Odpověď `data.results` je pole objektů, každý s:
- **`index`** — pozice operace v původním poli `operations` (od 0)
- **`data`** — výsledek dané operace

```jsonc
← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { ... } },  // výsledek operations[0]
        { "index": 1, "data": { ... } },  // výsledek operations[1]
        { "index": 2, "data": 3 }          // výsledek operations[2] (např. count)
      ]
    }
  }
```

## Read-your-own-writes

Operace v rámci transakce vidí výsledky předchozích operací ve stejné transakci. To umožňuje vzory read-modify-write:

```jsonc
// Aktualizace kreditů uživatele, pak čtení aktualizované hodnoty
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "a1",
        "data": { "credits": 200 } },
      { "op": "get", "bucket": "users", "key": "a1" }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } }
      ]
    }
  }
```

Čtení také vidí inserty ze stejné transakce:

```jsonc
// Vložení dvou uživatelů, pak count — vidí oba
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } },
      { "op": "count", "bucket": "users" }
    ]
  }

← { "id": 2, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", ... } },
        { "index": 1, "data": { "id": "b1", "name": "Bob", ... } },
        { "index": 2, "data": 2 }
      ]
    }
  }
```

## Vše nebo nic

Pokud jakákoli operace selže, celá transakce se vrátí zpět. Žádné částečné zápisy se nepersistují:

```jsonc
// Transakce: aktualizace skladu produktu + vložení uživatele bez povinného 'name'
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "products", "key": "p1",
        "data": { "stock": 4 } },
      { "op": "insert", "bucket": "users",
        "data": { "credits": 100 } }
    ]
  }

// Druhá operace selže (chybí povinné 'name') → celá transakce se vrátí zpět
← { "id": 3, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "..." }

// Sklad produktu je nezměněn — aktualizace byla vrácena zpět
→ { "id": 4, "type": "store.get", "bucket": "products", "key": "p1" }
← { "id": 4, "type": "result",
    "data": { "id": "p1", "title": "Widget", "stock": 5, ... } }
```

## Validace

Server validuje pole `operations` před provedením:

| Validace | Kód chyby |
|----------|-----------|
| `operations` chybí nebo není pole | `VALIDATION_ERROR` |
| `operations` je prázdné | `VALIDATION_ERROR` |
| Prvek není objekt | `VALIDATION_ERROR` |
| `op` chybí nebo není platný typ | `VALIDATION_ERROR` |
| `bucket` chybí nebo je prázdný | `VALIDATION_ERROR` |
| `key` chybí pro get/update/delete | `VALIDATION_ERROR` |
| `data` chybí pro insert/update | `VALIDATION_ERROR` |
| `filter` chybí pro where/findOne | `VALIDATION_ERROR` |

Chybové zprávy obsahují index operace pro snadné ladění:

```jsonc
→ { "id": 5, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "get", "bucket": "users" }
    ]
  }
← { "id": 5, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "operations[1]: \"get\" requires \"key\"" }
```

## Praktický příklad

```typescript
// Předem vložit uživatele
const insertResp = await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice', credits: 100 },
});
const userId = insertResp.data.id;

// Atomicky: aktualizace kreditů + záznam akce
const txResp = await sendRequest(ws, {
  type: 'store.transaction',
  operations: [
    { op: 'update', bucket: 'users', key: userId, data: { credits: 200 } },
    { op: 'insert', bucket: 'logs', data: { action: 'credit_update', userId } },
  ],
});

console.log(txResp.data.results[0].data.credits); // 200
console.log(txResp.data.results[1].data.action);  // "credit_update"
```

## Cvičení

Napište transakci, která:
1. Vloží uživatele "Alice" s rolí "admin"
2. Vloží záznam do logu s akcí "user_created"
3. Vyhledá všechny admin uživatele pomocí `where` a ověří, že Alice je zahrnuta
4. Spočítá celkový počet uživatelů

<details>
<summary>Řešení</summary>

```jsonc
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users",
        "data": { "name": "Alice", "role": "admin" } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "user_created" } },
      { "op": "where", "bucket": "users",
        "filter": { "role": "admin" } },
      { "op": "count", "bucket": "users" }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "role": "admin", "credits": 0, "_version": 1 } },
        { "index": 1, "data": { "id": "l1", "action": "user_created", "_version": 1 } },
        { "index": 2, "data": [{ "id": "a1", "name": "Alice", "role": "admin", "credits": 0, "_version": 1 }] },
        { "index": 3, "data": 1 }
      ]
    }
  }
```

Všimněte si:
- `where` (index 2) vidí Alice z insertu na indexu 0 (read-your-own-writes)
- `count` (index 3) vrací 1, což odráží insert v rámci transakce

</details>

## Shrnutí

- `store.transaction` provede více operací atomicky — vše nebo nic
- Podporované ops: `get`, `insert`, `update`, `delete`, `where`, `findOne`, `count`
- Odpověď `results` zrcadlí pořadí `operations` s `index` a `data`
- Read-your-own-writes: pozdější operace vidí předchozí zápisy ve stejné transakci
- Při selhání se všechny změny vrátí zpět — žádné částečné zápisy
- Chyby validace obsahují index operace (např. `operations[1]: ...`)

---

Další: [Transakční vzory](./02-transakcni-vzory.md)
