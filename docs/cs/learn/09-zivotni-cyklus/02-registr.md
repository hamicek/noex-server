# Registr spojení

Inspekce aktivních spojení za běhu — per-connection metadata, agregované statistiky a introspekce serveru přístupná přes WebSocket.

## Co se naučíte

- `server.getConnections()` — výpis všech aktivních spojení s metadaty
- `server.connectionCount` — rychlý počet aktivních spojení
- `server.getStats()` — agregované statistiky serveru
- Pole `ConnectionInfo` — jaká metadata se sledují per-connection
- WebSocket operace `server.stats` a `server.connections`

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'registry-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
  },
});

store.defineQuery('all-users', async (ctx) => ctx.bucket('users').all());

const server = await NoexServer.start({
  store,
  port: 8080,
  name: 'my-app',
  auth: {
    validate: async (token) => {
      if (token === 'token-alice') {
        return { userId: 'alice', roles: ['admin'] };
      }
      return null;
    },
    required: false,
  },
});
```

## ConnectionInfo

Každé spojení je sledováno s následujícími metadaty:

```typescript
interface ConnectionInfo {
  readonly connectionId: string;            // "conn-1", "conn-2", ...
  readonly remoteAddress: string;           // IP adresa klienta
  readonly connectedAt: number;             // Unix timestamp (ms)
  readonly authenticated: boolean;          // true po auth.login
  readonly userId: string | null;           // null dokud není autentizován
  readonly storeSubscriptionCount: number;  // Aktivní store subscriptions
  readonly rulesSubscriptionCount: number;  // Aktivní rules subscriptions
}
```

Metadata se aktualizují automaticky:
- **Při připojení** — `authenticated: false`, `userId: null`, počty subscriptions `0`
- **Při `auth.login`** — `authenticated: true`, `userId` nastaveno
- **Při `auth.logout`** — `authenticated: false`, `userId: null`
- **Při `store.subscribe` / `store.unsubscribe`** — `storeSubscriptionCount` aktualizováno
- **Při `rules.subscribe` / `rules.unsubscribe`** — `rulesSubscriptionCount` aktualizováno
- **Při odpojení** — spojení odstraněno z registru

## server.getConnections()

Vrací pole `ConnectionInfo` pro všechna aktivní spojení:

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(conn.connectionId);            // "conn-1"
  console.log(conn.remoteAddress);           // "127.0.0.1"
  console.log(conn.connectedAt);            // 1706745600000
  console.log(conn.authenticated);           // true
  console.log(conn.userId);                  // "alice"
  console.log(conn.storeSubscriptionCount);  // 2
  console.log(conn.rulesSubscriptionCount);  // 0
}
```

Vrací prázdné pole, pokud nejsou připojení žádní klienti.

## server.connectionCount

Rychlý způsob, jak zjistit počet aktivních spojení bez načítání plných metadat:

```typescript
console.log(server.connectionCount); // 3
```

Čte přímo počet potomků supervisoru — žádný dotaz do registru není potřeba.

## server.getStats()

Vrací agregované statistiky o celém serveru:

```typescript
const stats = await server.getStats();
```

```typescript
interface ServerStats {
  readonly name: string;                // Název serveru z konfigurace
  readonly port: number;                // Port, na kterém naslouchá
  readonly host: string;                // Host, na kterém naslouchá
  readonly connectionCount: number;     // Aktivní spojení
  readonly uptimeMs: number;            // Doba od spuštění serveru
  readonly authEnabled: boolean;        // Zda je auth nakonfigurován
  readonly rateLimitEnabled: boolean;   // Zda je rate limiting nakonfigurován
  readonly rulesEnabled: boolean;       // Zda je rules engine nakonfigurován
  readonly connections: ConnectionsStats;
  readonly store: unknown;              // Statistiky store (z store.getStats())
  readonly rules: unknown;              // Statistiky rules nebo null
}

interface ConnectionsStats {
  readonly active: number;                   // Celkem aktivních spojení
  readonly authenticated: number;            // Spojení s platnou session
  readonly totalStoreSubscriptions: number;  // Součet přes všechna spojení
  readonly totalRulesSubscriptions: number;  // Součet přes všechna spojení
}
```

## WebSocket operace

Statistiky i seznam spojení jsou dostupné i přes WebSocket protokol, takže klienti mohou inspektovat server bez přímého přístupu k instanci `NoexServer`.

### server.stats

```jsonc
→ { "id": 1, "type": "server.stats" }

← { "id": 1, "type": "result",
    "data": {
      "name": "my-app",
      "connectionCount": 3,
      "authEnabled": true,
      "rateLimitEnabled": false,
      "rulesEnabled": false,
      "connections": {
        "active": 3,
        "authenticated": 1,
        "totalStoreSubscriptions": 4,
        "totalRulesSubscriptions": 0
      },
      "store": { ... },
      "rules": null
    } }
```

### server.connections

```jsonc
→ { "id": 2, "type": "server.connections" }

← { "id": 2, "type": "result",
    "data": [
      {
        "connectionId": "conn-1",
        "remoteAddress": "192.168.1.10",
        "connectedAt": 1706745600000,
        "authenticated": true,
        "userId": "alice",
        "storeSubscriptionCount": 2,
        "rulesSubscriptionCount": 0
      },
      {
        "connectionId": "conn-2",
        "remoteAddress": "192.168.1.20",
        "connectedAt": 1706745610000,
        "authenticated": false,
        "userId": null,
        "storeSubscriptionCount": 0,
        "rulesSubscriptionCount": 0
      }
    ] }
```

## Životní cyklus metadat

```
Připojení
  │
  ▼
Registr: { authenticated: false, userId: null, subs: 0 }
  │
  ▼
auth.login ──▶ { authenticated: true, userId: "alice" }
  │
  ▼
store.subscribe ──▶ { storeSubscriptionCount: 1 }
store.subscribe ──▶ { storeSubscriptionCount: 2 }
  │
  ▼
store.unsubscribe ──▶ { storeSubscriptionCount: 1 }
  │
  ▼
auth.logout ──▶ { authenticated: false, userId: null }
  │
  ▼
Odpojení ──▶ Spojení odstraněno z registru
```

## Chybové kódy

| Chybový kód | Příčina |
|-------------|---------|
| `UNKNOWN_OPERATION` | Neznámá `server.*` operace (např. `server.unknown`) |

## Funkční příklad

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  name: 'my-app',
});

// Na straně serveru: inspekce spojení
console.log(server.connectionCount); // 0

// ... klienti se připojí ...

const connections = server.getConnections();
console.log(connections.length); // 2

const stats = await server.getStats();
console.log(stats.name);                              // "my-app"
console.log(stats.uptimeMs);                           // 12345
console.log(stats.connections.active);                 // 2
console.log(stats.connections.authenticated);           // 1
console.log(stats.connections.totalStoreSubscriptions); // 3

// Na straně klienta: inspekce přes WebSocket
// → { "id": 1, "type": "server.stats" }
// ← { "id": 1, "type": "result", "data": { "name": "my-app", ... } }

// → { "id": 2, "type": "server.connections" }
// ← { "id": 2, "type": "result", "data": [ { "connectionId": "conn-1", ... } ] }
```

## Cvičení

Nastavte server s volitelnou autentizací. Připojte dva klienty:
1. Autentizujte prvního klienta
2. Vytvořte store subscription na druhém klientovi
3. Pomocí `server.connections` ověřte stav obou spojení
4. Odpojte prvního klienta a ověřte, že byl odstraněn

<details>
<summary>Řešení</summary>

```jsonc
// Klient A se připojí
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": false }

// Klient B se připojí
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": false }

// 1. Klient A se autentizuje
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", "roles": ["admin"] } }

// 2. Klient B se přihlásí k odběru
→ { "id": 2, "type": "store.subscribe", "query": "all-users" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-1", "initialData": [] } }

// 3. Klient A zkontroluje spojení
→ { "id": 3, "type": "server.connections" }
← { "id": 3, "type": "result",
    "data": [
      { "connectionId": "conn-1", "authenticated": true, "userId": "alice",
        "storeSubscriptionCount": 0, "rulesSubscriptionCount": 0 },
      { "connectionId": "conn-2", "authenticated": false, "userId": null,
        "storeSubscriptionCount": 1, "rulesSubscriptionCount": 0 }
    ] }

// 4. Klient A se odpojí, Klient B ověří
→ { "id": 4, "type": "server.connections" }
← { "id": 4, "type": "result",
    "data": [
      { "connectionId": "conn-2", "authenticated": false, "userId": null,
        "storeSubscriptionCount": 1, "rulesSubscriptionCount": 0 }
    ] }
```

</details>

## Shrnutí

- `server.getConnections()` vrací `ConnectionInfo[]` — per-connection metadata
- `server.connectionCount` je lehký počet přes supervisor
- `server.getStats()` vrací agregované `ServerStats` včetně spojení, store a rules
- `ConnectionInfo` sleduje: `connectionId`, `remoteAddress`, `connectedAt`, `authenticated`, `userId`, počty subscriptions
- Metadata se aktualizují automaticky při auth eventech a změnách subscriptions
- WebSocket operace `server.stats` a `server.connections` zpřístupňují stejná data klientům
- Spojení se odstraní z registru při odpojení

---

Další: [Elegantní ukončení](./03-elegantni-ukonceni.md)
