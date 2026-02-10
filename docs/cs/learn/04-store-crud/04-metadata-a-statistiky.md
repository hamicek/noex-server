# Metadata a statistiky

Prozkoumejte strukturu a statistiky store a spravujte data v bucket pomocí `clear`.

## Co se naučíte

- Jak vypsat definované bucket pomocí `store.buckets`
- Jak získat statistiky store pomocí `store.stats`
- Jak vymazat všechny záznamy z bucket pomocí `store.clear`

## store.buckets

Vypíše všechny definované bucket včetně jejich počtu.

```jsonc
→ { "id": 1, "type": "store.buckets" }
← { "id": 1, "type": "result", "data": {
    "count": 2,
    "names": ["users", "products"]
  } }
```

Žádná další pole nejsou potřeba — stačí `type: "store.buckets"`.

To se hodí pro introspekci: zjištění, jaké bucket na serveru existují, aniž byste to museli vědět předem.

## store.stats

Vrátí agregované statistiky store.

```jsonc
→ { "id": 2, "type": "store.stats" }
← { "id": 2, "type": "result", "data": {
    "buckets": {
      "users": { "count": 42 },
      "products": { "count": 150 }
    },
    "records": { "total": 192 }
  } }
```

Přesný tvar objektu statistik závisí na implementaci store, ale vždy obsahuje počty záznamů na úrovni jednotlivých bucket.

## store.clear

Odstraní všechny záznamy z bucket. Vrátí `{ cleared: true }`.

```jsonc
→ { "id": 3, "type": "store.clear", "bucket": "users" }
← { "id": 3, "type": "result", "data": { "cleared": true } }
```

**Povinná pole:** `bucket`

**Důležité:** Vymazání jednoho bucket neovlivní ostatní bucket:

```jsonc
// users má 3 záznamy, products má 5 záznamů
→ { "id": 4, "type": "store.clear", "bucket": "users" }
← { "id": 4, "type": "result", "data": { "cleared": true } }

// users je nyní prázdný, products má stále 5
→ { "id": 5, "type": "store.count", "bucket": "users" }
← { "id": 5, "type": "result", "data": 0 }

→ { "id": 6, "type": "store.count", "bucket": "products" }
← { "id": 6, "type": "result", "data": 5 }
```

`store.clear` je destruktivní operace. V produkci zvažte její omezení pomocí oprávnění:

```typescript
permissions: {
  check: (session, operation) => {
    if (operation === 'store.clear') {
      return session.roles.includes('admin');
    }
    return true;
  },
},
```

## Funkční příklad

```typescript
// Inspekce store
const buckets = await sendRequest(ws, { type: 'store.buckets' });
console.log('Buckets:', buckets.data.names);
// ["users", "products"]

const stats = await sendRequest(ws, { type: 'store.stats' });
console.log('Stats:', stats.data);
// { buckets: { users: { count: 42 }, products: { count: 150 } }, records: { total: 192 } }

// Vymazání bucket
await sendRequest(ws, { type: 'store.clear', bucket: 'users' });

// Ověření
const count = await sendRequest(ws, { type: 'store.count', bucket: 'users' });
console.log('Users after clear:', count.data); // 0
```

## Kompletní přehled operací (část 4)

| Operace | Povinná pole | Volitelná pole | Vrací |
|-----------|----------------|-----------------|---------|
| `store.insert` | `bucket`, `data` | — | Záznam s vygenerovanými poli |
| `store.get` | `bucket`, `key` | — | Záznam nebo `null` |
| `store.update` | `bucket`, `key`, `data` | — | Aktualizovaný záznam |
| `store.delete` | `bucket`, `key` | — | `{ deleted: true }` |
| `store.all` | `bucket` | — | Pole záznamů |
| `store.where` | `bucket`, `filter` | — | Pole odpovídajících záznamů |
| `store.findOne` | `bucket`, `filter` | — | Záznam nebo `null` |
| `store.count` | `bucket` | `filter` | Číslo |
| `store.first` | `bucket`, `n` | — | Pole záznamů |
| `store.last` | `bucket`, `n` | — | Pole záznamů |
| `store.paginate` | `bucket`, `limit` | `after` | `{ records, hasMore, nextCursor? }` |
| `store.sum` | `bucket`, `field` | `filter` | Číslo |
| `store.avg` | `bucket`, `field` | `filter` | Číslo |
| `store.min` | `bucket`, `field` | `filter` | Číslo nebo `null` |
| `store.max` | `bucket`, `field` | `filter` | Číslo nebo `null` |
| `store.buckets` | — | — | `{ count, names }` |
| `store.stats` | — | — | Objekt statistik |
| `store.clear` | `bucket` | — | `{ cleared: true }` |

## Cvičení

Napište monitorovací skript, který se připojí k serveru a pravidelně:
1. Vypíše všechny bucket
2. Zjistí počet záznamů na bucket
3. Vytiskne souhrn

<details>
<summary>Řešení</summary>

```typescript
async function monitor(ws: WebSocket) {
  const buckets = await sendRequest(ws, { type: 'store.buckets' });

  console.log(`=== Store Monitor ===`);
  console.log(`Buckets: ${buckets.data.count}`);

  for (const name of buckets.data.names) {
    const count = await sendRequest(ws, { type: 'store.count', bucket: name });
    console.log(`  ${name}: ${count.data} records`);
  }

  const stats = await sendRequest(ws, { type: 'store.stats' });
  console.log(`Total records: ${stats.data.records.total}`);
}

// Spouštět každých 10 sekund
setInterval(() => monitor(ws), 10_000);
```

</details>

## Shrnutí

- `store.buckets` — zjištění definovaných bucket (`{ count, names }`)
- `store.stats` — agregované statistiky store
- `store.clear` — odstranění všech záznamů z jednoho bucket (ostatní bucket nejsou ovlivněny)
- V produkci zvažte omezení `store.clear` pomocí oprávnění
- Části 1–4 pokrývají všech 18 store operací pro CRUD, dotazy, stránkování, agregace a metadata

---

Další: [Odběr dotazů](../05-subscriptions/01-odber-dotazu.md)
