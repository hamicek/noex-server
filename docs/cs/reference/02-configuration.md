# Konfigurace

Všechny konfigurační rozhraní a jejich výchozí hodnoty pro `NoexServer`.

## Import

```typescript
import type {
  ServerConfig,
  AuthConfig,
  AuthSession,
  PermissionConfig,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
  ConnectionLimitsConfig,
} from '@hamicek/noex-server';
```

---

## ServerConfig

Hlavní konfigurační objekt předávaný do `NoexServer.start()`.

```typescript
interface ServerConfig {
  readonly store: Store;
  readonly rules?: RuleEngine;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  readonly auth?: AuthConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly heartbeat?: HeartbeatConfig;
  readonly backpressure?: BackpressureConfig;
  readonly connectionLimits?: Partial<ConnectionLimitsConfig>;
  readonly name?: string;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| store | `Store` | *povinný* | Instance `@hamicek/noex-store`. |
| rules | `RuleEngine` | — | Instance `@hamicek/noex-rules` (volitelná peer dependency). |
| port | `number` | `8080` | Port WebSocket serveru. |
| host | `string` | `'0.0.0.0'` | Host WebSocket serveru. |
| path | `string` | `'/'` | Cesta WebSocket endpointu. |
| maxPayloadBytes | `number` | `1_048_576` (1 MB) | Maximální velikost příchozí zprávy v bytech. |
| auth | `AuthConfig` | — | Konfigurace autentizace. Pokud chybí, auth je vypnuta. |
| rateLimit | `RateLimitConfig` | — | Konfigurace rate limitingu. Pokud chybí, rate limiting je vypnut. |
| heartbeat | `HeartbeatConfig` | `{ intervalMs: 30_000, timeoutMs: 10_000 }` | Konfigurace heartbeat ping/pong. |
| backpressure | `BackpressureConfig` | `{ maxBufferedBytes: 1_048_576, highWaterMark: 0.8 }` | Konfigurace backpressure zápisového bufferu. |
| connectionLimits | `Partial<ConnectionLimitsConfig>` | `{ maxSubscriptionsPerConnection: 100 }` | Limity per spojení. |
| name | `string` | `'noex-server'` | Název serveru pro registr a logování. |

**Příklad:**

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = new Store({ buckets: { users: {} } });

const server = await NoexServer.start({
  store,
  port: 3000,
  host: '127.0.0.1',
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000 },
});
```

---

## AuthConfig

Konfigurace tokenové autentizace.

```typescript
interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| validate | `(token: string) => Promise<AuthSession \| null>` | *povinný* | Validuje token a vrací session, nebo `null` pokud je neplatný. |
| required | `boolean` | `true` | Zda je autentizace vyžadována. Při `false` mohou neautentizovaní klienti používat všechny operace. |
| permissions | `PermissionConfig` | — | Callback pro kontrolu oprávnění. Pokud chybí, všichni autentizovaní uživatelé mají plný přístup. |

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      const user = await verifyJWT(token);
      if (!user) return null;
      return {
        userId: user.id,
        roles: user.roles,
        expiresAt: user.exp * 1000,
      };
    },
    permissions: {
      check: (session, operation, resource) => {
        if (session.roles.includes('admin')) return true;
        if (operation.startsWith('store.get')) return true;
        return false;
      },
    },
  },
});
```

---

## AuthSession

Vrací callback `validate`. Reprezentuje autentizovanou uživatelskou session.

```typescript
interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}
```

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| userId | `string` | ano | Unikátní identifikátor uživatele. |
| roles | `readonly string[]` | ano | Role uživatele pro kontrolu oprávnění. |
| metadata | `Record<string, unknown>` | ne | Libovolná metadata připojená k session. |
| expiresAt | `number` | ne | Unix timestamp (ms) expirace session. Expirované session jsou automaticky odmítnuty. |

---

## PermissionConfig

Konfigurace kontroly oprávnění per operaci.

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| check | `(session, operation, resource) => boolean` | Vrací `true` pro povolení, `false` pro zamítnutí. Voláno pro každý požadavek autentizovaného klienta. |

Parametr `operation` je `type` požadavku (např. `"store.insert"`, `"rules.emit"`). Parametr `resource` je extrahován z payloadu požadavku (typicky pole `bucket` pro store operace).

---

## RateLimitConfig

Konfigurace rate limitingu pomocí klouzavého okna.

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| maxRequests | `number` | Maximální počet požadavků povolených v rámci okna. |
| windowMs | `number` | Délka okna v milisekundách. |

Rate limiting je klíčován podle `userId` (pokud je autentizován) nebo podle vzdálené IP adresy.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: { maxRequests: 100, windowMs: 60_000 }, // 100 req/min
});
```

---

## HeartbeatConfig

Konfigurace heartbeat mechanismu iniciovaného serverem.

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| intervalMs | `number` | `30_000` | Interval mezi ping zprávami (ms). |
| timeoutMs | `number` | `10_000` | Maximální čas čekání na pong odpověď (ms). Při překročení je spojení uzavřeno s kódem `4001`. |

---

## BackpressureConfig

Konfigurace detekce backpressure zápisového bufferu.

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| maxBufferedBytes | `number` | `1_048_576` (1 MB) | Maximální velikost zápisového bufferu v bytech. |
| highWaterMark | `number` | `0.8` | Podíl z `maxBufferedBytes`, při kterém jsou push zprávy zahazovány (0–1). |

Když zápisový buffer WebSocketu překročí `maxBufferedBytes * highWaterMark`, push zprávy (aktualizace subscriptions) jsou zahazovány. Klient obdrží správný stav při další aktualizaci subscription.

---

## ConnectionLimitsConfig

Limity per spojení.

```typescript
interface ConnectionLimitsConfig {
  readonly maxSubscriptionsPerConnection: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| maxSubscriptionsPerConnection | `number` | `100` | Maximální počet aktivních subscriptions (store + rules) na jedno spojení. Překročení tohoto limitu vrací chybu `RATE_LIMITED`. |

---

## Přehled výchozích hodnot

| Konstanta | Hodnota |
|-----------|---------|
| `DEFAULT_PORT` | `8080` |
| `DEFAULT_HOST` | `'0.0.0.0'` |
| `DEFAULT_PATH` | `'/'` |
| `DEFAULT_MAX_PAYLOAD_BYTES` | `1_048_576` (1 MB) |
| `DEFAULT_NAME` | `'noex-server'` |
| `DEFAULT_HEARTBEAT.intervalMs` | `30_000` (30 s) |
| `DEFAULT_HEARTBEAT.timeoutMs` | `10_000` (10 s) |
| `DEFAULT_BACKPRESSURE.maxBufferedBytes` | `1_048_576` (1 MB) |
| `DEFAULT_BACKPRESSURE.highWaterMark` | `0.8` |
| `DEFAULT_CONNECTION_LIMITS.maxSubscriptionsPerConnection` | `100` |

---

## Viz také

- [NoexServer](./01-noex-server.md) — Třída serveru
- [Autentizace](./07-authentication.md) — Auth operace a životní cyklus session
- [Životní cyklus](./08-lifecycle.md) — Heartbeat, backpressure, limity spojení
- [Chyby](./10-errors.md) — Chybové kódy
