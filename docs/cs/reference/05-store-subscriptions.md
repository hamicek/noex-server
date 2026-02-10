# Store subscriptions

Reaktivní subscriptions na pojmenované dotazy, životní cyklus subscriptions, push notifikace a atomické transakce.

---

## store.subscribe

Přihlásí se k odběru pojmenovaného dotazu definovaného na store. Vrátí `subscriptionId` a počáteční výsledek dotazu. Následné změny, které ovlivní výsledek dotazu, vyvolají `PushMessage` rámce na kanálu `"subscription"`.

**Požadavek:**

```json
{
  "id": 1,
  "type": "store.subscribe",
  "query": "all-users"
}
```

**Požadavek (s parametry):**

```json
{
  "id": 2,
  "type": "store.subscribe",
  "query": "users-by-role",
  "params": { "role": "admin" }
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| query | `string` | ano | Název dotazu definovaného přes `store.defineQuery()`. |
| params | `unknown` | ne | Parametry předané funkci dotazu. |

**Odpověď:**

```json
{
  "id": 1,
  "type": "result",
  "data": {
    "subscriptionId": "sub-1",
    "data": [
      { "id": "a1", "name": "Alice" },
      { "id": "b2", "name": "Bob" }
    ]
  }
}
```

Pole `data` obsahuje počáteční výsledek dotazu. Jeho tvar závisí na definici dotazu — může to být pole, číslo, objekt nebo jakákoliv jiná hodnota.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí pole `query`. |
| `QUERY_NOT_DEFINED` | Pojmenovaný dotaz neexistuje. |
| `RATE_LIMITED` | Dosažen limit subscriptions na spojení (výchozí: 100). |

---

## Push mechanismus

Když se podkladová data změní a přihlášený dotaz produkuje nový výsledek, server odešle `PushMessage`:

```json
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [
    { "id": "a1", "name": "Alice" },
    { "id": "b2", "name": "Bob" },
    { "id": "c3", "name": "Carol" }
  ]
}
```

Push zprávy se odesílají pouze tehdy, když se výsledek dotazu skutečně změní. Pokud mutace neovlivní výsledek přihlášeného dotazu, push se neodešle.

Push zprávy nejsou korelovány s žádným požadavkem — nemají pole `id`. Pole `subscriptionId` a `channel` identifikují, která subscription notifikaci vyprodukovala.

Na jednom spojení může být aktivních více subscriptions. Každá přijímá své push zprávy nezávisle.

---

## store.unsubscribe

Zruší aktivní subscription. Po odhlášení se pro tuto subscription neodesílají žádné další push zprávy.

**Požadavek:**

```json
{
  "id": 3,
  "type": "store.unsubscribe",
  "subscriptionId": "sub-1"
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| subscriptionId | `string` | ano | ID subscription vrácené z `store.subscribe`. |

**Odpověď:**

```json
{
  "id": 3,
  "type": "result",
  "data": { "unsubscribed": true }
}
```

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `subscriptionId`. |
| `NOT_FOUND` | Subscription neexistuje (již odhlášena nebo neplatné ID). |

---

## Úklid subscriptions

Když se klient odpojí, všechny jeho subscriptions se automaticky vyčistí. Není nutné explicitně odhlašovat subscriptions před uzavřením spojení.

---

## store.transaction

Provede více operací atomicky v rámci jedné transakce. Buď všechny operace uspějí a jsou potvrzeny, nebo se při selhání celá transakce vrátí zpět.

**Požadavek:**

```json
{
  "id": 4,
  "type": "store.transaction",
  "operations": [
    { "op": "insert", "bucket": "users", "data": { "name": "Alice" } },
    { "op": "insert", "bucket": "logs", "data": { "action": "user_created" } }
  ]
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| operations | `array` | ano | Pole objektů operací. Musí obsahovat alespoň jednu operaci. |

### Transakční operace

Každá operace v poli `operations` musí mít pole `op` a `bucket`. Další pole závisí na typu operace.

| op | Povinná pole | Popis |
|----|--------------|-------|
| `get` | `bucket`, `key` | Přečte záznam podle klíče. Vrátí `null`, pokud neexistuje. |
| `insert` | `bucket`, `data` | Vloží nový záznam. |
| `update` | `bucket`, `key`, `data` | Aktualizuje existující záznam podle klíče. |
| `delete` | `bucket`, `key` | Smaže záznam podle klíče. Vrátí `{ deleted: true }`. |
| `where` | `bucket`, `filter` | Filtruje záznamy podle hodnot polí. |
| `findOne` | `bucket`, `filter` | Vrátí první odpovídající záznam nebo `null`. |
| `count` | `bucket` | Spočítá záznamy. Volitelné pole `filter`. |

**Odpověď:**

```json
{
  "id": 4,
  "type": "result",
  "data": {
    "results": [
      { "index": 0, "data": { "id": "a1", "name": "Alice", "_version": 1 } },
      { "index": 1, "data": { "id": "x1", "action": "user_created", "_version": 1 } }
    ]
  }
}
```

Pole `results` obsahuje jednu položku na operaci, ve stejném pořadí jako vstup. Každá položka má `index` (od 0) a `data` (výsledek operace).

### Čtení vlastních zápisů

Operace v rámci transakce mohou číst výsledky předchozích operací. Například `update` následovaný `get` pro stejný klíč vrátí aktualizovaný záznam:

```json
{
  "id": 5,
  "type": "store.transaction",
  "operations": [
    { "op": "update", "bucket": "users", "key": "u1", "data": { "credits": 200 } },
    { "op": "get", "bucket": "users", "key": "u1" }
  ]
}
```

### Rollback

Pokud jakákoliv operace v rámci transakce selže (např. chyba validace schématu), celá transakce se vrátí zpět — žádné změny nejsou uloženy.

### Push po potvrzení transakce

Potvrzené transakce spouštějí push notifikace subscriptions stejně jako jednotlivé mutace. Pokud transakce vloží dva záznamy do přihlášeného bucketu, odběratelé obdrží jeden push s aktualizovaným výsledkem dotazu.

**Chyby:**

| Kód | Příčina |
|-----|---------|
| `VALIDATION_ERROR` | Chybí `operations`, prázdné pole, neplatný formát operace, chybějící povinná pole v operacích. |
| `CONFLICT` | Transakční konflikt (souběžná modifikace stejného záznamu). |
| `INTERNAL_ERROR` | Neznámý bucket v kontextu transakce. |

---

## Viz také

- [Store operace](./04-store-operations.md) — CRUD, dotazy a agregace
- [Protokol](./03-protocol.md) — Formát PushMessage a životní cyklus spojení
- [Chyby](./10-errors.md) — Chybové kódy
- [Konfigurace](./02-configuration.md) — `connectionLimits.maxSubscriptionsPerConnection`
