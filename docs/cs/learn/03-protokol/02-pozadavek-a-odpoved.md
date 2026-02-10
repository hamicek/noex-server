# Request a response

Každá akce klienta probíhá podle vzoru request/response: klient odešle JSON zprávu s `id` a operačním `type`, server ji zpracuje a odpoví zprávou se stejným `id`. Tato kapitola pokrývá korelaci, routing a souběžné requesty.

## Co se naučíte

- Jak funguje korelace request/response přes pole `id`
- Jak se operace směrují podle prefixu namespace
- Jak bezpečně pracovat se souběžnými requesty
- Co se stane s chybně strukturovanými requesty

## Korelace přes `id`

Každý request musí obsahovat číselné `id`. Server toto `id` vrátí v příslušné response. Takto klient páruje response s requesty:

```jsonc
// Request
→ { "id": 42, "type": "store.get", "bucket": "users", "key": "abc" }

// Response (matches id: 42)
← { "id": 42, "type": "result", "data": { "id": "abc", "name": "Alice", ... } }
```

**Pravidla:**
- `id` musí být přítomno — chybějící `id` vrátí `INVALID_REQUEST` s `id: 0`
- `id` by mělo být číslo — server ho vrací tak, jak ho přijal
- Klient zodpovídá za unikátnost ID (nejjednodušší je inkrementující čítač)
- Server unikátnost nevynucuje — jednoduše vrátí to `id`, které dostal

## Routing operací

Pole `type` určuje, který subsystém request zpracuje:

```text
type: "store.insert"   →  Store proxy  →  store.insert()
type: "rules.emit"     →  Rules proxy  →  engine.emit()
type: "auth.login"     →  Auth handler →  validate(token)
type: "pong"           →  Heartbeat    →  (acknowledged silently)
```

| Prefix | Subsystém | Vyžaduje |
|--------|-----------|----------|
| `store.*` | Store proxy | Store je vždy k dispozici |
| `rules.*` | Rules proxy | `rules` nastaveno v ServerConfig |
| `auth.*` | Auth handler | `auth` nastaveno v ServerConfig |

Nerozpoznané operace vrátí `UNKNOWN_OPERATION`:

```jsonc
→ { "id": 1, "type": "magic.spell" }
← { "id": 1, "type": "error", "code": "UNKNOWN_OPERATION", "message": "Unknown operation: magic.spell" }
```

## Request pipeline

Každý request prochází těmito fázemi:

```text
1. Parse JSON
   ├── Invalid JSON → PARSE_ERROR (id: 0)
   └── Valid JSON ↓

2. Validate structure
   ├── Missing id or type → INVALID_REQUEST
   └── Valid ↓

3. Auth check (if auth.required)
   ├── Not authenticated → UNAUTHORIZED
   └── Authenticated (or auth not required) ↓

4. Rate limit check (if rateLimit configured)
   ├── Exceeded → RATE_LIMITED
   └── Within limits ↓

5. Permission check (if permissions configured)
   ├── Denied → FORBIDDEN
   └── Allowed ↓

6. Route to handler
   ├── store.* → Store proxy
   ├── rules.* → Rules proxy
   ├── auth.* → Auth handler
   └── unknown → UNKNOWN_OPERATION

7. Execute and respond
   ├── Success → { id, type: "result", data }
   └── Error → { id, type: "error", code, message }
```

## Souběžné requesty

Více requestů může být v letu současně. Server je zpracovává nezávisle a může odpovídat v jiném pořadí:

```jsonc
// Client sends two requests quickly
→ { "id": 1, "type": "store.all", "bucket": "users" }      // slow (many records)
→ { "id": 2, "type": "store.count", "bucket": "products" }  // fast (just a number)

// Server responds — id:2 may arrive before id:1
← { "id": 2, "type": "result", "data": 5 }
← { "id": 1, "type": "result", "data": [{ ... }, { ... }, ...] }
```

Proto je korelace přes `id` zásadní. Bez ní nelze určit, která response patří ke kterému requestu.

## Funkční příklad

Robustní klient, který odesílá souběžné requesty:

```typescript
import { WebSocket } from 'ws';

let nextId = 1;

function sendRequest(ws: WebSocket, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

// Usage: fire two requests concurrently
const [users, count] = await Promise.all([
  sendRequest(ws, { type: 'store.all', bucket: 'users' }),
  sendRequest(ws, { type: 'store.count', bucket: 'users' }),
]);

console.log(users.data);  // [{...}, {...}]
console.log(count.data);  // 2
```

## Chybové response

Chybové response vždy obsahují `code` a `message`. Některé zahrnují i `details`:

```jsonc
// Validation error with details
← {
    "id": 5,
    "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing required field: bucket",
    "details": { "field": "bucket" }
  }

// Rate limited with retry hint
← {
    "id": 6,
    "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded",
    "details": { "retryAfterMs": 1500 }
  }
```

**Důležité:** Chyba jednoho requestu neovlivní ostatní requesty ani samotné spojení. Spojení zůstává otevřené a funkční.

## Cvičení

Napište funkci `sendBatch`, která přijme WebSocket a pole payloadů, odešle je všechny souběžně a vrátí pole response ve stejném pořadí, v jakém byly payloady zadány.

<details>
<summary>Řešení</summary>

```typescript
async function sendBatch(
  ws: WebSocket,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return Promise.all(
    payloads.map((payload) => sendRequest(ws, payload)),
  );
}

// Usage
const results = await sendBatch(ws, [
  { type: 'store.insert', bucket: 'users', data: { name: 'Alice' } },
  { type: 'store.insert', bucket: 'users', data: { name: 'Bob' } },
  { type: 'store.count', bucket: 'users' },
]);
// results[0] = insert result for Alice
// results[1] = insert result for Bob
// results[2] = count result
```

Funguje to proto, že každé volání `sendRequest` používá vlastní `id` a resolvuje se nezávisle. `Promise.all` zachovává původní pořadí.

</details>

## Shrnutí

- Každý request nese `id`, které server vrátí v response
- Operace se směrují podle prefixu: `store.*`, `rules.*`, `auth.*`
- Request pipeline: parse → validate → auth → rate limit → permission → route → respond
- Souběžné requesty jsou nezávislé — response mohou přicházet v libovolném pořadí
- Chyba jednoho requestu neovlivní spojení ani ostatní requesty
- Pro souběžné operace používejte `Promise.all` se `sendRequest`

---

Další: [Push zprávy](./03-push-zpravy.md)
