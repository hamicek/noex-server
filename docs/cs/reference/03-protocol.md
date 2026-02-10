# Protokol

Specifikace WebSocket protokolu pro komunikaci mezi klienty a noex-serverem. Všechny zprávy jsou JSON řetězce kódované v UTF-8.

## Import

```typescript
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type ClientMessage,
  type SuccessResponse,
  type ErrorResponse,
  type PushMessage,
  type WelcomeMessage,
  type HeartbeatPing,
  type HeartbeatPong,
  type SystemMessage,
  type ServerMessage,
} from '@hamicek/noex-server';
```

---

## Verze protokolu

```typescript
const PROTOCOL_VERSION = '1.0.0';
```

Odesílá se ve `WelcomeMessage` při navázání spojení. Klienti mohou tuto hodnotu použít k ověření kompatibility.

---

## Životní cyklus spojení

```
Klient                                Server
  |                                     |
  |  ── WebSocket connect ──────────►   |
  |                                     |
  |  ◄── WelcomeMessage ────────────   |
  |      { type: "welcome",            |
  |        version, serverTime,         |
  |        requiresAuth }               |
  |                                     |
  |  ── auth.login (pokud vyžadováno)►  |
  |  ◄── SuccessResponse ───────────   |
  |                                     |
  |  ── ClientRequest ──────────────►   |
  |  ◄── SuccessResponse / Error ────  |
  |                                     |
  |  ◄── PushMessage (subscription) ── |
  |                                     |
  |  ◄── HeartbeatPing ─────────────   |
  |  ── HeartbeatPong ──────────────►   |
  |                                     |
  |  ◄── SystemMessage (shutdown) ───  |
  |                                     |
  |  ── WebSocket close ────────────►   |
```

1. Klient otevře WebSocket spojení na nakonfigurované `path` serveru (výchozí: `/`).
2. Server okamžitě odešle `WelcomeMessage` s verzí protokolu a požadavkem na autentizaci.
3. Pokud je `requiresAuth` `true`, klient musí odeslat `auth.login` požadavek před jakoukoli jinou operací.
4. Klient odesílá `ClientRequest` zprávy; server odpovídá `SuccessResponse` nebo `ErrorResponse`.
5. Subscriptions generují asynchronní `PushMessage` rámce.
6. Server odesílá periodické `HeartbeatPing`; klient musí odpovědět `HeartbeatPong`.
7. Před graceful shutdown může server odeslat `SystemMessage` s grace period.

---

## Klient → Server

### ClientRequest

```typescript
interface ClientRequest {
  readonly id: number;
  readonly type: string;
  readonly [key: string]: unknown;
}
```

Každý požadavek klienta musí obsahovat číselné `id` pro korelaci odpovědi a řetězec `type` identifikující operaci. Další pole závisí na operaci.

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| id | `number` | ano | Identifikátor požadavku. Musí být konečné číslo. Server ho vrátí v odpovědi. |
| type | `string` | ano | Název operace (např. `"store.get"`, `"auth.login"`). Nesmí být prázdný. |
| ...fields | `unknown` | — | Parametry specifické pro operaci. |

**Příklad:**

```json
{
  "id": 1,
  "type": "store.get",
  "bucket": "users",
  "key": "user-1"
}
```

### HeartbeatPong

```typescript
interface HeartbeatPong {
  readonly type: 'pong';
  readonly timestamp: number;
}
```

Odesílá klient v odpovědi na `HeartbeatPing`. Hodnota `timestamp` musí odpovídat hodnotě z pingu. Pole `id` není vyžadováno.

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| type | `'pong'` | ano | Musí být `"pong"`. |
| timestamp | `number` | ano | Timestamp z odpovídajícího `HeartbeatPing`. Musí být konečné číslo. |

**Příklad:**

```json
{
  "type": "pong",
  "timestamp": 1700000000000
}
```

### ClientMessage

```typescript
type ClientMessage = ClientRequest | HeartbeatPong;
```

Union všech typů zpráv, které klient může odeslat serveru.

---

## Server → Klient

### SuccessResponse

```typescript
interface SuccessResponse {
  readonly id: number;
  readonly type: 'result';
  readonly data: unknown;
}
```

Odesílá se, když je `ClientRequest` úspěšně zpracován.

| Název | Typ | Popis |
|-------|-----|-------|
| id | `number` | Odpovídá `id` z původního `ClientRequest`. |
| type | `'result'` | Vždy `"result"`. |
| data | `unknown` | Výsledek operace. Tvar závisí na operaci. |

**Příklad:**

```json
{
  "id": 1,
  "type": "result",
  "data": { "name": "Alice", "age": 30 }
}
```

### ErrorResponse

```typescript
interface ErrorResponse {
  readonly id: number;
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}
```

Odesílá se, když požadavek selže. Pole `id` odpovídá původnímu požadavku. Pro chyby parsování, kde nelze extrahovat platné `id`, je `id` rovno `0`.

| Název | Typ | Popis |
|-------|-----|-------|
| id | `number` | Odpovídá `id` požadavku, nebo `0` pro chyby parsování. |
| type | `'error'` | Vždy `"error"`. |
| code | `ErrorCode` | Strojově čitelný kód chyby (viz [Chyby](./10-errors.md)). |
| message | `string` | Lidsky čitelný popis chyby. |
| details | `unknown` | Volitelná strukturovaná data (např. `{ retryAfterMs }` pro rate limiting). |

**Příklad:**

```json
{
  "id": 42,
  "type": "error",
  "code": "NOT_FOUND",
  "message": "Key \"user-999\" not found in bucket \"users\""
}
```

### PushMessage

```typescript
interface PushMessage {
  readonly type: 'push';
  readonly channel: string;
  readonly subscriptionId: string;
  readonly data: unknown;
}
```

Asynchronní notifikace odeslaná serverem, když subscription vygeneruje data. Push zprávy nejsou korelovány s žádným požadavkem — nemají `id`.

| Název | Typ | Popis |
|-------|-----|-------|
| type | `'push'` | Vždy `"push"`. |
| channel | `string` | Push kanál: `"subscription"` pro store subscriptions, `"event"` pro rules subscriptions. |
| subscriptionId | `string` | Odpovídá `subscriptionId` vrácenému při vytvoření subscription. |
| data | `unknown` | Payload. Pro store: aktualizovaný výsledek query. Pro rules: data události. |

**Příklad — store subscription push:**

```json
{
  "type": "push",
  "channel": "subscription",
  "subscriptionId": "sub-1",
  "data": [{ "name": "Alice" }, { "name": "Bob" }]
}
```

**Příklad — rules event push:**

```json
{
  "type": "push",
  "channel": "event",
  "subscriptionId": "sub-2",
  "data": { "topic": "order:created", "data": { "orderId": "ORD-001" } }
}
```

### WelcomeMessage

```typescript
interface WelcomeMessage {
  readonly type: 'welcome';
  readonly version: string;
  readonly serverTime: number;
  readonly requiresAuth: boolean;
}
```

Odesílá se okamžitě po navázání WebSocket spojení.

| Název | Typ | Popis |
|-------|-----|-------|
| type | `'welcome'` | Vždy `"welcome"`. |
| version | `string` | Verze protokolu (aktuálně `"1.0.0"`). |
| serverTime | `number` | Timestamp serveru (ms od epochy) v okamžiku připojení. |
| requiresAuth | `boolean` | Zda se klient musí autentizovat před odesláním jiných požadavků. |

**Příklad:**

```json
{
  "type": "welcome",
  "version": "1.0.0",
  "serverTime": 1700000000000,
  "requiresAuth": true
}
```

### HeartbeatPing

```typescript
interface HeartbeatPing {
  readonly type: 'ping';
  readonly timestamp: number;
}
```

Periodický heartbeat odesílaný serverem. Klient musí odpovědět `HeartbeatPong` se stejným `timestamp`. Pokud klient neodpoví před dalším tickem, server uzavře spojení s kódem `4001`.

| Název | Typ | Popis |
|-------|-----|-------|
| type | `'ping'` | Vždy `"ping"`. |
| timestamp | `number` | Timestamp serveru (ms od epochy). Klient musí tuto hodnotu vrátit v pongu. |

**Příklad:**

```json
{
  "type": "ping",
  "timestamp": 1700000000000
}
```

### SystemMessage

```typescript
interface SystemMessage {
  readonly type: 'system';
  readonly event: string;
  readonly [key: string]: unknown;
}
```

Systémová notifikace iniciovaná serverem. Aktuálně se používá pro oznámení graceful shutdown.

| Název | Typ | Popis |
|-------|-----|-------|
| type | `'system'` | Vždy `"system"`. |
| event | `string` | Název události (např. `"shutdown"`). |
| ...fields | `unknown` | Data specifická pro událost. |

**Příklad — oznámení o vypnutí:**

```json
{
  "type": "system",
  "event": "shutdown",
  "gracePeriodMs": 5000
}
```

### ServerMessage

```typescript
type ServerMessage =
  | SuccessResponse
  | ErrorResponse
  | PushMessage
  | WelcomeMessage
  | HeartbeatPing
  | SystemMessage;
```

Union všech typů zpráv, které server může odeslat klientovi. Rozlišeno polem `type`.

---

## Typy operací

Pole `type` v `ClientRequest` určuje, která operace se provede. Operace jsou seskupeny podle namespace:

| Namespace | Operace | Popis |
|-----------|---------|-------|
| `store.*` | `store.insert`, `store.get`, `store.update`, `store.delete`, `store.all`, `store.where`, `store.findOne`, `store.count`, `store.first`, `store.last`, `store.paginate`, `store.sum`, `store.avg`, `store.min`, `store.max`, `store.clear`, `store.buckets`, `store.stats`, `store.subscribe`, `store.unsubscribe`, `store.transaction` | Store CRUD, dotazy, agregace, subscriptions |
| `rules.*` | `rules.emit`, `rules.setFact`, `rules.getFact`, `rules.deleteFact`, `rules.queryFacts`, `rules.getAllFacts`, `rules.subscribe`, `rules.unsubscribe`, `rules.stats` | Operace rule enginu |
| `auth.*` | `auth.login`, `auth.logout`, `auth.whoami` | Autentizace |
| `server.*` | `server.stats`, `server.connections` | Introspekce serveru |

---

## Validace zpráv

Server validuje příchozí zprávy v tomto pořadí:

1. **JSON parsování** — Zpráva musí být validní JSON. Při selhání: `PARSE_ERROR` s `id: 0`.
2. **Kontrola objektu** — Musí být JSON objekt (ne pole, null nebo primitivní hodnota). Při selhání: `PARSE_ERROR` s `id: 0`.
3. **Pole type** — Musí obsahovat neprázdný řetězec `type`. Při selhání: `INVALID_REQUEST` s `id: 0`.
4. **Zpracování pong** — Pokud je `type` `"pong"`, `timestamp` musí být konečné číslo. `id` není vyžadováno.
5. **Pole id** — Pro všechny ostatní zprávy musí být `id` konečné číslo. Při selhání: `INVALID_REQUEST` s `id: 0`.

---

## Pipeline zpracování požadavků

Po validaci prochází každý požadavek:

```
ClientRequest
  → checkAuth()        → UNAUTHORIZED / FORBIDDEN
  → checkRateLimit()   → RATE_LIMITED
  → routeRequest()     → SuccessResponse / ErrorResponse
```

1. **Kontrola autentizace** — Přeskočena pro `auth.*` operace. Pokud je autentizace vyžadována a klient není autentizován, vrací `UNAUTHORIZED`. Pokud session vypršela, vymaže session a vrátí `UNAUTHORIZED`. Pokud jsou nakonfigurovány oprávnění, zkontroluje oprávnění operace — při selhání vrátí `FORBIDDEN`.
2. **Kontrola rate limitu** — Pokud je nakonfigurován rate limiting, spotřebuje token. Při selhání vrátí `RATE_LIMITED` s `retryAfterMs`.
3. **Routing** — Předá požadavek příslušnému handleru podle namespace prefixu `type`.

---

## WebSocket close kódy

| Kód | Důvod | Popis |
|-----|-------|-------|
| 1000 | `normal_closure` | Čisté vypnutí iniciované serverem. |
| 1001 | `server_shutting_down` | Spojení odmítnuto, protože se server vypíná. |
| 4001 | `heartbeat_timeout` | Klient neodpověděl na heartbeat ping včas. |

---

## Viz také

- [Chyby](./10-errors.md) — Chybové kódy a třída chyby
- [Store operace](./04-store-operations.md) — Store CRUD a dotazovací operace
- [Store subscriptions](./05-store-subscriptions.md) — Store subscriptions a transakce
- [Rules operace](./06-rules-operations.md) — Operace rule enginu
- [Autentizace](./07-authentication.md) — Auth operace
- [Životní cyklus](./08-lifecycle.md) — Heartbeat, backpressure, limity spojení
