# Rate limiting

Ochrana serveru před nadměrnými požadavky pomocí rate limiteru s klouzavým oknem. Rate limiting je per-IP pro neautentizované klienty a per-userId pro autentizované klienty.

## Co se naučíte

- `RateLimitConfig` — `maxRequests` a `windowMs`
- Chybová odpověď `RATE_LIMITED` s `retryAfterMs`
- Klíč rate limitu: IP adresa vs userId
- Jak se klíč přepne z IP na userId po přihlášení
- Limity subscriptions přes `connectionLimits`
- Vypnutí rate limitingu (výchozí stav)

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'ratelimit-demo' });

store.defineBucket('items', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({
  store,
  port: 8080,
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000, // 1 minuta
  },
});
```

## RateLimitConfig

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;  // Max požadavků za okno
  readonly windowMs: number;     // Délka klouzavého okna v ms
}
```

- **`maxRequests`** — maximální počet požadavků povolených v rámci okna
- **`windowMs`** — délka klouzavého okna v milisekundách

Pokud je v `ServerConfig` vynechán, rate limiting je kompletně vypnutý — žádný výchozí limit neexistuje.

## Jak to funguje

Rate limiter používá algoritmus **klouzavého okna**. Každý požadavek spotřebuje jeden token z okna. Když jsou všechny tokeny spotřebovány, následné požadavky jsou odmítnuty, dokud se okno neposune natolik, aby uvolnilo kapacitu.

```
Okno: 60 sekund, Max: 5 požadavků

Čas ──▶
│ req1  req2  req3  req4  req5 │ req6 ✗ (RATE_LIMITED)
│◄──────── 60s okno ───────────►│
                                  │ req1 expiruje → req6 ✓
```

## Chyba RATE_LIMITED

Když klient překročí limit, server odpoví:

```jsonc
→ { "id": 6, "type": "store.all", "bucket": "items" }

← { "id": 6, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 42000ms",
    "details": { "retryAfterMs": 42000 } }
```

- **`code`** — vždy `"RATE_LIMITED"`
- **`details.retryAfterMs`** — milisekundy do uvolnění alespoň jednoho tokenu

Klienti by měli použít `retryAfterMs` pro implementaci backoffu místo okamžitého opakování.

## Klíč rate limitu

Rate limiter sleduje využití per-klíč:

| Stav | Klíč | Rozsah |
|------|------|--------|
| Neautentizovaný | IP adresa (např. `"192.168.1.10"`) | Sdílený napříč všemi spojeními ze stejné IP |
| Autentizovaný | `userId` (např. `"alice"`) | Nezávislý bucket pro každého uživatele |

### Přepnutí klíče po přihlášení

Před `auth.login` se požadavky sledují podle IP. Po přihlášení se klíč přepne na `userId`:

```jsonc
// Před přihlášením: rate limiting podle IP (127.0.0.1)
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// Po přihlášení: rate limiting podle userId ("alice") — čerstvý bucket
→ { "id": 2, "type": "store.all", "bucket": "items" }
← { "id": 2, "type": "result", "data": [] }
```

To znamená, že samotný `auth.login` je rate-limitován podle IP — chrání proti brute-force pokusům o přihlášení.

### Sdílení IP

Více neautentizovaných spojení ze stejné IP sdílí stejný bucket rate limitu:

```
Spojení A (127.0.0.1): store.all  →  bucket "127.0.0.1" (1/5)
Spojení B (127.0.0.1): store.all  →  bucket "127.0.0.1" (2/5)
Spojení A (127.0.0.1): store.all  →  bucket "127.0.0.1" (3/5)
```

Po přihlášení každý uživatel dostane nezávislý bucket:

```
Spojení A (alice): store.all  →  bucket "alice" (1/5)
Spojení B (bob):   store.all  →  bucket "bob"   (1/5)
```

## Všechny operace jsou rate-limitované

Rate limiting se aplikuje uniformně na všechny typy operací — `store.*`, `rules.*`, `auth.*` a `server.*`:

```jsonc
// Všechny spotřebovávají ze stejného bucketu:
→ { "id": 1, "type": "store.insert", "bucket": "items", "data": { "name": "a" } }
→ { "id": 2, "type": "store.all", "bucket": "items" }
→ { "id": 3, "type": "store.count", "bucket": "items" }
// Všechny 3 spotřebovány, zbývají 2 v okně maxRequests: 5
```

## Reset okna

Po uplynutí klouzavého okna se tokeny uvolní a požadavky jsou opět povoleny:

```jsonc
// Limit: 2 požadavky za 200 ms

→ { "id": 1, "type": "store.all", "bucket": "items" }  // ✓ (1/2)
← { "id": 1, "type": "result", "data": [] }

→ { "id": 2, "type": "store.all", "bucket": "items" }  // ✓ (2/2)
← { "id": 2, "type": "result", "data": [] }

→ { "id": 3, "type": "store.all", "bucket": "items" }  // ✗ RATE_LIMITED
← { "id": 3, "type": "error", "code": "RATE_LIMITED", ... }

// ... počkat na expiraci okna ...

→ { "id": 4, "type": "store.all", "bucket": "items" }  // ✓ (1/2)
← { "id": 4, "type": "result", "data": [] }
```

## Limity subscriptions

Odděleně od rate limitingu požadavků můžete omezit počet aktivních subscriptions na spojení:

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50, // Výchozí: 100
  },
});
```

Když se klient pokusí přihlásit nad limit:

```jsonc
→ { "id": 101, "type": "store.subscribe", "query": "some-query" }

← { "id": 101, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Subscription limit reached (max 50 per connection)" }
```

Limit subscriptions počítá store i rules subscriptions dohromady.

## Bez rate limitingu (výchozí)

Pokud `rateLimit` není v konfiguraci specifikován, žádný limit neexistuje — všechny požadavky jsou povoleny:

```typescript
// Bez rate limitingu
const server = await NoexServer.start({ store, port: 8080 });
```

Zda je rate limiting zapnutý, můžete ověřit přes statistiky:

```jsonc
→ { "id": 1, "type": "server.stats" }
← { "id": 1, "type": "result",
    "data": { "rateLimitEnabled": false, ... } }
```

## Chybové kódy

| Chybový kód | Příčina |
|-------------|---------|
| `RATE_LIMITED` | Překročen rate limit požadavků (obsahuje `retryAfterMs` v details) |
| `RATE_LIMITED` | Dosažen limit subscriptions (max N na spojení) |

## Funkční příklad

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  rateLimit: {
    maxRequests: 100,   // 100 požadavků
    windowMs: 60_000,   // za minutu
  },
  connectionLimits: {
    maxSubscriptionsPerConnection: 50,
  },
  auth: {
    validate: async (token) => {
      if (token === 'alice') return { userId: 'alice', roles: ['admin'] };
      return null;
    },
  },
});

// Před přihlášením: rate limiting podle IP
// → { "id": 1, "type": "auth.login", "token": "alice" }
// ← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// Po přihlášení: rate limiting podle userId "alice"
// → { "id": 2, "type": "store.all", "bucket": "items" }
// ← { "id": 2, "type": "result", "data": [] }

// Pokud je limit překročen:
// ← { "id": N, "type": "error",
//     "code": "RATE_LIMITED",
//     "message": "Rate limit exceeded. Retry after 42000ms",
//     "details": { "retryAfterMs": 42000 } }
```

## Cvičení

Nastavte server s rate limitem 3 požadavky za minutu a zapnutou autentizací. Ukažte:
1. Klient se přihlásí (spotřebuje 1 požadavek z IP bucketu)
2. Po přihlášení je userId bucket čerstvý — povoleny další 3 požadavky
3. 4. požadavek po přihlášení je rate-limitován
4. Ověřte, že `retryAfterMs` je přítomen v chybových detailech

<details>
<summary>Řešení</summary>

```jsonc
// Rate limit: 3 požadavky / 60s okno, auth zapnut

// 1. Přihlášení (spotřebuje z IP bucketu "127.0.0.1": 1/3)
→ { "id": 1, "type": "auth.login", "token": "alice" }
← { "id": 1, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"] } }

// 2. Po přihlášení se bucket přepne na "alice" — čerstvý 3/3
→ { "id": 2, "type": "store.all", "bucket": "items" }
← { "id": 2, "type": "result", "data": [] }

→ { "id": 3, "type": "store.insert", "bucket": "items",
    "data": { "name": "first" } }
← { "id": 3, "type": "result", "data": { "id": "...", "name": "first" } }

→ { "id": 4, "type": "store.count", "bucket": "items" }
← { "id": 4, "type": "result", "data": 1 }

// 3. 4. požadavek — userId bucket vyčerpán (3/3)
→ { "id": 5, "type": "store.all", "bucket": "items" }
← { "id": 5, "type": "error",
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 59234ms",
    "details": { "retryAfterMs": 59234 } }

// 4. retryAfterMs říká klientovi, kdy opakovat
//    (přibližně windowMs minus uplynulý čas)
```

</details>

## Shrnutí

- Rate limiting se konfiguruje přes `rateLimit: { maxRequests, windowMs }` — ve výchozím stavu vypnutý
- Algoritmus klouzavého okna: požadavky jsou odmítnuty s `RATE_LIMITED`, když je limit překročen
- Chyba obsahuje `details.retryAfterMs` — klienti by měli čekat před opakováním
- Klíč rate limitu: IP adresa pro neautentizované, userId pro autentizované
- Klíč se přepne z IP na userId po `auth.login` — čerstvý bucket pro každého uživatele
- `auth.login` je rate-limitován podle IP — chrání proti brute-force pokusům
- Limity subscriptions (`connectionLimits.maxSubscriptionsPerConnection`) omezují celkové subscriptions na spojení (výchozí: 100)
- Všechny typy operací jsou rate-limitovány uniformně

---

Další: [Heartbeat](./02-heartbeat.md)
