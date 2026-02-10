# Správa subscriptions

Řízení životního cyklu subscriptions: odhlášení, když již nepotřebujete aktualizace, porozumění limitům připojení a co se stane při odpojení klienta.

## Co se naučíte

- Jak se odhlásit pomocí `store.unsubscribe`
- Co se stane po odhlášení (žádné další pushe)
- Zpracování chyb při neplatném odhlášení
- Limity subscriptions per connection (`maxSubscriptionsPerConnection`)
- Automatický cleanup při odpojení klienta

## store.unsubscribe

Odstraní aktivní subscription. Po odhlášení se pro tuto subscription již neodesílají žádné push zprávy.

```jsonc
// Request
→ { "id": 1, "type": "store.unsubscribe", "subscriptionId": "sub-1" }

// Response
← { "id": 1, "type": "result", "data": { "unsubscribed": true } }
```

**Povinná pole:** `subscriptionId`

## Žádný push po odhlášení

Po odhlášení mutace již nespouštějí pushe pro danou subscription:

```jsonc
// 1. Přihlášení k odběru
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

// 2. Odhlášení
→ { "id": 2, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 2, "type": "result", "data": { "unsubscribed": true } }

// 3. Vložení uživatele — žádný push pro sub-1
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result", "data": { ... } }
// (žádný push — sub-1 je zrušena)
```

## Nezávislé subscriptions

Odhlášení jedné subscription neovlivní ostatní:

```jsonc
// Přihlášení ke dvěma dotazům
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// Odhlášení pouze od all-users
→ { "id": 3, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 3, "type": "result", "data": { "unsubscribed": true } }

// Vložení uživatele
→ { "id": 4, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 4, "type": "result", "data": { ... } }

// sub-2 stále dostává pushe
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }
// (žádný push pro sub-1 — je odhlášena)
```

## Zpracování chyb

| Kód chyby | Příčina |
|-----------|---------|
| `NOT_FOUND` | `subscriptionId` neodpovídá žádné aktivní subscription |
| `VALIDATION_ERROR` | Pole `subscriptionId` chybí nebo je prázdné |

```jsonc
// Neznámé subscription ID
→ { "id": 5, "type": "store.unsubscribe", "subscriptionId": "sub-nonexistent" }
← { "id": 5, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-nonexistent\" not found" }

// Dvojité odhlášení
→ { "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 6, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-1\" not found" }

// Chybějící subscriptionId
→ { "id": 7, "type": "store.unsubscribe" }
← { "id": 7, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"subscriptionId\": expected non-empty string" }
```

## Limity subscriptions

Každé připojení má maximální počet aktivních subscriptions (store + rules dohromady). Výchozí limit je **100**.

```typescript
const server = await NoexServer.start({
  store,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50, // vlastní limit
  },
});
```

Při překročení limitu server odpoví `RATE_LIMITED`:

```jsonc
// 101. subscription při výchozím nastavení
→ { "id": 101, "type": "store.subscribe", "query": "all-users" }
← { "id": 101, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 100 per connection)" }
```

Limit počítá store subscriptions i rules subscriptions dohromady na stejném připojení.

## Cleanup při odpojení

Když se klient odpojí (zavře WebSocket), server automaticky:
1. Zavolá funkci pro odhlášení u každé aktivní subscription na daném připojení
2. Vyčistí mapy subscriptions
3. Zavře WebSocket

Nemusíte se ručně odhlašovat před odpojením — server se o cleanup postará. To zabraňuje úniku zdrojů z opuštěných připojení.

```text
Client                               Server
   │                                    │
   │── subscribe "all-users" ─────────►│  (sub-1 vytvořena)
   │◄── { subscriptionId: "sub-1" }    │
   │                                    │
   │── subscribe "user-count" ────────►│  (sub-2 vytvořena)
   │◄── { subscriptionId: "sub-2" }    │
   │                                    │
   │── disconnect ─────────────────────►│
   │                                    │  (auto-cleanup: sub-1, sub-2 odstraněny)
   │                                    │  (budoucí mutace → žádné pushe)
```

## Praktický příklad

```typescript
// Vytvoření dvou subscriptions
const sub1 = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const sub1Id = sub1.data.subscriptionId;

const sub2 = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'user-count',
});
const sub2Id = sub2.data.subscriptionId;

// Odhlášení od první
const unsub = await sendRequest(ws, {
  type: 'store.unsubscribe',
  subscriptionId: sub1Id,
});
console.log(unsub.data); // { unsubscribed: true }

// Vložení uživatele — pouze sub2 (count) spustí push
const pushPromise = waitForPush(ws, sub2Id);
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});
const push = await pushPromise;
console.log(push.data); // 1
```

## Cvičení

Napište posloupnost demonstrující životní cyklus subscription:
1. Přihlaste se k odběru `all-users` a `user-count`
2. Vložte uživatele a ověřte, že obě subscriptions obdrží pushe
3. Odhlaste se od `all-users`
4. Vložte dalšího uživatele a ověřte, že pouze `user-count` obdrží push
5. Odhlaste se od `user-count`
6. Ověřte, že opětovné odhlášení od `all-users` vrátí `NOT_FOUND`

<details>
<summary>Řešení</summary>

```jsonc
// 1. Přihlášení k oběma
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result",
    "data": { "subscriptionId": "sub-1", "data": [] } }

→ { "id": 2, "type": "store.subscribe", "query": "user-count" }
← { "id": 2, "type": "result",
    "data": { "subscriptionId": "sub-2", "data": 0 } }

// 2. Insert → oba dostanou push
→ { "id": 3, "type": "store.insert", "bucket": "users",
    "data": { "name": "Alice" } }
← { "id": 3, "type": "result", "data": { "id": "a1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1",
    "data": [{ "id": "a1", "name": "Alice", "role": "user", "_version": 1 }] }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 1 }

// 3. Odhlášení od all-users
→ { "id": 4, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 4, "type": "result", "data": { "unsubscribed": true } }

// 4. Insert → pouze user-count dostane push
→ { "id": 5, "type": "store.insert", "bucket": "users",
    "data": { "name": "Bob" } }
← { "id": 5, "type": "result", "data": { "id": "b1", ... } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-2",
    "data": 2 }
// (žádný push pro sub-1)

// 5. Odhlášení od user-count
→ { "id": 6, "type": "store.unsubscribe", "subscriptionId": "sub-2" }
← { "id": 6, "type": "result", "data": { "unsubscribed": true } }

// 6. Dvojité odhlášení → NOT_FOUND
→ { "id": 7, "type": "store.unsubscribe", "subscriptionId": "sub-1" }
← { "id": 7, "type": "error",
    "code": "NOT_FOUND",
    "message": "Subscription \"sub-1\" not found" }
```

</details>

## Shrnutí

- `store.unsubscribe` zastaví push zprávy pro dané `subscriptionId`
- Odhlášení jedné subscription neovlivní ostatní
- `NOT_FOUND` pokud subscription neexistuje nebo již byla odhlášena
- Výchozí limit: 100 subscriptions per connection (store + rules dohromady), konfigurovatelný přes `connectionLimits.maxSubscriptionsPerConnection`
- Překročení limitu vrátí `RATE_LIMITED`
- Při odpojení server automaticky uklidí všechny subscriptions — ruční cleanup není potřeba

---

Další: [Atomické operace](../06-transakce/01-atomicke-operace.md)
