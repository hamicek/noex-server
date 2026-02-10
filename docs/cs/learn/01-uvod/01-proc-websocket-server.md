# Proč WebSocket server?

Většina backendů začíná REST endpointy. Přijde request, server odpoví, hotovo. Jakmile ale aplikace roste, začnete potřebovat data v reálném čase: živé dashboardy, kolaborativní editaci, okamžité notifikace. Najednou REST nestačí.

noex-server vám dává protocol-first WebSocket server s vestavěným CRUD, reaktivními subscriptions, transakcemi, autentizací a produkční odolností — vše pod dohledem GenServer procesů, které nikdy nenechají viset opuštěný stav.

## Co se naučíte

- Proč REST polling nestačí pro real-time aplikace
- Jak WebSocket push mění model toku dat
- Co nabízí protocol-first server oproti práci s holým WebSocket
- Jak GenServer supervision zajišťuje spolehlivost každého spojení

## Problém s REST polling

Když klient potřebuje aktuální data z REST API, má dvě možnosti:

### Možnost 1: Polling

```text
Client                          Server
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob] ──────│
  │                                │
  │     (wait 5 seconds...)        │
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob] ──────│   ← No change. Wasted request.
  │                                │
  │     (wait 5 seconds...)        │
  │                                │
  │──── GET /users ───────────────►│
  │◄─── 200 OK [Alice, Bob, Carol]│   ← Carol added 4 seconds ago.
  │                                │      Stale by up to 5 seconds.
```

Polling plýtvá šířkou pásma, když se data nezměnila, a mezi intervaly doručuje zastaralá data. Zkrácení intervalu zvyšuje zátěž, aniž by eliminovalo zpoždění.

### Možnost 2: Long polling / SSE

Server-Sent Events (SSE) řeší push pro jednosměrnou komunikaci, ale fungují pouze přes HTTP, jsou jednosměrné a vyžadují samostatný kanál pro zprávy od klienta k serveru. Skončíte s údržbou dvou protokolů: REST pro zápisy, SSE pro čtení.

### WebSocket: obousměrný, trvalý, efektivní

```text
Client                          Server
  │                                │
  │══ WebSocket Connected ═════════│
  │                                │
  │──── insert user "Carol" ──────►│
  │◄─── result: { id: "c3" } ─────│
  │                                │
  │◄─── push: [Alice, Bob, Carol] ─│   ← Immediate. No polling.
  │                                │
  │──── subscribe to "all-users" ─►│
  │◄─── result: { subId: "s1" } ──│
  │                                │
  │◄─── push: [Alice, Bob, Carol] ─│   ← Subscription delivers
  │                                │      live results.
```

Jediné WebSocket spojení zvládne oba směry. Server posílá data okamžitě ve chvíli, kdy se změní. Žádné zbytečné requesty, žádné zastaralé intervaly.

## REST vs WebSocket vs noex-server

| Dimenze | REST + Polling | Raw WebSocket | noex-server |
|-----------|---------------|---------------|-------------|
| **Latence** | Až do délky polling intervalu | Okamžitý push | Okamžitý push |
| **Šířka pásma** | Plýtvání na prázdné polly | Efektivní | Efektivní |
| **Protokol** | HTTP na každý request | Stavíte si sami | JSON protokol v1.0.0 vestavěný |
| **CRUD** | Stavíte si routy | Stavíte si zpracování zpráv | `store.insert`, `store.get` atd. |
| **Subscriptions** | Samostatný SSE kanál | Stavíte si pub/sub | `store.subscribe` s reaktivními dotazy |
| **Chybové kódy** | HTTP status kódy | Definujete si sami | 15 typovaných chybových kódů |
| **Auth** | Middleware na každou routu | Stavíte si sami | `auth.login` s pluggable validací |
| **Zdraví spojení** | N/A | Stavíte si ping/pong | Heartbeat s automatickým odpojením |
| **Odolnost proti chybám** | Pád procesu = ztracený stav | Ruční úklid | GenServer na spojení se supervision |

## Co nabízí protocol-first server

Místo toho, abyste od nuly stavěli zpracování WebSocket zpráv, routing, formátování chyb a správu subscriptions, noex-server přichází s:

1. **Typovaný protokol** — každá zpráva má definovanou strukturu, verzi a chybový kód
2. **Korelace request/response** — každý request nese `id`, které se vrátí v odpovědi
3. **Push kanály** — serverem iniciované zprávy na pojmenovaných kanálech (`subscription`, `event`)
4. **Routing operací** — jmenné prostory `store.*`, `rules.*` a `auth.*` s vestavěnou validací
5. **Taxonomie chyb** — 15 chybových kódů od `PARSE_ERROR` po `RULES_NOT_AVAILABLE`, každý s jasným postupem pro obnovu

## GenServer supervision

Každé WebSocket spojení spravuje dedikovaný GenServer proces:

```text
NoexServer
└── ConnectionSupervisor (simple_one_for_one)
    ├── ConnectionServer #1  ← GenServer per WebSocket
    ├── ConnectionServer #2
    └── ConnectionServer #N
```

Pokud ConnectionServer spadne (např. kvůli chybě ve zpracování zprávy), supervisor uklidí dané spojení — všechny subscriptions se odhlásí, WebSocket se zavře — bez jakéhokoli dopadu na ostatní spojení. Pád je izolovaný.

To se zásadně liší od typického Node.js WebSocket serveru, kde neošetřená chyba v jednom handleru zpráv může shodit celý proces.

## Funkční příklad

Minimální server, který přijímá WebSocket spojení:

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'demo' });

store.defineBucket('messages', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    text: { type: 'string', required: true },
    from: { type: 'string', required: true },
  },
});

const server = await NoexServer.start({
  port: 8080,
  store,
});

console.log(`Listening on ws://localhost:${server.port}`);
```

Klient se připojí a pošle JSON:

```jsonc
// Client sends:
→ { "id": 1, "type": "store.insert", "bucket": "messages", "data": { "text": "Hello!", "from": "Alice" } }

// Server responds:
← { "id": 1, "type": "result", "data": { "id": "a1b2c3", "text": "Hello!", "from": "Alice", "_version": 1, "_createdAt": 1706745600000 } }
```

## Cvičení

Zamyslete se nad aplikací, kterou jste vytvořili (nebo používali) a která dělá REST polling pro real-time data. Odpovězte na tyto otázky:

1. Jaký je polling interval?
2. Jaké je maximální zpoždění, které uživatel zažívá?
3. Kolik requestů za minutu generuje každý klient?
4. Kolik procent z těchto requestů vrací nezměněná data?

<details>
<summary>Diskuze</summary>

Pro typický dashboard s pollingem každých 5 sekund:
- Maximální zpoždění: 5 sekund
- Requestů za minutu na klienta: 12
- Pokud se data mění průměrně jednou za minutu, ~92 % requestů vrací nezměněná data

S WebSocket push v noex-server:
- Maximální zpoždění: 0 (push při změně)
- Requestů za minutu: 0 (server pushuje)
- Nula zbytečných requestů

Úspora se násobí s každým připojeným klientem. 100 pollingových klientů x 12 req/min = 1 200 req/min. S push: 100 push zpráv pouze když se data změní.

</details>

## Shrnutí

- REST polling plýtvá šířkou pásma a doručuje zastaralá data
- WebSocket poskytuje obousměrnou, trvalou a efektivní real-time komunikaci
- noex-server přichází s kompletním JSON protokolem, ne jen s holým WebSocket
- GenServer supervision izoluje každé spojení — pády se nešíří
- Protokol řeší CRUD, subscriptions, transakce, auth a chybové kódy bez další práce

---

Další: [Klíčové koncepty](./02-klicove-koncepty.md)
