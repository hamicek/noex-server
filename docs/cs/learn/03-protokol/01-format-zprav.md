# Format zprav

Každá zpráva v noex-server je JSON objekt odeslaný jako WebSocket textový frame. Tato kapitola popisuje strukturu všech typů zpráv v protokolu verze 1.0.0.

## Co se naučíte

- Formát JSON-over-WebSocket
- Čtyři kategorie zpráv a jejich struktury
- Jak rozpoznat, o jaký typ zprávy se jedná
- Verzování protokolu

## Verze protokolu

Aktuální verze protokolu je `1.0.0`. Server ji oznamuje ve welcome zprávě. Všechny zprávy dodržují struktury definované v této kapitole.

## Kategorie zpráv

### 1. Request (Client → Server)

Každý request musí obsahovat:
- `id` — číselný identifikátor (slouží ke korelaci s response)
- `type` — název operace (např. `"store.insert"`)
- Další pole závisí na konkrétní operaci

```jsonc
{ "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
{ "id": 2, "type": "store.get", "bucket": "users", "key": "abc123" }
{ "id": 3, "type": "store.all", "bucket": "users" }
{ "id": 4, "type": "auth.login", "token": "my-jwt-token" }
```

Chybějící `id` vede k chybě `INVALID_REQUEST`. Chybějící `type` rovněž vede k `INVALID_REQUEST`. Nevalidní JSON vrátí `PARSE_ERROR`.

### 2. Response (Server → Client)

Response opakuje `id` z requestu a má `type` buď `"result"`, nebo `"error"`:

**Úspěch:**

```jsonc
{
  "id": 1,
  "type": "result",
  "data": { "id": "abc123", "name": "Alice", "role": "user", "_version": 1, "_createdAt": 1706745600000 }
}
```

**Chyba:**

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: name",
  "details": { "field": "name" }
}
```

Pole `data` v úspěšné response se liší podle operace. Pole `details` v chybových zprávách je nepovinné a poskytuje další kontext.

### 3. Push (Server → Client)

Push zprávy nemají `id` — nejsou odpovědí na žádný request. Přicházejí asynchronně, když se změní data, na která je klient přihlášen k odběru.

```jsonc
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [{ "id": "abc123", "name": "Alice" }, { "id": "def456", "name": "Bob" }]
}
```

```jsonc
{
  "type": "push",
  "channel": "event",
  "subscriptionId": "sub-2",
  "data": { "topic": "order.created", "event": { "orderId": "ORD-1" } }
}
```

| Pole | Popis |
|------|-------|
| `type` | Vždy `"push"` |
| `channel` | `"subscription"` (store queries) nebo `"event"` (rules engine) |
| `subscriptionId` | Identifikuje, ke které subscription tento push patří |
| `data` | Payload — pole pro výsledky query, objekt pro events |

### 4. System (Server → Client)

System zprávy jsou řídicí zprávy ze serveru:

**Welcome** (odesláno ihned po připojení):

```jsonc
{
  "type": "welcome",
  "version": "1.0.0",
  "requiresAuth": false,
  "serverTime": 1706745600000
}
```

**Ping** (heartbeat):

```jsonc
{ "type": "ping", "timestamp": 1706745600000 }
```

Klient musí odpovědět:

```jsonc
{ "type": "pong", "timestamp": 1706745600000 }
```

**Shutdown** (oznámení o plánovaném vypnutí):

```jsonc
{ "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
```

## Rychlý přehled: Jak rozpoznat zprávu

```text
Received a message. What is it?

  Has "id" field?
  ├── Yes → It's a RESPONSE
  │         type === "result" → Success
  │         type === "error"  → Error
  └── No  → Check "type" field
            type === "push"    → PUSH message
            type === "welcome" → System: welcome
            type === "ping"    → System: heartbeat
            type === "system"  → System: shutdown/other
```

## Funkční příklad

Klient, který klasifikuje každou příchozí zprávu:

```typescript
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.id !== undefined) {
    // Response to a request
    if (msg.type === 'result') {
      console.log(`Response #${msg.id}: success`, msg.data);
    } else if (msg.type === 'error') {
      console.log(`Response #${msg.id}: error ${msg.code}`, msg.message);
    }
  } else if (msg.type === 'push') {
    console.log(`Push on ${msg.channel} [${msg.subscriptionId}]:`, msg.data);
  } else if (msg.type === 'welcome') {
    console.log(`Connected to protocol v${msg.version}`);
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
  } else if (msg.type === 'system') {
    console.log(`System event: ${msg.event}`);
  }
});
```

## Cvičení

Na základě tohoto záznamu WebSocket komunikace identifikujte kategorii a účel každé zprávy:

```
← {"type":"welcome","version":"1.0.0","requiresAuth":true,"serverTime":1706745600000}
→ {"id":1,"type":"auth.login","token":"abc"}
← {"id":1,"type":"error","code":"UNAUTHORIZED","message":"Invalid token"}
→ {"id":2,"type":"auth.login","token":"valid-token"}
← {"id":2,"type":"result","data":{"userId":"u1","roles":["user"]}}
→ {"id":3,"type":"store.insert","bucket":"tasks","data":{"title":"Test"}}
← {"id":3,"type":"result","data":{"id":"t1","title":"Test","_version":1}}
← {"type":"ping","timestamp":1706745630000}
→ {"type":"pong","timestamp":1706745630000}
```

<details>
<summary>Řešení</summary>

1. **System (welcome)** — server oznamuje protokol v1.0.0, vyžaduje autentizaci
2. **Request** — klient se pokusí autentizovat tokenem "abc"
3. **Response (error)** — autentizace selhala, `UNAUTHORIZED`
4. **Request** — klient zkusí znovu s platným tokenem
5. **Response (success)** — autentizován jako uživatel "u1" s rolí "user"
6. **Request** — klient vkládá úkol
7. **Response (success)** — úkol vložen s vygenerovaným id a verzí
8. **System (ping)** — heartbeat kontrola ze serveru
9. **Zpráva klienta (pong)** — klient odpovídá, aby udržel spojení aktivní

</details>

## Shrnutí

- Všechny zprávy jsou JSON textové framy přes WebSocket
- Requesty mají `id` + `type`, response opakuje `id`
- Push zprávy nemají `id` — používají `channel` + `subscriptionId`
- System zprávy: `welcome`, `ping`, `system` (shutdown)
- Nejdříve zkontrolujte přítomnost `id`, abyste odlišili response od ostatních zpráv

---

Další: [Request a response](./02-pozadavek-a-odpoved.md)
