# Stránkování a agregace

Pro velké datasety potřebujete stránkování. Pro analytiku potřebujete agregace. Tato kapitola pokrývá obojí.

## Co se naučíte

- Jak získat prvních/posledních N záznamů
- Jak funguje stránkování pomocí cursor
- Jak vypočítat sum, avg, min, max nad numerickými poli

## store.first / store.last

Získejte prvních nebo posledních N záznamů z bucket.

```jsonc
// Prvních 2 záznamů
→ { "id": 1, "type": "store.first", "bucket": "users", "n": 2 }
← { "id": 1, "type": "result", "data": [
    { "id": "u1", "name": "Alice", ... },
    { "id": "u2", "name": "Bob", ... }
  ] }

// Posledních 2 záznamů
→ { "id": 2, "type": "store.last", "bucket": "users", "n": 2 }
← { "id": 2, "type": "result", "data": [
    { "id": "u4", "name": "Dave", ... },
    { "id": "u5", "name": "Eve", ... }
  ] }
```

**Povinná pole:** `bucket`, `n` (kladné celé číslo)

Pokud `n` přesáhne celkový počet, vrátí se všechny záznamy. `n: 0` nebo záporné hodnoty vrací `VALIDATION_ERROR`.

## store.paginate

Stránkování pomocí cursor pro iteraci záznamy po stránkách.

**První stránka:**

```jsonc
→ { "id": 3, "type": "store.paginate", "bucket": "users", "limit": 2 }
← { "id": 3, "type": "result", "data": {
    "records": [
      { "id": "u1", "name": "Alice", ... },
      { "id": "u2", "name": "Bob", ... }
    ],
    "hasMore": true,
    "nextCursor": "eyJ..."
  } }
```

**Další stránka** (s použitím `nextCursor` z předchozí odpovědi):

```jsonc
→ { "id": 4, "type": "store.paginate", "bucket": "users", "limit": 2, "after": "eyJ..." }
← { "id": 4, "type": "result", "data": {
    "records": [
      { "id": "u3", "name": "Carol", ... },
      { "id": "u4", "name": "Dave", ... }
    ],
    "hasMore": true,
    "nextCursor": "eyK..."
  } }
```

**Poslední stránka:**

```jsonc
→ { "id": 5, "type": "store.paginate", "bucket": "users", "limit": 2, "after": "eyK..." }
← { "id": 5, "type": "result", "data": {
    "records": [
      { "id": "u5", "name": "Eve", ... }
    ],
    "hasMore": false
  } }
```

**Povinná pole:** `bucket`, `limit`
**Volitelná pole:** `after` (cursor z předchozí stránky)

Když je `hasMore` rovno `false`, žádné další stránky neexistují. Pole `nextCursor` na poslední stránce chybí.

### Stránkovací smyčka

```typescript
let cursor: string | undefined;
const allRecords = [];

do {
  const payload: Record<string, unknown> = {
    type: 'store.paginate',
    bucket: 'users',
    limit: 100,
  };
  if (cursor) payload.after = cursor;

  const resp = await sendRequest(ws, payload);
  allRecords.push(...resp.data.records);
  cursor = resp.data.hasMore ? resp.data.nextCursor : undefined;
} while (cursor);

console.log(`Fetched ${allRecords.length} records`);
```

## Agregace

Počítejte numerické agregace nad záznamy v bucket.

### store.sum

```jsonc
→ { "id": 6, "type": "store.sum", "bucket": "products", "field": "price" }
← { "id": 6, "type": "result", "data": 60 }
```

### store.avg

```jsonc
→ { "id": 7, "type": "store.avg", "bucket": "products", "field": "price" }
← { "id": 7, "type": "result", "data": 20 }
```

### store.min

```jsonc
→ { "id": 8, "type": "store.min", "bucket": "products", "field": "price" }
← { "id": 8, "type": "result", "data": 5 }
```

### store.max

```jsonc
→ { "id": 9, "type": "store.max", "bucket": "products", "field": "price" }
← { "id": 9, "type": "result", "data": 99 }
```

**Povinná pole:** `bucket`, `field`
**Volitelná pole:** `filter`

Všechny agregace přijímají volitelný `filter` pro zúžení datasetu:

```jsonc
// Součet cen kde stock >= 100
→ { "id": 10, "type": "store.sum", "bucket": "products", "field": "price",
    "filter": { "stock": 100 } }
← { "id": 10, "type": "result", "data": 5 }
```

**Chování pro prázdný bucket:** `min` a `max` vrací `null` pro prázdné bucket. `sum` vrací `0`. `avg` vrací `0` nebo `null` v závislosti na datasetu.

## Funkční příklad

```typescript
// Seed products
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Widget', price: 10, stock: 50 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Gadget', price: 25, stock: 30 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'products', data: { title: 'Doohickey', price: 5, stock: 100 } });

// Agregace
const total = await sendRequest(ws, { type: 'store.sum', bucket: 'products', field: 'price' });
console.log('Total value:', total.data); // 40

const avg = await sendRequest(ws, { type: 'store.avg', bucket: 'products', field: 'price' });
console.log('Avg price:', avg.data); // ~13.33

const cheapest = await sendRequest(ws, { type: 'store.min', bucket: 'products', field: 'price' });
console.log('Cheapest:', cheapest.data); // 5

const priciest = await sendRequest(ws, { type: 'store.max', bucket: 'products', field: 'price' });
console.log('Most expensive:', priciest.data); // 25

// Stránkování
const page1 = await sendRequest(ws, { type: 'store.paginate', bucket: 'products', limit: 2 });
console.log('Page 1:', page1.data.records.length, 'hasMore:', page1.data.hasMore);
```

## Cvičení

Dejme tomu, že máte bucket `orders` s poli `id`, `total`, `status`, `customerId`. Napište zprávy, které:
1. Zjistí součet všech objednávek
2. Zjistí průměrnou hodnotu objednávek se statusem "completed"
3. Zjistí maximální hodnotu objednávky
4. Prostránkují všechny objednávky po 10

<details>
<summary>Řešení</summary>

```jsonc
// 1. Součet všech objednávek
→ { "id": 1, "type": "store.sum", "bucket": "orders", "field": "total" }

// 2. Průměr dokončených objednávek
→ { "id": 2, "type": "store.avg", "bucket": "orders", "field": "total",
    "filter": { "status": "completed" } }

// 3. Maximální objednávka
→ { "id": 3, "type": "store.max", "bucket": "orders", "field": "total" }

// 4. První stránka
→ { "id": 4, "type": "store.paginate", "bucket": "orders", "limit": 10 }
// Pokud hasMore je true, pošlete:
→ { "id": 5, "type": "store.paginate", "bucket": "orders", "limit": 10, "after": "<nextCursor>" }
```

</details>

## Shrnutí

- `store.first`/`store.last` — získání N záznamů od začátku nebo konce
- `store.paginate` — stránkování pomocí cursor s `limit`, `after`, `hasMore`, `nextCursor`
- `store.sum`/`store.avg`/`store.min`/`store.max` — numerické agregace nad polem
- Všechny agregace podporují volitelný `filter`
- `min`/`max` vrací `null` pro prázdné datasety

---

Další: [Metadata a statistiky](./04-metadata-a-statistiky.md)
