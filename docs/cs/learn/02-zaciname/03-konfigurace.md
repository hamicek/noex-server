# Konfigurace

noex-server se konfiguruje jedním objektem `ServerConfig`, který se předává do `NoexServer.start()`. Tato kapitola dokumentuje každé pole, jeho výchozí hodnotu a kdy ho měnit.

## Co se naučíte

- Všechna pole v `ServerConfig`
- Výchozí hodnoty a co znamenají
- Jak se zapínají volitelné funkce (auth, rate limiting, heartbeat, backpressure)
- Rozdíl mezi uživatelskou konfigurací a výslednou konfigurací

## Reference ServerConfig

```typescript
interface ServerConfig {
  store: Store;                        // required
  rules?: RuleEngine;                  // optional
  port?: number;                       // default: 8080
  host?: string;                       // default: '0.0.0.0'
  path?: string;                       // default: '/'
  maxPayloadBytes?: number;            // default: 1_048_576 (1 MB)
  auth?: AuthConfig;                   // default: disabled
  rateLimit?: RateLimitConfig;         // default: disabled
  heartbeat?: HeartbeatConfig;         // default: { intervalMs: 30000, timeoutMs: 10000 }
  backpressure?: BackpressureConfig;   // default: { maxBufferedBytes: 1048576, highWaterMark: 0.8 }
  connectionLimits?: Partial<ConnectionLimitsConfig>;  // default: { maxSubscriptionsPerConnection: 100 }
  name?: string;                       // default: 'noex-server'
}
```

## Základní pole

### `store` (povinný)

Instance noex-store. Toto je jediné povinné pole. Server přes něj zprostředkovává všechny operace `store.*`.

```typescript
const store = await Store.start({ name: 'my-store' });
const server = await NoexServer.start({ store });
```

### `rules` (volitelný)

Instance `RuleEngine` z noex-rules. Když je zadaná, server povolí operace `rules.*`. Pokud chybí, jakýkoli požadavek `rules.*` vrátí `RULES_NOT_AVAILABLE`.

```typescript
import { RuleEngine } from '@hamicek/noex-rules';

const engine = await RuleEngine.start({ name: 'my-rules' });
const server = await NoexServer.start({ store, rules: engine });
```

### `port`

**Výchozí: `8080`**

TCP port pro naslouchání. Použijte `0` pro náhodný volný port — skutečný port je po startu dostupný přes `server.port`:

```typescript
const server = await NoexServer.start({ store, port: 0 });
console.log(server.port); // e.g., 54321
```

### `host`

**Výchozí: `'0.0.0.0'`**

Síťové rozhraní, na které se server naváže. `'0.0.0.0'` naslouchá na všech rozhraních. Pro přístup pouze z localhostu použijte `'127.0.0.1'` (doporučeno pro testy).

### `path`

**Výchozí: `'/'`**

Cesta WebSocket endpointu. Klienti se připojují na `ws://host:port/path`.

### `maxPayloadBytes`

**Výchozí: `1_048_576` (1 MB)**

Maximální velikost příchozí WebSocket zprávy. Zprávy překračující tento limit jsou odmítnuty.

### `name`

**Výchozí: `'noex-server'`**

Název serveru používaný pro registry a logování.

## Konfigurace auth

Pokud je `auth` zadán, autentizace je zapnutá. Pokud chybí, všechny operace jsou povoleny bez autentizace.

```typescript
interface AuthConfig {
  validate: (token: string) => Promise<AuthSession | null>;
  required?: boolean;     // default: true (when auth is configured)
  permissions?: PermissionConfig;
}

interface AuthSession {
  userId: string;
  roles: readonly string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;     // Unix timestamp in milliseconds
}

interface PermissionConfig {
  check: (session: AuthSession, operation: string, resource: string) => boolean;
}
```

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      // Your token verification logic
      if (token === 'valid-token') {
        return { userId: 'user-1', roles: ['admin'] };
      }
      return null; // Invalid token
    },
    permissions: {
      check: (session, operation) => {
        if (operation === 'store.clear') {
          return session.roles.includes('admin');
        }
        return true;
      },
    },
  },
});
```

## Konfigurace rate limiting

Pokud je zadána, zapne per-connection rate limiting pomocí algoritmu posuvného okna.

```typescript
interface RateLimitConfig {
  maxRequests: number;   // requests per window
  windowMs: number;      // sliding window duration in ms
}
```

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: {
    maxRequests: 200,
    windowMs: 60_000, // 200 requests per minute
  },
});
```

Klíč pro rate limiting je `session.userId` u autentizovaných spojení, nebo vzdálená IP adresa u anonymních spojení.

## Konfigurace heartbeat

Heartbeat je vždy aktivní s nastavitelným časováním.

```typescript
interface HeartbeatConfig {
  intervalMs: number;   // default: 30_000 (30 seconds)
  timeoutMs: number;    // default: 10_000 (10 seconds)
}
```

Server odesílá `ping` zprávu každých `intervalMs` milisekund. Pokud do `timeoutMs` nedorazí `pong`, spojení se uzavře s WebSocket close kódem `4001`.

## Konfigurace backpressure

Backpressure je vždy aktivní s nastavitelnými prahy.

```typescript
interface BackpressureConfig {
  maxBufferedBytes: number;   // default: 1_048_576 (1 MB)
  highWaterMark: number;      // default: 0.8 (80%)
}
```

Když WebSocket write buffer překročí `maxBufferedBytes × highWaterMark`, push zprávy se pozastaví, aby se zabránilo vyčerpání paměti u pomalých klientů.

## Limity spojení

```typescript
interface ConnectionLimitsConfig {
  maxSubscriptionsPerConnection: number;  // default: 100
}
```

Omezuje počet aktivních subscriptions na jedno spojení.

## Minimální vs. produkční konfigurace

**Minimální (vývoj):**

```typescript
const server = await NoexServer.start({ store });
```

**Produkce:**

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  host: '0.0.0.0',
  auth: {
    validate: verifyJwtToken,
    permissions: { check: checkPermissions },
  },
  rateLimit: { maxRequests: 200, windowMs: 60_000 },
  heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
  backpressure: { maxBufferedBytes: 2_097_152, highWaterMark: 0.75 },
  connectionLimits: { maxSubscriptionsPerConnection: 50 },
  name: 'my-app-server',
});
```

**Testy:**

```typescript
const server = await NoexServer.start({
  store,
  port: 0,            // random port
  host: '127.0.0.1',  // local only
});
```

## Cvičení

Napište ServerConfig, který:
1. Naslouchá na portu 3000, host `'127.0.0.1'`
2. Vyžaduje autentizaci s jednoduchým ověřením tokenu (přijme `"secret123"`)
3. Blokuje `store.clear` pro uživatele, kteří nemají roli admin
4. Omezuje na 100 požadavků za 30 sekund

<details>
<summary>Řešení</summary>

```typescript
const server = await NoexServer.start({
  store,
  port: 3000,
  host: '127.0.0.1',
  auth: {
    validate: async (token) => {
      if (token === 'secret123') {
        return { userId: 'user-1', roles: ['admin'] };
      }
      return null;
    },
    permissions: {
      check: (session, operation) => {
        if (operation === 'store.clear') {
          return session.roles.includes('admin');
        }
        return true;
      },
    },
  },
  rateLimit: {
    maxRequests: 100,
    windowMs: 30_000,
  },
});
```

</details>

## Shrnutí

- `store` je jediné povinné pole — vše ostatní má rozumné výchozí hodnoty
- Auth a rate limiting jsou volitelné — vynechejte je pro vypnutí
- Heartbeat a backpressure jsou vždy aktivní s nastavitelnými prahy
- Pro testy použijte `port: 0` + `host: '127.0.0.1'`
- Pole `name` se používá pro registry a logování

---

Další: [Formát zpráv](../03-protokol/01-format-zprav.md)
