# Životní cyklus

Infrastrukturní funkce serveru: monitoring heartbeatu, backpressure zápisu do bufferu, limity spojení, rate limiting, graceful shutdown a runtime introspekce přes `server.stats` a `server.connections`.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
import type {
  HeartbeatConfig,
  BackpressureConfig,
  RateLimitConfig,
  ConnectionLimitsConfig,
} from '@hamicek/noex-server';
```

---

## Heartbeat

Server posílá periodické `ping` zprávy každému připojenému klientovi. Klienti musí odpovědět zprávou `pong` před dalším heartbeat tickem. Pokud klient neodpoví, spojení je uzavřeno s kódem `4001` a důvodem `"heartbeat_timeout"`.

### Konfigurace

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| intervalMs | `number` | `30000` | Interval mezi ping zprávami v milisekundách. |
| timeoutMs | `number` | `10000` | Čas čekání na pong odpověď. Nepoužívá se jako samostatný timer — server při dalším ticku zkontroluje, zda byl pong přijat od posledního pingu. |

### Ping zpráva

```json
{ "type": "ping", "timestamp": 1700000000000 }
```

### Pong odpověď

Klienti musí odpovědět:

```json
{ "type": "pong", "timestamp": 1700000000000 }
```

Pole `timestamp` by mělo obsahovat hodnotu z ping zprávy.

### Chování při timeoutu

1. Server odešle `ping` na ticku N.
2. Na ticku N+1 server zkontroluje, zda byl `pong` přijat po pingu.
3. Pokud `pong` nebyl přijat (`lastPongAt < lastPingAt`), spojení je uzavřeno s WebSocket close kódem `4001` a důvodem `"heartbeat_timeout"`.
4. Pokud `pong` byl přijat, odešle se nový `ping`.

Postiženo je pouze neodpovídající spojení — ostatní spojení pokračují normálně.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  heartbeat: {
    intervalMs: 15_000,  // ping každých 15 sekund
    timeoutMs: 5_000,    // (informační — timeout je per-tick)
  },
});
```

---

## Backpressure

Když klient čte pomalu, odchozí zprávy se řadí do WebSocket write bufferu. Mechanismus backpressure brání neomezenému růstu paměti tím, že zahazuje nepodstatné push zprávy, když buffer překročí práh.

### Konfigurace

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;
  readonly highWaterMark: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| maxBufferedBytes | `number` | `1048576` (1 MB) | Maximální velikost write bufferu v bajtech. |
| highWaterMark | `number` | `0.8` | Zlomek `maxBufferedBytes`, při kterém se aktivuje backpressure (0.0–1.0). |

### Chování

Práh backpressure se vypočítá jako:

```
threshold = maxBufferedBytes × highWaterMark
```

S výchozími hodnotami: `1 048 576 × 0.8 = 838 860.8 bajtů`.

Když `ws.bufferedAmount >= threshold`:

- **Push zprávy** (aktualizace subscriptions, rule events) jsou tiše zahozeny.
- **Request-response zprávy** (výsledky, chyby) jsou vždy odeslány.
- Reaktivní query subscriptions přirozeně přepošlou data při další změně stavu, takže zahozené pushe nezpůsobují ztrátu dat — pouze dočasnou neaktuálnost.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  backpressure: {
    maxBufferedBytes: 2_097_152,  // 2 MB
    highWaterMark: 0.75,          // aktivace při 75 %
  },
});
```

---

## Limity spojení

### Limit subscriptions

Každé spojení má maximální počet aktivních subscriptions (store + rules dohromady).

```typescript
interface ConnectionLimitsConfig {
  readonly maxSubscriptionsPerConnection: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| maxSubscriptionsPerConnection | `number` | `100` | Maximální počet aktivních subscriptions na jedno spojení. |

Po dosažení limitu `store.subscribe` a `rules.subscribe` vrátí chybu `RATE_LIMITED` se zprávou `"Subscription limit reached (max N per connection)"`.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  connectionLimits: {
    maxSubscriptionsPerConnection: 50,
  },
});
```

---

## Rate Limiting

Rate limiting na bázi klíče s posuvným oknem. Když je nakonfigurován, každý požadavek (včetně `auth.login`) se počítá do limitu.

### Konfigurace

```typescript
interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| maxRequests | `number` | Maximální počet požadavků povolených v jednom okně. |
| windowMs | `number` | Délka posuvného okna v milisekundách. |

### Klíč rate limitu

- **Neautentizovaní klienti:** klíčováno podle vzdálené IP adresy.
- **Autentizovaní klienti:** klíčováno podle `session.userId`.

Klíč se přepne z IP na `userId` ihned po úspěšném `auth.login`. To znamená:

- Pokusy o přihlášení jsou rate-limitovány podle IP (prevence brute force).
- Po přihlášení má každý uživatel nezávislý rate limit bucket.

### Chybová odpověď

Při překročení limitu server vrátí:

```json
{
  "id": 5,
  "type": "error",
  "code": "RATE_LIMITED",
  "message": "Rate limit exceeded. Retry after 45000ms",
  "details": { "retryAfterMs": 45000 }
}
```

### Ve výchozím stavu vypnuto

Rate limiting je aktivní pouze když je `rateLimit` poskytnut v `ServerConfig`. Bez něj se žádný rate limiting neaplikuje.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,  // 100 požadavků za minutu
  },
});
```

---

## Graceful Shutdown

Metoda `NoexServer.stop()` podporuje sekvenci graceful shutdown:

### Okamžité vypnutí (výchozí)

```typescript
await server.stop();
```

1. Přestane přijímat nová spojení.
2. Zastaví všechna spojení přes supervisor (každé odešle WebSocket close frame s kódem `1000`).
3. Zastaví rate limiter (pokud byl spuštěn).
4. Uzavře connection registry.
5. Uzavře HTTP server.

### Graceful Shutdown s grace period

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

1. Přestane přijímat nová spojení.
2. Rozešle `SystemMessage` všem připojeným klientům:
   ```json
   { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
   ```
3. Čeká až `gracePeriodMs` na dobrovolné odpojení všech klientů.
4. Pokud klienti po grace period zůstávají, jsou násilně zastaveni přes supervisor.
5. Uklidí rate limiter a registry.

### Uzavření spojení při shutdown

Když supervisor zastaví spojení:

- Pokud je WebSocket stále otevřený, odešle se close frame s kódem `1000` a důvodem `"normal_closure"` (normální zastavení) nebo `"server_shutdown"` (shutdown zastavení).
- Všechny store a rules subscriptions jsou uklizeny.
- Heartbeat timer je zastaven.

---

## Runtime introspekce

### server.stats

```
{ id, type: "server.stats" }
```

Vrátí snapshot stavu serveru, včetně agregovaných statistik spojení a statistik podřízeného store/rules.

**Parametry:** Žádné.

**Návratová hodnota:**

```typescript
{
  name: string;
  connectionCount: number;
  authEnabled: boolean;
  rateLimitEnabled: boolean;
  rulesEnabled: boolean;
  connections: {
    active: number;
    authenticated: number;
    totalStoreSubscriptions: number;
    totalRulesSubscriptions: number;
  };
  store: unknown;   // výsledek Store.getStats()
  rules: unknown;   // výsledek RuleEngine.getStats() nebo null
}
```

**Příklad:**

```typescript
// Klient posílá:
{ id: 10, type: "server.stats" }

// Server odpovídá:
{
  id: 10,
  type: "result",
  data: {
    name: "noex-server",
    connectionCount: 5,
    authEnabled: true,
    rateLimitEnabled: false,
    rulesEnabled: true,
    connections: {
      active: 5,
      authenticated: 3,
      totalStoreSubscriptions: 12,
      totalRulesSubscriptions: 4
    },
    store: { /* ... */ },
    rules: { /* ... */ }
  }
}
```

### server.connections

```
{ id, type: "server.connections" }
```

Vrátí informace o všech aktivních spojeních.

**Parametry:** Žádné.

**Návratová hodnota:** `ConnectionInfo[]`

```typescript
interface ConnectionInfo {
  readonly connectionId: string;
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}
```

**Příklad:**

```typescript
// Klient posílá:
{ id: 11, type: "server.connections" }

// Server odpovídá:
{
  id: 11,
  type: "result",
  data: [
    {
      connectionId: "conn-1",
      remoteAddress: "192.168.1.10",
      connectedAt: 1700000000000,
      authenticated: true,
      userId: "user-1",
      storeSubscriptionCount: 3,
      rulesSubscriptionCount: 1
    }
  ]
}
```

---

## WebSocket close kódy

| Kód | Důvod | Popis |
|-----|-------|-------|
| `1000` | `normal_closure` | Spojení normálně ukončeno (odpojení klienta nebo zastavení serveru). |
| `1000` | `server_shutdown` | Spojení ukončeno kvůli shutdown serveru přes supervisor. |
| `1001` | `server_shutting_down` | Nové spojení odmítnuto, protože server se vypíná. |
| `4001` | `heartbeat_timeout` | Klient neodpověděl na heartbeat ping. |

---

## Viz také

- [NoexServer](./01-noex-server.md) — Třída serveru s `stop()`, `getStats()`, `getConnections()`
- [Konfigurace](./02-configuration.md) — HeartbeatConfig, BackpressureConfig, RateLimitConfig, ConnectionLimitsConfig
- [Protokol](./03-protocol.md) — Typy HeartbeatPing, HeartbeatPong, SystemMessage
- [Typy](./09-types.md) — ServerStats, ConnectionsStats, ConnectionInfo
- [Autentizace](./07-authentication.md) — Auth session používaná pro přepnutí klíče rate limitu
- [Chyby](./10-errors.md) — Chybové kódy RATE_LIMITED, BACKPRESSURE
