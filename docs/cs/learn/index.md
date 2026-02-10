# Naučte se noex-server

Komplexní příručka pro Node.js vývojáře, kteří chtějí stavět real-time aplikace s WebSocket serverem. Tato příručka vás provede protokolem, operacemi nad store, reaktivními subscriptions a produkčními vzory — vše postavené na GenServer supervizi.

## Pro koho je tato příručka?

- Node.js / TypeScript vývojáři (intermediate+)
- Znáte async/await a základní WebSocket koncepty
- Znalost [@hamicek/noex-store](https://github.com/hamicek/noex-store) pomůže, ale není nutná
- Chcete strukturovaný WebSocket server s CRUD, subscriptions, transakcemi a autentizací

## Cesta učení

### Část 1: Úvod

Pochopte, proč WebSocket server a jaké problémy řeší.

| Kapitola | Popis |
|----------|-------|
| [1.1 Proč WebSocket server?](./01-uvod/01-proc-websocket-server.md) | Srovnání s REST, real-time push a důvody pro protocol-first server |
| [1.2 Klíčové koncepty](./01-uvod/02-klicove-koncepty.md) | Protokol, model request/response/push, životní cyklus spojení, slovník pojmů |

### Část 2: Začínáme

Nastavte si první server a připojte klienta.

| Kapitola | Popis |
|----------|-------|
| [2.1 Váš první server](./02-zaciname/01-prvni-server.md) | Instalace, vytvoření Store, `NoexServer.start()`, ServerConfig |
| [2.2 Připojení klienta](./02-zaciname/02-pripojeni-klienta.md) | WebSocket klient, welcome zpráva, sendRequest helper |
| [2.3 Konfigurace](./02-zaciname/03-konfigurace.md) | Všechna pole ServerConfig s výchozími hodnotami |

### Část 3: Protokol

Zvládněte JSON-over-WebSocket protokol.

| Kapitola | Popis |
|----------|-------|
| [3.1 Formát zpráv](./03-protokol/01-format-zprav.md) | JSON-over-WebSocket, typy zpráv, verze protokolu |
| [3.2 Požadavek a odpověď](./03-protokol/02-pozadavek-a-odpoved.md) | Korelace přes `id`, routing `store.*`/`rules.*`/`auth.*` |
| [3.3 Push zprávy](./03-protokol/03-push-zpravy.md) | Push kanály (subscription, event), subscriptionId |
| [3.4 Zpracování chyb](./03-protokol/04-zpracovani-chyb.md) | Všech 15 error kódů s recovery akcemi |

### Část 4: Store CRUD operace

Práce se záznamy přes WebSocket protokol.

| Kapitola | Popis |
|----------|-------|
| [4.1 Základní CRUD](./04-store-crud/01-zakladni-crud.md) | insert, get, update, delete lifecycle |
| [4.2 Dotazy a filtrování](./04-store-crud/02-dotazy-a-filtrovani.md) | all, where, findOne, count |
| [4.3 Stránkování a agregace](./04-store-crud/03-strankovani-a-agregace.md) | first, last, paginate, sum/avg/min/max |
| [4.4 Metadata a statistiky](./04-store-crud/04-metadata-a-statistiky.md) | buckets, stats, clear |

### Část 5: Reaktivní subscriptions

Odběr živých výsledků dotazů pushovaných serverem.

| Kapitola | Popis |
|----------|-------|
| [5.1 Odběr dotazů](./05-subscriptions/01-odber-dotazu.md) | defineQuery, store.subscribe, úvodní data |
| [5.2 Push aktualizace](./05-subscriptions/02-push-aktualizace.md) | Mutace spouštějící push, settle(), skalár vs pole |
| [5.3 Parametrizované dotazy](./05-subscriptions/03-parametrizovane-dotazy.md) | Dotazy s parametry |
| [5.4 Správa subscriptions](./05-subscriptions/04-sprava-subscriptions.md) | unsubscribe, limity, cleanup při odpojení |

### Část 6: Store transakce

Provádění více operací atomicky.

| Kapitola | Popis |
|----------|-------|
| [6.1 Atomické operace](./06-transakce/01-atomicke-operace.md) | store.transaction, pole operací, vše-nebo-nic |
| [6.2 Transakční vzory](./06-transakce/02-transakcni-vzory.md) | Cross-bucket, read-modify-write, zpracování chyb |

### Část 7: Integrace rules

Připojení noex-rules enginu k serveru.

| Kapitola | Popis |
|----------|-------|
| [7.1 Nastavení](./07-rules/01-nastaveni.md) | Instalace noex-rules, `NoexServer.start({ rules })` |
| [7.2 Eventy a fakta](./07-rules/02-eventy-a-fakta.md) | emit, setFact, getFact, deleteFact, queryFacts |
| [7.3 Rules subscriptions](./07-rules/03-rules-subscriptions.md) | subscribe s pattern, event push kanál |

### Část 8: Autentizace

Zabezpečení serveru pomocí token-based auth a oprávnění.

| Kapitola | Popis |
|----------|-------|
| [8.1 Autentizace tokenem](./08-autentizace/01-autentizace-tokenem.md) | AuthConfig, validate, auth.login flow |
| [8.2 Oprávnění](./08-autentizace/02-opravneni.md) | PermissionConfig.check, FORBIDDEN, přístup dle rolí |
| [8.3 Životní cyklus session](./08-autentizace/03-zivotni-cyklus-session.md) | whoami, logout, expirace, re-auth |

### Část 9: Životní cyklus připojení

Pochopení vnitřní architektury serveru.

| Kapitola | Popis |
|----------|-------|
| [9.1 Architektura](./09-zivotni-cyklus/01-architektura.md) | GenServer per WebSocket, ConnectionSupervisor strom |
| [9.2 Registr spojení](./09-zivotni-cyklus/02-registr.md) | ConnectionInfo, getConnections, stats |
| [9.3 Elegantní ukončení](./09-zivotni-cyklus/03-elegantni-ukonceni.md) | server.stop(), sekvence ukončení, systémová zpráva |

### Část 10: Odolnost

Produkční vzory pro spolehlivost.

| Kapitola | Popis |
|----------|-------|
| [10.1 Rate limiting](./10-odolnost/01-rate-limiting.md) | Klouzavé okno, RATE_LIMITED, retryAfterMs |
| [10.2 Heartbeat](./10-odolnost/02-heartbeat.md) | Ping/pong, timeout, close code 4001 |
| [10.3 Backpressure](./10-odolnost/03-backpressure.md) | maxBufferedBytes, highWaterMark, zahozené pushe |

### Část 11: Testování

Strategie testování WebSocket serverů.

| Kapitola | Popis |
|----------|-------|
| [11.1 Nastavení testů](./11-testovani/01-vzory-nastaveni.md) | port:0, helpery, cleanup, Vitest |
| [11.2 Testování subscriptions a auth](./11-testovani/02-testovani-subscriptions-a-auth.md) | waitForPush, settle(), multi-client testy |

### Část 12: Projekty

Aplikujte vše v reálných projektech.

| Kapitola | Popis |
|----------|-------|
| [12.1 Dashboard v reálném čase](./12-projekty/01-dashboard-v-realnem-case.md) | Živé metriky, reaktivní dotazy, oprávnění |
| [12.2 Chatovací aplikace](./12-projekty/02-chatovaci-aplikace.md) | Store + rules, multi-client push, transakce |
| [12.3 E-commerce backend](./12-projekty/03-ecommerce-backend.md) | Všechny features dohromady, produkční konfigurace |

## Formát kapitol

Každá kapitola obsahuje:

1. **Co se naučíte** - Klíčové poznatky předem
2. **Teorie** - Vysvětlení konceptu s diagramy a srovnávacími tabulkami
3. **Funkční příklady** - Kompletní spustitelný kód (server setup + WebSocket JSON zprávy)
4. **Cvičení** - Praktický úkol s řešením
5. **Shrnutí** - Klíčové poznatky
6. **Další kroky** - Odkaz na další kapitolu

---

Připraveni začít? Začněte s [Proč WebSocket server?](./01-uvod/01-proc-websocket-server.md)
