# Transakční vzory

Běžné reálné vzory využívající atomické transakce: cross-bucket operace, nákupní workflow a elegantní zpracování chyb.

## Co se naučíte

- Cross-bucket transakce (např. převod mezi účty)
- Vzor nákupu: odečtení kreditů, snížení skladu, zalogování akce
- Sledování verzí a optimistická souběžnost
- Chování při rollbacku a jak se zotavit z chyb
- Transakce + subscriptions: push po commitu

## Nastavení serveru

Stejné jako v [předchozí kapitole](./01-atomicke-operace.md), se třemi buckety: `users`, `products` a `logs`.

## Cross-bucket operace

Jedna transakce může atomicky modifikovat záznamy napříč více buckety. To je nezbytné pro operace, které musí být konzistentní — jako převod kreditů mezi uživateli:

```jsonc
// Převod 50 kreditů od Alice k Bobovi
→ { "id": 1, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 450 } },
      { "op": "update", "bucket": "users", "key": "bob-id",
        "data": { "credits": 150 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "transfer", "userId": "alice-id" } }
    ]
  }

← { "id": 1, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "name": "Alice", "credits": 450, "_version": 2 } },
        { "index": 1, "data": { "id": "bob-id", "name": "Bob", "credits": 150, "_version": 2 } },
        { "index": 2, "data": { "id": "l1", "action": "transfer", "userId": "alice-id", "_version": 1 } }
      ]
    }
  }
```

Pokud insert do logu selže, ani jedna aktualizace kreditů se nepersistuje.

## Vzor nákupu

Běžný e-commerce vzor: odečtení kreditů uživatele, snížení skladu produktu a zalogování nákupu — vše atomicky:

```jsonc
// Alice kupuje Widget (cena: 100, aktuální sklad: 10)
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 400 } },
      { "op": "update", "bucket": "products", "key": "widget-id",
        "data": { "stock": 9 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "purchase", "userId": "alice-id" } }
    ]
  }

← { "id": 2, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "credits": 400, "_version": 3 } },
        { "index": 1, "data": { "id": "widget-id", "title": "Widget", "stock": 9, "_version": 2 } },
        { "index": 2, "data": { "id": "l2", "action": "purchase", "_version": 1 } }
      ]
    }
  }
```

Tři buckety, jedna atomická operace. Pokud jakýkoli krok selže, kredity uživatele se neodečtou a sklad se nesníží.

## Read-modify-write

Když potřebujete přečíst hodnotu před její úpravou, udělejte to v rámci transakce pro zajištění konzistence:

```jsonc
// Čtení aktuálních kreditů, pak aktualizace na základě hodnoty
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "alice-id" },
      { "op": "update", "bucket": "users", "key": "alice-id",
        "data": { "credits": 300 } }
    ]
  }

← { "id": 3, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "alice-id", "credits": 400, "_version": 3 } },
        { "index": 1, "data": { "id": "alice-id", "credits": 300, "_version": 4 } }
      ]
    }
  }
```

V praxi klient přečte aktuální hodnotu (index 0), vypočítá novou hodnotu a odešle aktualizaci (index 1). Jelikož obojí proběhne atomicky, žádný jiný klient nemůže hodnotu mezitím změnit.

## Sledování verzí

Každý záznam má pole `_version`, které se zvyšuje při každé aktualizaci:

```text
insert → _version: 1
update → _version: 2
update → _version: 3
...
```

V rámci transakce store sleduje, jaká verze byla poprvé přečtena, a použije ji při commitu. Pokud jiný klient mezitím stejný záznam změnil, vrátí se chyba `CONFLICT` a celá transakce se vrátí zpět.

```text
Client A                    Store                    Client B
   │                          │                          │
   │── tx: get user ────────►│   (_version: 2)          │
   │                          │                          │
   │                          │◄── update user ──────────│
   │                          │    (_version: 2 → 3)     │
   │                          │                          │
   │── tx: update user ─────►│   (očekává v2, skutečná v3)│
   │◄── CONFLICT ─────────────│                          │
```

Toto je optimistická souběžnost: transakce nedrží zámky, ale detekuje konflikty v okamžiku commitu.

## Zotavení z chyb

Při selhání transakce je standardní vzor zotavení:

1. **Znovu přečíst** aktuální stav
2. **Přepočítat** nové hodnoty na základě čerstvých dat
3. **Opakovat** transakci

```typescript
async function purchaseWithRetry(ws, userId, productId, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. Čtení aktuálního stavu
    const readResp = await sendRequest(ws, {
      type: 'store.transaction',
      operations: [
        { op: 'get', bucket: 'users', key: userId },
        { op: 'get', bucket: 'products', key: productId },
      ],
    });

    const user = readResp.data.results[0].data;
    const product = readResp.data.results[1].data;

    if (user.credits < product.price) {
      throw new Error('Nedostatek kreditů');
    }
    if (product.stock < 1) {
      throw new Error('Vyprodáno');
    }

    // 2. Pokus o nákup
    const txResp = await sendRequest(ws, {
      type: 'store.transaction',
      operations: [
        { op: 'update', bucket: 'users', key: userId,
          data: { credits: user.credits - product.price } },
        { op: 'update', bucket: 'products', key: productId,
          data: { stock: product.stock - 1 } },
        { op: 'insert', bucket: 'logs',
          data: { action: 'purchase', userId } },
      ],
    });

    if (txResp.type === 'result') {
      return txResp.data; // úspěch
    }

    if (txResp.code === 'CONFLICT') {
      continue; // opakovat s čerstvými daty
    }

    throw new Error(txResp.message); // neopakovatelná chyba
  }

  throw new Error('Překročen maximální počet pokusů');
}
```

## Transakce + subscriptions

Transakce spouštějí push zprávy pro subscriptions stejně jako jednotlivé mutace. Po commitu transakce všechny dotčené subscriptions obdrží push zprávy:

```jsonc
// Odběr all-users
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// Vložení dvou uživatelů přes transakci
→ { "id": 2, "type": "store.transaction",
    "operations": [
      { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
      { "op": "insert", "bucket": "users", "data": { "name": "Bob" } }
    ]
  }
← { "id": 2, "type": "result",
    "data": { "results": [ ... ] } }

// Jeden push s oběma uživateli (kompletní výsledek, ne per-operace)
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice", "role": "user", ... },
      { "id": "b1", "name": "Bob", "role": "user", ... }
    ]
  }
```

Push obsahuje finální výsledek po celé transakci — ne mezistav.

## Vzor delete + insert

Někdy potřebujete atomicky nahradit záznam — smazat starý a vložit nový:

```jsonc
→ { "id": 4, "type": "store.transaction",
    "operations": [
      { "op": "delete", "bucket": "users", "key": "old-id" },
      { "op": "insert", "bucket": "users",
        "data": { "name": "Nový uživatel", "role": "admin" } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "user_replaced" } }
    ]
  }
```

## Hraniční případy

**Get vrací `null` pro neexistující klíče:**
```jsonc
→ { "id": 5, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "non-existent" }
    ]
  }
← { "id": 5, "type": "result",
    "data": { "results": [{ "index": 0, "data": null }] } }
```

**Delete je idempotentní:**
```jsonc
→ { "id": 6, "type": "store.transaction",
    "operations": [
      { "op": "delete", "bucket": "users", "key": "non-existent" }
    ]
  }
← { "id": 6, "type": "result",
    "data": { "results": [{ "index": 0, "data": { "deleted": true } }] } }
```

**Count s filtrem v transakci:**
```jsonc
→ { "id": 7, "type": "store.transaction",
    "operations": [
      { "op": "count", "bucket": "users", "filter": { "role": "admin" } }
    ]
  }
← { "id": 7, "type": "result",
    "data": { "results": [{ "index": 0, "data": 2 }] } }
```

## Cvičení

Napište workflow nákupní transakce:
1. Vložte uživatele Alice s 500 kredity
2. Vložte produkt "Laptop" s cenou 300 a skladem 5
3. Proveďte transakci, která: odečte kredity, sníží sklad a zaloguje nákup
4. Ověřte zbývající kredity Alice (200) a sklad produktu (4) přečtením v druhé transakci

<details>
<summary>Řešení</summary>

```jsonc
// 1. Vložení Alice
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice", "credits": 500 } }
← { "id": 1, "type": "result",
    "data": { "id": "a1", "name": "Alice", "credits": 500, "_version": 1 } }

// 2. Vložení Laptopu
→ { "id": 2, "type": "store.insert", "bucket": "products",
    "data": { "title": "Laptop", "price": 300, "stock": 5 } }
← { "id": 2, "type": "result",
    "data": { "id": "p1", "title": "Laptop", "price": 300, "stock": 5, "_version": 1 } }

// 3. Nákupní transakce
→ { "id": 3, "type": "store.transaction",
    "operations": [
      { "op": "update", "bucket": "users", "key": "a1",
        "data": { "credits": 200 } },
      { "op": "update", "bucket": "products", "key": "p1",
        "data": { "stock": 4 } },
      { "op": "insert", "bucket": "logs",
        "data": { "action": "purchase", "userId": "a1" } }
    ]
  }
← { "id": 3, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "p1", "title": "Laptop", "stock": 4, "_version": 2 } },
        { "index": 2, "data": { "id": "l1", "action": "purchase", "userId": "a1", "_version": 1 } }
      ]
    }
  }

// 4. Ověření přes transakční čtení
→ { "id": 4, "type": "store.transaction",
    "operations": [
      { "op": "get", "bucket": "users", "key": "a1" },
      { "op": "get", "bucket": "products", "key": "p1" }
    ]
  }
← { "id": 4, "type": "result",
    "data": {
      "results": [
        { "index": 0, "data": { "id": "a1", "name": "Alice", "credits": 200, "_version": 2 } },
        { "index": 1, "data": { "id": "p1", "title": "Laptop", "stock": 4, "_version": 2 } }
      ]
    }
  }
```

</details>

## Shrnutí

- **Cross-bucket transakce** zajišťují konzistenci napříč více buckety v jedné atomické operaci
- **Vzor nákupu:** aktualizace uživatele + aktualizace produktu + insert do logu — vše nebo nic
- **Read-modify-write:** čtení a pak aktualizace ve stejné transakci zabraňuje závodům
- **Sledování verzí** poskytuje optimistickou souběžnost — `CONFLICT` při neshodě verzí
- **Zotavení z chyb:** znovu přečíst, přepočítat, opakovat při `CONFLICT`
- **Subscriptions** obdrží jeden push per transakce s finálním výsledkem
- **Delete je idempotentní**, **get vrací `null`** pro neexistující klíče — i uvnitř transakcí

---

Další: [Nastavení rules](../07-rules/01-nastaveni.md)
