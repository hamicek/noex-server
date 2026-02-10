# Část 1: Úvod

Tato sekce vysvětluje, proč WebSocket server existuje, a představuje základní koncepty, které budete používat v celém frameworku.

## Kapitoly

### [1.1 Proč WebSocket server?](./01-proc-websocket-server.md)

Dozvíte se, proč je dedikovaný WebSocket server smysluplný pro real-time aplikace:
- REST polling vs WebSocket push — srovnání latence a efektivity
- Důvody pro protocol-first server s vestavěným routingem
- Jak GenServer supervize zajišťuje spolehlivost per connection

### [1.2 Klíčové koncepty](./02-klicove-koncepty.md)

Přehled základních stavebních bloků:
- **Protokol** - JSON-over-WebSocket, verze 1.0.0
- **Request/Response** - Korelované zprávy přes pole `id`
- **Push** - Serverem iniciované zprávy na subscription a event kanálech
- **Životní cyklus spojení** - Welcome, auth, operace, heartbeat, close
- **Slovník pojmů** - Klíčové termíny používané v dokumentaci

## Co se naučíte

Na konci této sekce porozumíte:
- Proč je WebSocket push lepší než REST polling pro real-time data
- Jak noex-server protokol strukturuje komunikaci
- Co dělá každá vrstva serveru
- Životní cyklus spojení od připojení po odpojení

---

Začněte s: [Proč WebSocket server?](./01-proc-websocket-server.md)
