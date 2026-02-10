# Klíčové koncepty

Než se ponoříme do kódu, pojďme si ujasnit slovník a mentální model noex-server. Každý koncept zde přímo odpovídá něčemu, co budete v protokolu používat.

## Co se naučíte

- Čtyři kategorie zpráv: request, response, push, system
- Jak funguje korelace request/response přes pole `id`
- Co jsou push kanály a jak se liší od odpovědí
- Kompletní životní cyklus spojení od připojení po ukončení
- Slovníček pojmů používaných v celé dokumentaci

## Model protokolu

noex-server používá JSON-over-WebSocket protokol. Každá zpráva je JSON objekt odeslaný jako WebSocket textový frame. Protokol definuje čtyři kategorie:

```text
┌─────────────────────────────────────────────────────────────────┐
│                    MESSAGE CATEGORIES                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  REQUEST     Client → Server                                    │
│  ──────────────────────────────────                             │
│  { id: 1, type: "store.insert", bucket: "users", data: {...} }  │
│                                                                 │
│  RESPONSE    Server → Client (correlated by id)                 │
│  ──────────────────────────────────                             │
│  { id: 1, type: "result", data: {...} }                         │
│  { id: 1, type: "error", code: "VALIDATION_ERROR", ... }        │
│                                                                 │
│  PUSH        Server → Client (no id, async)                     │
│  ──────────────────────────────────                             │
│  { type: "push", channel: "subscription", subscriptionId, data }│
│  { type: "push", channel: "event", subscriptionId, data }       │
│                                                                 │
│  SYSTEM      Server → Client (control messages)                 │
│  ──────────────────────────────────                             │
│  { type: "welcome", version: "1.0.0", ... }                     │
│  { type: "ping", timestamp: ... }                               │
│  { type: "system", event: "shutdown", ... }                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Korelace request/response

Každý request obsahuje číselné pole `id`. Server toto `id` vrátí v odpovědi. Díky tomu klient přiřadí odpovědi ke správným requestům, i když jich má současně rozpracovaných více:

```text
Client                              Server
  │                                   │
  │── { id: 1, type: "store.get" } ──►│
  │── { id: 2, type: "store.all" } ──►│   ← Two requests in flight
  │                                   │
  │◄── { id: 2, type: "result" } ─────│   ← Response to id:2 arrives first
  │◄── { id: 1, type: "result" } ─────│   ← Response to id:1 arrives second
```

### Push kanály

Push zprávy iniciuje server — nekorelují s žádným requestem. Přicházejí na pojmenovaných kanálech:

| Kanál | Zdroj | Kdy |
|---------|--------|------|
| `subscription` | Reaktivní dotazy ve Store | Změna dat, která ovlivní odebíraný dotaz |
| `event` | Rules engine | Pravidlo se vyhodnotí a vygeneruje událost odpovídající odebíranému vzoru |

Každá push zpráva nese `subscriptionId`, takže klient ví, ke které subscription patří.

## Jmenné prostory operací

Operace se směrují podle prefixu:

| Prefix | Účel | Příklady |
|--------|---------|----------|
| `store.*` | Store CRUD, dotazy, subscriptions, transakce | `store.insert`, `store.where`, `store.subscribe` |
| `rules.*` | Rules engine události, fakta, subscriptions | `rules.emit`, `rules.setFact`, `rules.subscribe` |
| `auth.*` | Autentizace a správa sessions | `auth.login`, `auth.logout`, `auth.whoami` |

## Životní cyklus spojení

```text
 1. CONNECT
    Client opens WebSocket to ws://host:port/

 2. WELCOME
    Server sends: { type: "welcome", version: "1.0.0",
                    requiresAuth: true/false, serverTime: ... }

 3. AUTH (if requiresAuth is true)
    Client sends:  { id: 1, type: "auth.login", token: "..." }
    Server sends:  { id: 1, type: "result", data: { userId, roles } }

 4. OPERATIONS
    Client sends requests, server responds with results/errors.
    Server pushes subscription/event updates asynchronously.

 5. HEARTBEAT (ongoing)
    Server sends: { type: "ping", timestamp: ... }
    Client sends: { type: "pong", timestamp: ... }
    If no pong within timeout → server closes with code 4001.

 6. CLOSE
    Either side closes the WebSocket.
    Server cleans up: unsubscribes all subscriptions, removes from registry.
```

## Model chyb

Každá chybová odpověď obsahuje kód (`code`) z pevné sady 15 kódů:

| Kód | Význam |
|------|---------|
| `PARSE_ERROR` | Nevalidní JSON |
| `INVALID_REQUEST` | Chybí `id` nebo `type` |
| `UNKNOWN_OPERATION` | Nepodporovaný typ operace |
| `VALIDATION_ERROR` | Chybějící nebo neplatná pole v requestu |
| `NOT_FOUND` | Záznam nebo subscription nenalezena |
| `ALREADY_EXISTS` | Porušení unikátního klíče |
| `CONFLICT` | Konflikt verzí v transakci |
| `UNAUTHORIZED` | Neautentizováno |
| `FORBIDDEN` | Nedostatečná oprávnění |
| `RATE_LIMITED` | Příliš mnoho requestů |
| `BACKPRESSURE` | Zápis do bufferu serveru je plný |
| `INTERNAL_ERROR` | Neočekávaná chyba serveru |
| `BUCKET_NOT_DEFINED` | Neznámý název bucketu |
| `QUERY_NOT_DEFINED` | Neznámý název reaktivního dotazu |
| `RULES_NOT_AVAILABLE` | Rules engine není nakonfigurován |

## Přehled architektury

```text
┌───────────────────────────────────────────────────┐
│                   NoexServer                      │
│                                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │       ConnectionSupervisor                   │ │
│  │       (simple_one_for_one, temporary)        │ │
│  │                                              │ │
│  │  ┌───────────────┐  ┌───────────────┐        │ │
│  │  │ Connection #1 │  │ Connection #2 │   ...  │ │
│  │  │  (GenServer)  │  │  (GenServer)  │        │ │
│  │  │  ┌───────────┐│  │  ┌───────────┐│        │ │
│  │  │  │ WebSocket ││  │  │ WebSocket ││        │ │
│  │  │  │ Auth      ││  │  │ Auth      ││        │ │
│  │  │  │ Rate Limit││  │  │ Rate Limit││        │ │
│  │  │  │ Subs[]    ││  │  │ Subs[]    ││        │ │
│  │  │  └───────────┘│  │  └───────────┘│        │ │
│  │  └───────────────┘  └───────────────┘        │ │
│  └──────────────────────────────────────────────┘ │
│                                                   │
│  ┌─────────────┐  ┌────────────┐                  │
│  │    Store    │  │   Rules    │  (optional)      │
│  └─────────────┘  └────────────┘                  │
└───────────────────────────────────────────────────┘
```

Každé spojení je GenServer, který vlastní:
- Referenci na WebSocket
- Stav autentizační session
- Klíč pro rate limiter
- Seznam aktivních subscription ID

Když se WebSocket zavře (nebo GenServer spadne), veškerý stav se automaticky uklidí.

## Slovníček

| Pojem | Definice |
|------|-----------|
| **Bucket** | Pojmenovaná kolekce záznamů ve store, definovaná schématem |
| **Connection** | Jediná WebSocket session spravovaná dedikovaným GenServer procesem |
| **GenServer** | Proces podobný aktoru, který drží stav a zpracovává zprávy sekvenčně |
| **Push** | Serverem iniciovaná zpráva doručená klientovi bez předchozího requestu |
| **Reaktivní dotaz** | Pojmenovaný dotaz definovaný na store, ke kterému se lze přihlásit; výsledky se pushují při změně dat |
| **Subscription** | Registrace klienta k odběru push aktualizací pro reaktivní dotaz nebo rules vzor |
| **Supervisor** | Proces, který monitoruje potomky a řeší jejich selhání (úklid, restart) |

## Cvičení

Na základě následující sekvence WebSocket zpráv určete kategorii každé zprávy (request, response, push nebo system) a vysvětlete, co se stalo:

```jsonc
← { "type": "welcome", "version": "1.0.0", "requiresAuth": false, "serverTime": 1706745600000 }
→ { "id": 1, "type": "store.insert", "bucket": "notes", "data": { "text": "Hello" } }
← { "id": 1, "type": "result", "data": { "id": "n1", "text": "Hello", "_version": 1 } }
→ { "id": 2, "type": "store.subscribe", "query": "all-notes" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-1" } }
← { "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [{ "id": "n1", "text": "Hello" }] }
← { "type": "ping", "timestamp": 1706745630000 }
→ { "type": "pong", "timestamp": 1706745630000 }
```

<details>
<summary>Řešení</summary>

1. **System (welcome)** — server pozdraví klienta s verzí protokolu a informací o požadavcích na autentizaci
2. **Request** — klient vkládá záznam do bucketu `notes`
3. **Response** — server potvrzuje vložení, vrací záznam s vygenerovaným `id` a `_version`
4. **Request** — klient se přihlašuje k odběru reaktivního dotazu `all-notes`
5. **Response** — server potvrzuje subscription, vrací `subscriptionId`
6. **Push** — server pushuje aktuální výsledek dotazu (právě vloženou poznámku) na kanálu `subscription`
7. **System (ping)** — server kontroluje, zda je klient naživu
8. **Request (pong)** — klient odpovídá na ping

Poznámka: push na řádku 6 přichází asynchronně — jde o počáteční výsledek odebíraného dotazu, nikoli o odpověď na jakýkoli request.

</details>

## Shrnutí

- Protokol má čtyři kategorie zpráv: request, response, push a system
- Korelace request/response používá pole `id`
- Push zprávy přicházejí na pojmenovaných kanálech (`subscription`, `event`) se `subscriptionId`
- Operace jsou rozčleněny do jmenných prostorů: `store.*`, `rules.*`, `auth.*`
- Životní cyklus spojení: connect -> welcome -> auth -> operations -> heartbeat -> close
- Každé spojení je GenServer s izolovaným stavem a automatickým úklidem
- 15 typovaných chybových kódů pokrývá každý režim selhání

---

Další: [Váš první server](../02-zaciname/01-prvni-server.md)
