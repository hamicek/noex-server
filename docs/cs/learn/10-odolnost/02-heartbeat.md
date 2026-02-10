# Heartbeat

Detekce mrtvých spojení pomocí serverem iniciovaných ping/pong zpráv. Klienti, kteří neodpoví na ping v rámci dalšího intervalu, jsou zavřeni s kódem `4001`.

## Co se naučíte

- `HeartbeatConfig` — `intervalMs` a `timeoutMs`
- Ping/pong protokol: `{ type: "ping", timestamp }` / `{ type: "pong", timestamp }`
- Detekce timeoutu — close kód `4001` (`heartbeat_timeout`)
- Výchozí konfigurace (30s interval, 10s timeout)
- Zavírají se pouze neodpovídající spojení — ostatní nejsou ovlivněna

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'heartbeat-demo' });

store.defineBucket('data', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    value: { type: 'number', required: true },
  },
});

const server = await NoexServer.start({
  store,
  port: 8080,
  heartbeat: {
    intervalMs: 30_000,  // Odeslat ping každých 30 sekund
    timeoutMs: 10_000,   // (rezervováno pro budoucí použití)
  },
});
```

## HeartbeatConfig

```typescript
interface HeartbeatConfig {
  readonly intervalMs: number;  // Interval pingu v ms (výchozí: 30_000)
  readonly timeoutMs: number;   // Rezervováno pro budoucí použití (výchozí: 10_000)
}
```

- **`intervalMs`** — jak často server posílá ping každému spojení
- **`timeoutMs`** — aktuálně rezervováno; efektivní timeout odpovídá jednomu cyklu `intervalMs`

**Výchozí hodnoty:**

```typescript
{
  intervalMs: 30_000,  // 30 sekund
  timeoutMs: 10_000,   // 10 sekund
}
```

Heartbeat je vždy zapnutý — nelze ho vypnout. Můžete nastavit velmi velký `intervalMs`, aby byl efektivně neaktivní.

## Ping/Pong protokol

### Server posílá ping

Každých `intervalMs` server pošle ping každému spojení:

```jsonc
← { "type": "ping", "timestamp": 1706745600000 }
```

`timestamp` je `Date.now()` v okamžiku odeslání pingu.

### Klient odpovídá pongem

Klient musí odpovědět pongem obsahujícím stejný timestamp:

```jsonc
→ { "type": "pong", "timestamp": 1706745600000 }
```

**Poznámka:** Zpráva pong nevyžaduje pole `id` — je to jediná klientská zpráva, která nepoužívá korelaci request/response.

## Detekce timeoutu

Při každém heartbeat ticku server kontroluje:

1. Byl odeslán ping od posledního pongu? (`lastPingAt > 0 && lastPongAt < lastPingAt`)
2. Pokud ano → klient neodpověděl → zavřít s kódem `4001`
3. Pokud ne → odeslat nový ping

```
Tick 1: Žádný předchozí ping → odeslat ping
        ← { "type": "ping", "timestamp": T1 }

        Klient odpoví:
        → { "type": "pong", "timestamp": T1 }

Tick 2: Pong přijat (lastPongAt ≥ lastPingAt) → odeslat nový ping
        ← { "type": "ping", "timestamp": T2 }

        Klient NEODPOVÍ...

Tick 3: Žádný pong od T2 (lastPongAt < lastPingAt) → ZAVŘÍT 4001
        WebSocket zavřen s kódem 4001, důvod "heartbeat_timeout"
```

Efektivní okno timeoutu je jeden cyklus `intervalMs`. Pokud klient odpoví na ping kdykoli před dalším tickem, spojení zůstane naživu.

## Close kód 4001

Když klient neodpoví na ping, server zavře spojení s:

- **Kód:** `4001` (vlastní WebSocket close kód)
- **Důvod:** `"heartbeat_timeout"`

```
Klient ← close(4001, "heartbeat_timeout")
```

Kód `4001` je v rozsahu pro privátní použití (4000–4999), bezpečný pro aplikačně specifické signály.

## Selektivní zavření

Zavírá se pouze neodpovídající spojení. Ostatní spojení nejsou ovlivněna:

```
Spojení A: odpovídá na pingy ──▶ zůstává naživu ✓
Spojení B: tiché (žádný pong) ──▶ zavřeno s 4001 ✗
Spojení C: odpovídá na pingy ──▶ zůstává naživu ✓
```

Po zavření Spojení B pokračují Spojení A a C normálně.

## Zpožděný pong

Klient nemusí odpovědět okamžitě. Pong odeslaný kdykoli před dalším tickem je akceptován:

```
intervalMs: 150ms

Tick 1 (t=0ms):    ← ping { timestamp: T1 }
Klient (t=100ms):  → pong { timestamp: T1 }   // 100ms zpoždění — OK
Tick 2 (t=150ms):  lastPongAt > lastPingAt → odeslat nový ping ✓
```

Dokud pong dorazí před dalším heartbeat tickem, spojení zůstane naživu.

## Spojení zůstává funkční

Heartbeat funguje nezávisle na request/response. Po více heartbeat výměnách je spojení plně funkční:

```jsonc
// Heartbeat výměna probíhá na pozadí
← { "type": "ping", "timestamp": 1706745600000 }
→ { "type": "pong", "timestamp": 1706745600000 }

// Klient může stále posílat požadavky kdykoli
→ { "id": 5, "type": "store.insert", "bucket": "data",
    "data": { "value": 42 } }
← { "id": 5, "type": "result",
    "data": { "id": "abc-123", "value": 42 } }

// Další heartbeat výměna
← { "type": "ping", "timestamp": 1706745630000 }
→ { "type": "pong", "timestamp": 1706745630000 }
```

## Cleanup při zastavení serveru

Když se zavolá `server.stop()`, heartbeat timery se vyčistí automaticky:
- Handler `ws.on('close')` volá `heartbeat.stop()`, který clearuje interval
- Po zavření spojení se neposílají žádné další pingy

## Proč heartbeat?

WebSocket spojení mohou tiše zemřít (výpadek sítě, pád klienta, NAT timeout). Bez heartbeatu:

| Problém | Bez heartbeatu | S heartbeatem |
|---------|---------------|---------------|
| Klient spadne | Server drží mrtvé spojení neomezeně | Detekováno za ~30s, spojení vyčištěno |
| Výpadek sítě | Subscriptions tečou, plýtvání zdroji | Vyčištěno po jednom zmeškaném pongu |
| NAT timeout | Spojení vypadá živé, ale je mrtvé | Ping udržuje NAT mapování aktivní |

## Funkční příklad

**Server:**

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  heartbeat: {
    intervalMs: 30_000,
    timeoutMs: 10_000,
  },
});
```

**Klient s auto-pongem:**

```typescript
const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'ping') {
    // Odpovědět pro udržení spojení naživu
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
    return;
  }

  // Zpracování ostatních zpráv...
});

ws.on('close', (code, reason) => {
  if (code === 4001) {
    console.log('Spojení zavřeno: heartbeat timeout');
    // Logika pro reconnect zde
  }
});
```

## Cvičení

Popište, co se stane v následujícím scénáři s `heartbeat: { intervalMs: 100, timeoutMs: 50 }`:
1. Klient A se připojí a automaticky odpovídá na pingy
2. Klient B se připojí a NEODPOVÍDÁ na pingy
3. Po 250 ms, kteří klienti jsou stále připojeni?
4. Klient A pošle `store.insert` — uspěje?

<details>
<summary>Řešení</summary>

```
Časová osa s intervalMs: 100ms

t=0ms:     Klient A a B se připojí, obdrží welcome zprávy

t=100ms:   Tick 1
           Server → Klient A: ping { timestamp: T1 }
           Server → Klient B: ping { timestamp: T1 }
           Klient A → Server: pong { timestamp: T1 }  ✓
           Klient B: (ticho)

t=200ms:   Tick 2
           Klient A: lastPongAt ≥ lastPingAt → odeslat nový ping ✓
           Klient B: lastPongAt < lastPingAt → ZAVŘÍT 4001 ✗
           Server → Klient A: ping { timestamp: T2 }
           Server zavírá Klient B s kódem 4001, důvod "heartbeat_timeout"

t=250ms:   Kontrola stavu
           Klient A: připojen ✓ (odpovídal na pingy)
           Klient B: odpojen ✗ (zavřen v t=200ms)

           Klient A posílá store.insert:
           → { "id": 1, "type": "store.insert", "bucket": "data",
               "data": { "value": 42 } }
           ← { "id": 1, "type": "result",
               "data": { "id": "...", "value": 42 } }
           Úspěch ✓ — heartbeat neovlivňuje zpracování požadavků
```

</details>

## Shrnutí

- Heartbeat posílá periodický `{ type: "ping", timestamp }` — klienti musí odpovědět `{ type: "pong", timestamp }`
- Výchozí interval: 30 sekund — konfigurovatelný přes `heartbeat.intervalMs`
- Klienti, kteří zmeškají jeden cyklus pongu, jsou zavřeni s kódem `4001` (`heartbeat_timeout`)
- Zavírají se pouze neodpovídající spojení — ostatní nejsou ovlivněna
- Pong nevyžaduje pole `id` — je to jediná klientská zpráva bez korelace request/response
- Zpožděný pong je v pořádku, pokud dorazí před dalším tickem
- Heartbeat je vždy zapnutý — nastavte velký `intervalMs` pro efektivní vypnutí
- Heartbeat udržuje NAT mapování aktivní a detekuje tiše mrtvá spojení

---

Další: [Backpressure](./03-backpressure.md)
