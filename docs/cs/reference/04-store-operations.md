# Store operace

CRUD operace, dotazy, agregace a administrační operace nad store, zpřístupněné přes WebSocket protokol. Každá operace je `ClientRequest` s `type` začínajícím `store.`.

---

## CRUD

### store.insert

Vloží nový záznam do bucketu. Vrátí vložený záznam s generovanými poli (`id`, `_version`, `_createdAt`, `_updatedAt`).

**Požadavek:**

```json
{
  "id": 1,
  "type": "store.insert",
  "bucket": "users",
  "data": { "name": "Alice", "email": "alice@example.com" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název cílového bucketu. |
| data | `object` | ano | Data záznamu. Musí splňovat schéma bucketu. |

**Odpověď:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "id": "a1b2c3d4",
    "name": "Alice",
    "email": "alice@example.com",
    "role": "user",
    "_version": 1,
    "_createdAt": 1700000000000,
    "_updatedAt": 1700000000000
  }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket`, `data`, nebo selhala validace schématu (např. chybějící povinné pole). |
| `BUCKET_NOT_DEFINED` | Bucket neexistuje v konfiguraci store. |
| `ALREADY_EXISTS` | Porušení unique constraint. |

---

### store.get

Načte jeden záznam podle klíče. Vrátí `null`, pokud klíč neexistuje.

**Požadavek:**

```json
{
  "id": 2,
  "type": "store.get",
  "bucket": "users",
  "key": "a1b2c3d4"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| key | `unknown` | ano | Klíč záznamu (typicky řetězec). Nesmí být `null` ani `undefined`. |

**Odpověď (nalezeno):**

```json
{
  "id": 2,
  "type": "result",
  "data": { "id": "a1b2c3d4", "name": "Alice", "_version": 1 }
}
```

**Odpověď (nenalezeno):**

```json
{
  "id": 2,
  "type": "result",
  "data": null
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket` nebo `key`. |
| `BUCKET_NOT_DEFINED` | Bucket neexistuje. |

---

### store.update

Aktualizuje existující záznam podle klíče. Vrátí aktualizovaný záznam s inkrementovanou `_version`.

**Požadavek:**

```json
{
  "id": 3,
  "type": "store.update",
  "bucket": "users",
  "key": "a1b2c3d4",
  "data": { "name": "Alice Updated", "role": "admin" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| key | `unknown` | ano | Klíč záznamu. Nesmí být `null` ani `undefined`. |
| data | `object` | ano | Pole k aktualizaci. Sloučí se s existujícím záznamem. |

**Odpověď:**

```json
{
  "id": 3,
  "type": "result",
  "data": {
    "id": "a1b2c3d4",
    "name": "Alice Updated",
    "role": "admin",
    "_version": 2,
    "_updatedAt": 1700000001000
  }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket`, `key` nebo `data`, nebo selhala validace schématu. |
| `BUCKET_NOT_DEFINED` | Bucket neexistuje. |

---

### store.delete

Smaže záznam podle klíče. Vrátí `{ deleted: true }` bez ohledu na to, zda záznam existoval.

**Požadavek:**

```json
{
  "id": 4,
  "type": "store.delete",
  "bucket": "users",
  "key": "a1b2c3d4"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| key | `unknown` | ano | Klíč záznamu. Nesmí být `null` ani `undefined`. |

**Odpověď:**

```json
{
  "id": 4,
  "type": "result",
  "data": { "deleted": true }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket` nebo `key`. |
| `BUCKET_NOT_DEFINED` | Bucket neexistuje. |

---

## Dotazy

### store.all

Vrátí všechny záznamy v bucketu jako pole.

**Požadavek:**

```json
{
  "id": 5,
  "type": "store.all",
  "bucket": "users"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |

**Odpověď:**

```json
{
  "id": 5,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" }
  ]
}
```

Vrátí prázdné pole `[]`, pokud je bucket prázdný.

---

### store.where

Filtruje záznamy podle hodnot polí.

**Požadavek:**

```json
{
  "id": 6,
  "type": "store.where",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| filter | `object` | ano | Páry klíč-hodnota pro porovnání s poli záznamu. |

**Odpověď:**

```json
{
  "id": 6,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice", "role": "admin" }
  ]
}
```

Vrátí prázdné pole `[]`, pokud žádné záznamy neodpovídají.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket` nebo `filter`. |

---

### store.findOne

Vrátí první záznam odpovídající filtru, nebo `null`, pokud žádný neodpovídá.

**Požadavek:**

```json
{
  "id": 7,
  "type": "store.findOne",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| filter | `object` | ano | Páry klíč-hodnota pro porovnání. |

**Odpověď (nalezeno):**

```json
{
  "id": 7,
  "type": "result",
  "data": { "id": "a1", "name": "Alice", "role": "admin" }
}
```

**Odpověď (nenalezeno):**

```json
{
  "id": 7,
  "type": "result",
  "data": null
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket` nebo `filter`. |

---

### store.count

Vrátí počet záznamů, volitelně filtrovaných.

**Požadavek (vše):**

```json
{
  "id": 8,
  "type": "store.count",
  "bucket": "users"
}
```

**Požadavek (filtrovaný):**

```json
{
  "id": 9,
  "type": "store.count",
  "bucket": "users",
  "filter": { "role": "admin" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| filter | `object` | ne | Volitelný filtr pro počítání pouze odpovídajících záznamů. |

**Odpověď:**

```json
{
  "id": 8,
  "type": "result",
  "data": 3
}
```

Vrátí `0` pro prázdný bucket nebo pokud žádné záznamy neodpovídají filtru.

---

### store.first

Vrátí prvních N záznamů (v pořadí vložení).

**Požadavek:**

```json
{
  "id": 10,
  "type": "store.first",
  "bucket": "users",
  "n": 2
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| n | `number` | ano | Počet záznamů. Musí být kladné celé číslo. |

**Odpověď:**

```json
{
  "id": 10,
  "type": "result",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" }
  ]
}
```

Pokud `n` přesáhne celkový počet, vrátí se všechny záznamy.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket`, chybí `n`, nebo `n` není kladné celé číslo. |

---

### store.last

Vrátí posledních N záznamů (v pořadí vložení).

**Požadavek:**

```json
{
  "id": 11,
  "type": "store.last",
  "bucket": "users",
  "n": 2
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| n | `number` | ano | Počet záznamů. Musí být kladné celé číslo. |

**Odpověď:**

```json
{
  "id": 11,
  "type": "result",
  "data": [
    { "id": "b2", "name": "Bob" },
    { "id": "c3", "name": "Carol" }
  ]
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket`, chybí `n`, nebo `n` není kladné celé číslo. |

---

### store.paginate

Stránkování založené na kurzoru. Vrátí stránku záznamů, příznak `hasMore` a volitelný `nextCursor` pro načtení další stránky.

**Požadavek (první stránka):**

```json
{
  "id": 12,
  "type": "store.paginate",
  "bucket": "users",
  "limit": 2
}
```

**Požadavek (další stránka):**

```json
{
  "id": 13,
  "type": "store.paginate",
  "bucket": "users",
  "limit": 2,
  "after": "cursor-from-previous-page"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| limit | `number` | ano | Maximum záznamů na stránku. Musí být kladné celé číslo. |
| after | `unknown` | ne | Kurzor z `nextCursor` předchozí odpovědi. Vynechte pro první stránku. |

**Odpověď:**

```json
{
  "id": 12,
  "type": "result",
  "data": {
    "records": [
      { "id": "a1", "name": "Alice" },
      { "id": "b2", "name": "Bob" }
    ],
    "hasMore": true,
    "nextCursor": "b2"
  }
}
```

Když je `hasMore` `false`, `nextCursor` není přítomen (nebo `undefined`).

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `bucket` nebo `limit`, nebo `limit` není kladné celé číslo. |

---

## Agregace

Všechny agregační operace přijímají volitelný `filter` pro zúžení množiny záznamů.

### store.sum

Vrátí součet číselného pole.

**Požadavek:**

```json
{
  "id": 14,
  "type": "store.sum",
  "bucket": "products",
  "field": "price"
}
```

**Požadavek (s filtrem):**

```json
{
  "id": 15,
  "type": "store.sum",
  "bucket": "products",
  "field": "price",
  "filter": { "stock": 100 }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| field | `string` | ano | Název číselného pole k součtu. |
| filter | `object` | ne | Volitelný filtr pro zahrnutí pouze odpovídajících záznamů. |

**Odpověď:**

```json
{
  "id": 14,
  "type": "result",
  "data": 60
}
```

---

### store.avg

Vrátí průměr číselného pole.

**Požadavek:**

```json
{
  "id": 16,
  "type": "store.avg",
  "bucket": "products",
  "field": "price"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| field | `string` | ano | Název číselného pole. |
| filter | `object` | ne | Volitelný filtr. |

**Odpověď:**

```json
{
  "id": 16,
  "type": "result",
  "data": 20
}
```

---

### store.min

Vrátí minimální hodnotu číselného pole. Vrátí `null`, pokud je bucket prázdný (nebo žádné záznamy neodpovídají filtru).

**Požadavek:**

```json
{
  "id": 17,
  "type": "store.min",
  "bucket": "products",
  "field": "price"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| field | `string` | ano | Název číselného pole. |
| filter | `object` | ne | Volitelný filtr. |

**Odpověď:**

```json
{
  "id": 17,
  "type": "result",
  "data": 5
}
```

**Odpověď (prázdný):**

```json
{
  "id": 17,
  "type": "result",
  "data": null
}
```

---

### store.max

Vrátí maximální hodnotu číselného pole. Vrátí `null`, pokud je bucket prázdný (nebo žádné záznamy neodpovídají filtru).

**Požadavek:**

```json
{
  "id": 18,
  "type": "store.max",
  "bucket": "products",
  "field": "price"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |
| field | `string` | ano | Název číselného pole. |
| filter | `object` | ne | Volitelný filtr. |

**Odpověď:**

```json
{
  "id": 18,
  "type": "result",
  "data": 99
}
```

---

## Administrace

### store.clear

Odstraní všechny záznamy z bucketu. Samotný bucket nesmaže.

**Požadavek:**

```json
{
  "id": 19,
  "type": "store.clear",
  "bucket": "users"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| bucket | `string` | ano | Název bucketu. |

**Odpověď:**

```json
{
  "id": 19,
  "type": "result",
  "data": { "cleared": true }
}
```

---

### store.buckets

Vypíše všechny definované buckety a jejich počet.

**Požadavek:**

```json
{
  "id": 20,
  "type": "store.buckets"
}
```

Žádná další pole nejsou vyžadována.

**Odpověď:**

```json
{
  "id": 20,
  "type": "result",
  "data": {
    "count": 2,
    "names": ["users", "products"]
  }
}
```

---

### store.stats

Vrátí statistiky store.

**Požadavek:**

```json
{
  "id": 21,
  "type": "store.stats"
}
```

Žádná další pole nejsou vyžadována.

**Odpověď:**

```json
{
  "id": 21,
  "type": "result",
  "data": {
    "buckets": { "count": 2, "names": ["users", "products"] },
    "records": { "users": 10, "products": 5 }
  }
}
```

---

## Společné chyby

Všechny store operace sdílejí tyto společné chybové scénáře:

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybějící nebo neplatné povinné pole (`bucket`, `key`, `data`, `field` atd.). |
| `BUCKET_NOT_DEFINED` | Požadovaný bucket není definován v konfiguraci store. |
| `UNKNOWN_OPERATION` | Hodnota `type` neodpovídá žádné známé `store.*` operaci. |

---

## Viz také

- [Store subscriptions](./05-store-subscriptions.md) — Reaktivní subscriptions a transakce
- [Protokol](./03-protocol.md) — Kompletní specifikace protokolu
- [Chyby](./10-errors.md) — Chybové kódy a třída chyby
- [Konfigurace](./02-configuration.md) — Konfigurace serveru
