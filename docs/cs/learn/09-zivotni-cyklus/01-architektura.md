# Architektura

Jak noex-server spravuje WebSocket spojení interně — jeden GenServer na spojení, supervizovaný `simple_one_for_one` supervisorem s dočasnou restart strategií.

## Co se naučíte

- Jak se každé WebSocket spojení mapuje na GenServer proces
- `ConnectionSupervisor` se strategií `simple_one_for_one`
- Proč spojení používají `temporary` restart — spadlá spojení se uklidí, nerestartují
- Životní cyklus spojení: init, zpracování zpráv a terminate
- Jak request pipeline zpracovává každou příchozí zprávu

## Celkový pohled

```
NoexServer.start()
  │
  ├── HTTP Server (upgrade handler)
  │
  ├── WebSocketServer (noServer mode)
  │
  ├── ConnectionSupervisor (simple_one_for_one)
  │     │
  │     ├── ConnectionServer (GenServer) ── WebSocket A
  │     ├── ConnectionServer (GenServer) ── WebSocket B
  │     └── ConnectionServer (GenServer) ── WebSocket C
  │
  ├── ConnectionRegistry (sleduje metadata)
  │
  └── RateLimiter (volitelný GenServer)
```

Každé WebSocket spojení dostane svůj vlastní GenServer — `ConnectionServer`. Ty jsou spravovány jedním `ConnectionSupervisor` pomocí strategie `simple_one_for_one` z `@hamicek/noex`.

## Jeden GenServer na spojení

Když se klient připojí přes WebSocket, server:

1. Vytvoří nový `ConnectionServer` GenServer jako potomka supervisoru
2. Zaregistruje spojení v `ConnectionRegistry`
3. Propojí WebSocket eventy (`message`, `close`) s GenServerem
4. Spustí heartbeat timer

GenServer drží veškerý stav pro dané spojení:

```typescript
interface ConnectionState {
  readonly ws: WebSocket;
  readonly remoteAddress: string;
  readonly connectionId: string;       // "conn-1", "conn-2", ...
  readonly config: ResolvedServerConfig;
  session: AuthSession | null;         // Nastaveno po auth.login
  authenticated: boolean;
  readonly storeSubscriptions: Map<string, () => void>;
  readonly rulesSubscriptions: Map<string, () => void>;
  lastPingAt: number;                  // Sledování heartbeatu
  lastPongAt: number;
}
```

Klíčové body:
- **Izolace** — stav každého spojení (auth session, subscriptions, heartbeat) je plně nezávislý
- **Žádný sdílený proměnlivý stav** — spojení komunikují přes store a rules engine, ne přímo
- **Connection ID** — automaticky inkrementovaný identifikátor (`conn-1`, `conn-2`, ...) přiřazený při vytvoření

## ConnectionSupervisor

Supervisor používá dvě důležitá nastavení:

```typescript
Supervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    start: async (ws, remoteAddress, connectionId) => {
      const behavior = createConnectionBehavior(ws, remoteAddress, config, connectionId);
      return GenServer.start(behavior);
    },
    restart: 'temporary',
    shutdownTimeout: 5_000,
  },
});
```

- **`simple_one_for_one`** — všichni potomci používají stejnou šablonu; noví potomci se startují dynamicky přes `Supervisor.startChild()`
- **`temporary`** — pokud ConnectionServer spadne, je odstraněn ze supervisoru, ale **není restartován**. To je záměrné: spadlé WebSocket spojení nelze obnovit, takže restart by byl zbytečný.
- **`shutdownTimeout: 5_000`** — při graceful shutdown má každý potomek 5 sekund na cleanup

### Proč nerestartovat?

Na rozdíl od dlouhodobého procesu (databáze, cache) je WebSocket spojení inherentně vázáno na konkrétní TCP socket. Pokud GenServer spadne:
- WebSocket je již rozbitý
- Klient se musí znovu připojit a obnovit stav (auth, subscriptions)
- Restart by vytvořil GenServer s mrtvým socketem

Strategie `temporary` zajišťuje, že spadlá spojení se uklidí bez plýtvání zdroji na marné pokusy o restart.

## Životní cyklus spojení

### 1. Init — Welcome zpráva

Když GenServer nastartuje, `init()` pošle klientovi welcome zprávu:

```jsonc
← { "type": "welcome",
    "version": "1.0.0",
    "serverTime": 1706745600000,
    "requiresAuth": false }
```

### 2. Zpracování zpráv — Request Pipeline

Každá příchozí WebSocket zpráva je cast do GenServeru jako `{ type: 'ws_message', raw: string }`. Pipeline ji zpracuje přes tyto fáze:

```
Surová WebSocket zpráva
  │
  ▼
Parsování JSON ──▶ PARSE_ERROR (neplatný JSON, ne-objekt)
  │
  ▼
Validace struktury ──▶ INVALID_REQUEST (chybějící id nebo type)
  │
  ▼
Pong? ──▶ Aktualizace lastPongAt, návrat
  │
  ▼
Kontrola auth ──▶ UNAUTHORIZED (nepřihlášen, session expirovala)
  │
  ▼
Kontrola rate limitu ──▶ RATE_LIMITED (kvóta překročena)
  │
  ▼
Routování požadavku ──▶ store.* / rules.* / auth.* / server.*
  │
  ▼
Odeslání odpovědi ──▶ { type: "result", data: ... }
```

### 3. Push zprávy

Callbacky subscriptions castují `{ type: 'push', subscriptionId, channel, data }` do GenServeru. GenServer kontroluje backpressure před odesláním:

- Pokud je write buffer WebSocketu pod high water mark → odeslat push
- Pokud je backpressure → tiše zahodit push (reaktivní dotazy znovu odešlou při další změně)

### 4. Heartbeat ticky

Heartbeat timer periodicky castuje `{ type: 'heartbeat_tick' }`. GenServer odešle ping a zkontroluje, zda byl předchozí ping potvrzen. Viz [Heartbeat](../10-odolnost/02-heartbeat.md) pro detaily.

### 5. Terminate — Cleanup

Když spojení skončí (odpojení klienta, vypnutí serveru nebo timeout heartbeatu), spustí se `terminate()`:

1. Odhlásí všechny store subscriptions
2. Odhlásí všechny rules subscriptions
3. Zavře WebSocket s kódem `1000`
   - Důvod: `"normal_closure"` pro normální odpojení
   - Důvod: `"server_shutdown"` pro zastavení serveru

```
terminate()
  │
  ├── Odhlášení všech store subscriptions
  ├── Odhlášení všech rules subscriptions
  └── Zavření WebSocketu (kód 1000)
```

## Propojení eventů

WebSocket eventy jsou propojené s GenServerem v `addConnection()` supervisoru:

```
WebSocket event         →  GenServer cast
─────────────────────────────────────────
ws.on('message')        →  { type: 'ws_message', raw }
ws.on('close')          →  heartbeat.stop() + GenServer.stop(ref, 'normal')
ws.on('error')          →  (no-op — vždy následuje close)
setInterval(tick)       →  { type: 'heartbeat_tick' }
```

Handler `ws.on('error')` je záměrně prázdný — WebSocket chyby jsou vždy následovány eventem `close`, takže cleanup probíhá v close handleru.

## Funkční příklad

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'arch-demo' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
    done:  { type: 'boolean', default: false },
  },
});

const server = await NoexServer.start({ store, port: 8080 });

console.log(`Server běží na portu ${server.port}`);
console.log(`Spojení: ${server.connectionCount}`);
console.log(`Běží: ${server.isRunning}`);

// Každý klient, který se připojí, dostane:
// 1. Svůj vlastní GenServer (ConnectionServer)
// 2. Welcome zprávu
// 3. Nezávislý stav (auth, subscriptions, heartbeat)
```

## Cvičení

Nakreslete sekvenci událostí, které nastanou, když:
1. Klient se připojí přes WebSocket
2. Pošle `store.insert` pro vytvoření záznamu
3. Klient se odpojí

Identifikujte, které komponenty jsou zapojeny v každém kroku.

<details>
<summary>Řešení</summary>

```
1. Klient se připojí
   ─────────────────────────────────────────────────────
   HTTP Server    →  Upgrade request
   WSS            →  'connection' event
   Supervisor     →  startChild() → nový ConnectionServer GenServer
   Registry       →  registerConnection(connectionId, metadata)
   Heartbeat      →  startHeartbeat(tick, intervalMs)
   GenServer init →  odeslání welcome zprávy klientovi
   Klient         ←  { type: "welcome", version: "1.0.0", ... }

2. Klient pošle store.insert
   ─────────────────────────────────────────────────────
   WebSocket      →  ws.on('message') se spustí
   GenServer      ←  cast { type: 'ws_message', raw: '...' }
   Pipeline       →  parse → checkAuth → checkRateLimit → routeRequest
   Store          →  store.insert('tasks', { title: 'Test' })
   GenServer      →  sendRaw(ws, serializeResult(id, data))
   Klient         ←  { id: 1, type: "result", data: { id: "abc", ... } }

3. Klient se odpojí
   ─────────────────────────────────────────────────────
   WebSocket      →  ws.on('close') se spustí
   Heartbeat      →  heartbeat.stop() (clear interval)
   GenServer      →  GenServer.stop(ref, 'normal')
   terminate()    →  odhlášení všech store + rules subscriptions
   terminate()    →  ws.close(1000, 'normal_closure')
   Registry       →  spojení odstraněno (GenServer odregistrován)
```

</details>

## Shrnutí

- Každé WebSocket spojení je spravováno vlastním `ConnectionServer` GenServerem
- `ConnectionSupervisor` používá `simple_one_for_one` s `temporary` restart — spadlá spojení se uklidí, nikdy nerestartují
- Stav spojení (auth, subscriptions, heartbeat) je plně izolovaný per-connection
- Request pipeline: parse → auth check → rate limit → route → respond
- `terminate()` zajišťuje, že všechny subscriptions se uklidí a WebSocket se korektně zavře
- WebSocket chyby jsou vždy následovány close eventy — cleanup probíhá jednou

---

Další: [Registr spojení](./02-registr.md)
