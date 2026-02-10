# Elegantní ukončení

Čisté zastavení serveru — notifikace připojených klientů, poskytnutí času na dokončení práce a vypnutí všech zdrojů ve správném pořadí.

## Co se naučíte

- `server.stop()` — okamžité ukončení
- `server.stop({ gracePeriodMs })` — notifikace klientů a čekání před zavřením
- Systémová zpráva `shutdown`, kterou klienti obdrží
- Kompletní sekvence ukončení
- Co se děje s novými spojeními během ukončování
- Idempotentní chování stop

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'shutdown-demo' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    title: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({ store, port: 8080 });
```

## Okamžité ukončení

Zavolejte `stop()` bez parametrů pro okamžité ukončení:

```typescript
await server.stop();
```

Toto:
1. Přestane přijímat nová spojení
2. Násilně zavře všechna aktivní spojení (spustí se `terminate()` každého GenServeru)
3. Zastaví rate limiter (pokud je nakonfigurován)
4. Zavře registr spojení
5. Zavře HTTP server

`terminate()` každého spojení odhlásí všechny subscriptions a odešle WebSocket close frame s kódem `1000`.

## Elegantní ukončení s grace period

Předejte `gracePeriodMs` pro poskytnutí času klientům na dokončení:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

### Sekvence ukončení

```
server.stop({ gracePeriodMs: 5000 })
  │
  ▼
1. Přestat přijímat nová spojení (HTTP server zavřen)
  │
  ▼
2. Broadcast systémové shutdown zprávy všem klientům
   ← { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }
  │
  ▼
3. Čekání až 5000 ms na dobrovolné odpojení klientů
   (ukončí se dříve, pokud se všichni klienti odpojí před timerem)
  │
  ▼
4. Násilné ukončení zbývajících spojení přes Supervisor
   (terminate() → odhlášení všeho → ws.close(1000, 'server_shutdown'))
  │
  ▼
5. Zastavení rate limiteru (pokud je nakonfigurován)
  │
  ▼
6. Zavření registru spojení
  │
  ▼
7. Zavření HTTP serveru
```

### Systémová zpráva shutdown

Pokud je specifikován grace period a existují aktivní spojení, server broadcastuje:

```jsonc
← { "type": "system",
    "event": "shutdown",
    "gracePeriodMs": 5000 }
```

Toto říká klientům:
- Server se vypíná
- Mají `gracePeriodMs` milisekund na dokončení práce a odpojení
- Po grace period server násilně zavře všechna zbývající spojení

### Bez grace period, bez zprávy

Pokud je `gracePeriodMs` `0` (výchozí), žádná shutdown zpráva se neodesílá — spojení se zavřou okamžitě:

```typescript
// Tyto jsou ekvivalentní — žádná shutdown zpráva se neodesílá
await server.stop();
await server.stop({ gracePeriodMs: 0 });
```

## Chování klientů během grace period

Klienti **mohou stále posílat požadavky** během grace period. Spojení je plně funkční, dokud ho server násilně nezavře:

```jsonc
// Server pošle shutdown notifikaci
← { "type": "system", "event": "shutdown", "gracePeriodMs": 5000 }

// Klient stále může pracovat během grace period
→ { "id": 10, "type": "store.insert", "bucket": "tasks",
    "data": { "title": "Uložit před vypnutím" } }
← { "id": 10, "type": "result", "data": { "id": "abc-123", ... } }

// Klient se dobrovolně odpojí
```

## Předčasné ukončení

Pokud se všichni klienti odpojí před vypršením grace period, `stop()` se resolvne okamžitě — nečeká na celý timer:

```typescript
// Grace period je 10 sekund, ale pokud se všichni 3 klienti
// odpojí po 200 ms, stop() se resolvne za ~200 ms
await server.stop({ gracePeriodMs: 10_000 });
```

## Nová spojení během ukončování

Jakmile se zavolá `stop()`, nová WebSocket spojení jsou okamžitě odmítnuta:

- HTTP server přestane přijímat nová TCP spojení
- Jakýkoli WebSocket, kterému se podaří připojit během okna ukončování, je zavřen s kódem `1001` a důvodem `'server_shutting_down'`

## Close kódy

| Kód | Důvod | Kdy |
|-----|-------|-----|
| `1000` | `normal_closure` | Klient se normálně odpojí |
| `1000` | `server_shutdown` | Server násilně zavře během/po grace period |
| `1001` | `server_shutting_down` | Pokus o nové spojení během ukončování |

## Idempotentní stop

Volání `stop()` vícekrát je bezpečné — následná volání se vrátí okamžitě:

```typescript
await server.stop();
await server.stop(); // No-op, vrátí se okamžitě
```

Po zastavení `server.isRunning` vrací `false`.

## Funkční příklad

```typescript
const server = await NoexServer.start({ store, port: 8080 });

// Zpracování procesových signálů pro čisté ukončení
process.on('SIGTERM', async () => {
  console.log('Přijat SIGTERM, ukončuji...');
  await server.stop({ gracePeriodMs: 5000 });
  await store.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Přijat SIGINT, ukončuji...');
  await server.stop({ gracePeriodMs: 5000 });
  await store.stop();
  process.exit(0);
});
```

**Zpracování na straně klienta:**

```typescript
// Klient naslouchá shutdown zprávě
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'system' && msg.event === 'shutdown') {
    console.log(`Server se vypíná za ${msg.gracePeriodMs}ms`);
    // Uložit stav, odhlásit subscriptions, čistě se odpojit
    ws.close();
  }
});
```

## Cvičení

Napište scénář ukončení:
1. Spusťte server s jedním připojeným klientem
2. Klient má aktivní subscription
3. Zahajte elegantní ukončení s 2-sekundovým grace period
4. Ukažte, co klient obdrží
5. Klient uloží záznam a odpojí se během grace period

<details>
<summary>Řešení</summary>

```jsonc
// Klient je připojen se subscription
// (store.subscribe byl zavolán dříve, přijímá push aktualizace)

// Server volá: await server.stop({ gracePeriodMs: 2000 })

// 1. Klient obdrží shutdown notifikaci
← { "type": "system", "event": "shutdown", "gracePeriodMs": 2000 }

// 2. Klient uloží práci na poslední chvíli
→ { "id": 20, "type": "store.insert", "bucket": "tasks",
    "data": { "title": "Nouzové uložení" } }
← { "id": 20, "type": "result",
    "data": { "id": "xyz-789", "title": "Nouzové uložení" } }

// 3. Klient se dobrovolně odpojí
//    (WebSocket close iniciovaný klientem)

// Na straně serveru: všichni klienti se odpojili dříve
// → stop() se resolvne okamžitě (před vypršením 2s timeru)
// → Subscriptions vyčištěny v terminate()
// → Rate limiter zastaven, registr zavřen, HTTP server zavřen
```

</details>

## Shrnutí

- `server.stop()` zavře všechna spojení okamžitě (bez notifikace)
- `server.stop({ gracePeriodMs })` broadcastuje systémovou `shutdown` zprávu a čeká
- Klienti mohou stále posílat požadavky během grace period
- Pokud se všichni klienti odpojí dříve, `stop()` se resolvne okamžitě
- Nová spojení během ukončování jsou odmítnuta s close kódem `1001`
- `terminate()` každého spojení odhlásí všechny subscriptions a zavře WebSocket
- `stop()` je idempotentní — bezpečné volat vícekrát
- Close kód spojení je `1000` s důvodem `"server_shutdown"` pro násilná zavření

---

Další: [Rate Limiting](../10-odolnost/01-rate-limiting.md)
