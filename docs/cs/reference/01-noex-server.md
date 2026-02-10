# NoexServer

Hlavní třída serveru. Spravuje WebSocket server, supervisor spojení a volitelný rate limiter. Každé příchozí spojení je zpracováváno dedikovaným GenServer procesem pod supervizí se strategií `simple_one_for_one`.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
```

---

## Factory

### NoexServer.start()

```typescript
static async start(config: ServerConfig): Promise<NoexServer>
```

Vytvoří a spustí novou instanci serveru. Provede následující kroky:

1. Vyřeší konfiguraci s výchozími hodnotami.
2. Spustí rate limiter (pokud je nakonfigurován).
3. Vytvoří connection registry.
4. Spustí connection supervisor.
5. Vytvoří HTTP server s WebSocket upgrade handlerem.
6. Začne naslouchat na nakonfigurovaném `host` a `port`.

Pokud jakýkoli krok selže, všechny dříve vytvořené prostředky jsou uklizeny před vyhozením chyby.

**Parametry:**

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| config | `ServerConfig` | ano | Konfigurace serveru. Povinný je pouze `store`; ostatní pole mají výchozí hodnoty. |

**Návratová hodnota:** `Promise<NoexServer>` — běžící instance serveru

**Příklad:**

```typescript
import { NoexServer } from '@hamicek/noex-server';
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ buckets: { users: {} } });

const server = await NoexServer.start({
  store,
  port: 8080,
  host: '0.0.0.0',
});

console.log(`Naslouchám na portu ${server.port}`);
```

---

## Metody

### stop()

```typescript
async stop(options?: { gracePeriodMs?: number }): Promise<void>
```

Gracefully zastaví server:

1. Přestane přijímat nová spojení (uzavře HTTP server).
2. Pokud `gracePeriodMs > 0`, rozešle `SystemMessage` s `event: "shutdown"` všem připojeným klientům, poté čeká na jejich odpojení nebo vypršení grace period.
3. Zastaví všechna zbývající spojení přes supervisor. Každé `terminate()` spojení odešle WebSocket close frame.
4. Zastaví rate limiter (pokud byl spuštěn).
5. Uzavře connection registry.
6. Počká na dokončení uzavření HTTP serveru.

Volání `stop()` na již zastaveném serveru je no-op.

**Parametry:**

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| options.gracePeriodMs | `number` | ne | Čas v milisekundách pro čekání na odpojení klientů před vynuceným uzavřením. Výchozí: `0` (okamžité). |

**Návratová hodnota:** `Promise<void>`

**Příklad:**

```typescript
// Okamžité vypnutí
await server.stop();

// Graceful shutdown s 5sekundovou grace period
await server.stop({ gracePeriodMs: 5000 });
```

### getConnections()

```typescript
getConnections(): ConnectionInfo[]
```

Vrátí informace o všech aktivních spojeních.

**Návratová hodnota:** `ConnectionInfo[]` — pole objektů s informacemi o spojeních

**Příklad:**

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(`${conn.connectionId}: ${conn.remoteAddress}`);
  console.log(`  Auth: ${conn.authenticated ? conn.userId : 'anonymní'}`);
  console.log(`  Store subs: ${conn.storeSubscriptionCount}`);
}
```

### getStats()

```typescript
async getStats(): Promise<ServerStats>
```

Vrátí snapshot stavu serveru, včetně agregovaných statistik spojení, statistik store a statistik rule enginu (pokud je nakonfigurován).

**Návratová hodnota:** `Promise<ServerStats>` — statistiky serveru

**Příklad:**

```typescript
const stats = await server.getStats();

console.log(`Server: ${stats.name}`);
console.log(`Spojení: ${stats.connectionCount}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);
console.log(`Auth: ${stats.authEnabled ? 'zapnuto' : 'vypnuto'}`);
console.log(`Rate limit: ${stats.rateLimitEnabled ? 'zapnuto' : 'vypnuto'}`);
console.log(`Rules: ${stats.rulesEnabled ? 'zapnuto' : 'vypnuto'}`);
```

---

## Vlastnosti

### port

```typescript
get port(): number
```

Port, na kterém server naslouchá. Užitečné při spuštění serveru s `port: 0` (přiřazení náhodného portu).

**Příklad:**

```typescript
const server = await NoexServer.start({ store, port: 0 });
console.log(`Naslouchám na portu ${server.port}`); // např. 54321
```

### connectionCount

```typescript
get connectionCount(): number
```

Počet aktivních WebSocket spojení spravovaných supervisorem.

### isRunning

```typescript
get isRunning(): boolean
```

Zda server aktuálně běží. Vrací `false` po zavolání `stop()`.

---

## Typy

Typy používané `NoexServer` jsou zdokumentovány samostatně:

- `ServerConfig` — viz [Konfigurace](./02-configuration.md)
- `ServerStats`, `ConnectionsStats` — viz [Typy](./09-types.md)
- `ConnectionInfo` — viz [Typy](./09-types.md)

---

## Viz také

- [Konfigurace](./02-configuration.md) — Konfigurační typy serveru a výchozí hodnoty
- [Protokol](./03-protocol.md) — Specifikace WebSocket protokolu
- [Typy](./09-types.md) — ServerStats, ConnectionsStats, ConnectionInfo
- [Chyby](./10-errors.md) — Chybové kódy a třída chyby
- [Životní cyklus](./08-lifecycle.md) — Heartbeat, backpressure, graceful shutdown
