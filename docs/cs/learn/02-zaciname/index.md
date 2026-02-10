# Část 2: Začínáme

Nastavte si první noex-server, připojte WebSocket klienta a prozkoumejte možnosti konfigurace.

## Kapitoly

### [2.1 Váš první server](./01-prvni-server.md)

Rozběhněte server za méně než minutu:
- Instalace `@hamicek/noex-server` a peer dependencies
- Vytvoření Store s buckety a dotazy
- Spuštění serveru pomocí `NoexServer.start()`

### [2.2 Připojení klienta](./02-pripojeni-klienta.md)

Připojte se z libovolného WebSocket klienta a odešlete první požadavek:
- Otevření WebSocket spojení
- Přijetí `welcome` zprávy
- Sestavení `sendRequest` helperu pro korelaci request/response

### [2.3 Konfigurace](./03-konfigurace.md)

Porozumění každému konfiguračnímu poli:
- `ServerConfig` rozhraní s výchozími hodnotami
- Port, host, path, limity payloadu
- Feature přepínače: auth, rate limiting, heartbeat, backpressure

## Co se naučíte

Na konci této sekce budete schopni:
- Spustit noex-server s nakonfigurovaným Store
- Připojit WebSocket klienta a vyměňovat si JSON zprávy
- Přizpůsobit chování serveru pomocí konfigurace

---

Začněte s: [Váš první server](./01-prvni-server.md)
