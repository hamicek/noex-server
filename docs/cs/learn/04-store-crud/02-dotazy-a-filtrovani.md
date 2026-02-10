# Dotazy a filtrování

Kromě CRUD operací nad jednotlivými záznamy poskytuje noex-server operace pro výpis, filtrování, vyhledávání a počítání záznamů.

## Co se naučíte

- Jak vypsat všechny záznamy pomocí `store.all`
- Jak filtrovat záznamy pomocí `store.where`
- Jak najít jednu shodu pomocí `store.findOne`
- Jak počítat záznamy pomocí `store.count`

## store.all

Vrátí všechny záznamy v bucket jako pole.

```jsonc
→ { "id": 1, "type": "store.all", "bucket": "users" }
← { "id": 1, "type": "result", "data": [
    { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 },
    { "id": "u2", "name": "Bob", "role": "user", "_version": 1 },
    { "id": "u3", "name": "Carol", "role": "user", "_version": 2 }
  ] }
```

Když bucket neobsahuje žádné záznamy, vrátí prázdné pole `[]` — ne chybu.

**Povinná pole:** `bucket`

## store.where

Filtruje záznamy podle hodnot polí. Vrátí všechny odpovídající záznamy jako pole.

```jsonc
→ { "id": 2, "type": "store.where", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 2, "type": "result", "data": [
    { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 }
  ] }
```

Objekt `filter` vybere záznamy, kde všechna zadaná pole odpovídají daným hodnotám (logické AND).

```jsonc
// Více polí ve filtru (AND)
→ { "id": 3, "type": "store.where", "bucket": "users",
    "filter": { "role": "user", "age": 30 } }
← { "id": 3, "type": "result", "data": [
    { "id": "u2", "name": "Bob", "role": "user", "age": 30, "_version": 1 }
  ] }
```

Když žádný záznam neodpovídá, vrátí `[]`.

**Povinná pole:** `bucket`, `filter`

## store.findOne

Vrátí první záznam odpovídající filtru, nebo `null` pokud nic neodpovídá.

```jsonc
// Nalezeno
→ { "id": 4, "type": "store.findOne", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 4, "type": "result",
    "data": { "id": "u1", "name": "Alice", "role": "admin", "_version": 1 } }

// Nenalezeno
→ { "id": 5, "type": "store.findOne", "bucket": "users",
    "filter": { "role": "superadmin" } }
← { "id": 5, "type": "result", "data": null }
```

**Povinná pole:** `bucket`, `filter`

Použijte `findOne`, když očekáváte nanejvýš jeden výsledek, nebo vás zajímá jen první shoda.

## store.count

Spočítá záznamy. Bez filtru spočítá všechny záznamy v bucket. S filtrem spočítá odpovídající záznamy.

```jsonc
// Počet všech
→ { "id": 6, "type": "store.count", "bucket": "users" }
← { "id": 6, "type": "result", "data": 3 }

// Počet s filtrem
→ { "id": 7, "type": "store.count", "bucket": "users",
    "filter": { "role": "admin" } }
← { "id": 7, "type": "result", "data": 1 }

// Prázdný bucket
→ { "id": 8, "type": "store.count", "bucket": "products" }
← { "id": 8, "type": "result", "data": 0 }
```

**Povinná pole:** `bucket`
**Volitelná pole:** `filter`

Výsledek je číslo, nikoli objekt nebo pole.

## Srovnání

| Operace | Vrací | Prázdný výsledek | Filter povinný |
|-----------|---------|-----------------|-----------------|
| `store.all` | Pole záznamů | `[]` | Ne |
| `store.where` | Pole odpovídajících záznamů | `[]` | Ano |
| `store.findOne` | Jeden záznam nebo null | `null` | Ano |
| `store.count` | Číslo | `0` | Volitelný |

## Funkční příklad

```typescript
// Seed data
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Alice', role: 'admin', age: 35 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Bob', role: 'user', age: 30 } });
await sendRequest(ws, { type: 'store.insert', bucket: 'users', data: { name: 'Carol', role: 'user', age: 25 } });

// Výpis všech
const all = await sendRequest(ws, { type: 'store.all', bucket: 'users' });
console.log(all.data.length); // 3

// Nalezení adminů
const admins = await sendRequest(ws, { type: 'store.where', bucket: 'users', filter: { role: 'admin' } });
console.log(admins.data.length); // 1

// Nalezení jednoho admina
const admin = await sendRequest(ws, { type: 'store.findOne', bucket: 'users', filter: { role: 'admin' } });
console.log(admin.data.name); // "Alice"

// Počet uživatelů s rolí "user"
const count = await sendRequest(ws, { type: 'store.count', bucket: 'users', filter: { role: 'user' } });
console.log(count.data); // 2
```

## Cvičení

Dejme tomu, že máte bucket `products` s poli `id`, `title`, `price`, `category`. Napište WebSocket zprávy, které:
1. Vypíšou všechny produkty
2. Najdou produkty v kategorii "electronics"
3. Najdou jeden produkt v kategorii "books"
4. Spočítají všechny produkty s cenou 0

<details>
<summary>Řešení</summary>

```jsonc
// 1. Všechny produkty
→ { "id": 1, "type": "store.all", "bucket": "products" }

// 2. Elektronika
→ { "id": 2, "type": "store.where", "bucket": "products", "filter": { "category": "electronics" } }

// 3. První kniha
→ { "id": 3, "type": "store.findOne", "bucket": "products", "filter": { "category": "books" } }

// 4. Počet produktů zdarma
→ { "id": 4, "type": "store.count", "bucket": "products", "filter": { "price": 0 } }
```

</details>

## Shrnutí

- `store.all` — všechny záznamy v bucket, vrátí `[]` pokud je prázdný
- `store.where` — filtrování podle hodnot polí (logika AND), vrátí `[]` pokud nic neodpovídá
- `store.findOne` — první shoda nebo `null`
- `store.count` — počet záznamů, volitelně s filtrem
- Všechny vracejí data přímo (žádná chyba pro prázdné výsledky)

---

Další: [Stránkování a agregace](./03-strankovani-a-agregace.md)
