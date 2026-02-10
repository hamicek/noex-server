# Část 10: Odolnost

Produkční vzory pro rate limiting, monitoring zdraví spojení a správu write bufferu.

## Kapitoly

### [10.1 Rate limiting](./01-rate-limiting.md)

Ochrana serveru před nadměrnými požadavky:
- Algoritmus klouzavého okna
- Error `RATE_LIMITED` s `retryAfterMs`
- Klíč: userId pro autentizované, IP pro anonymní

### [10.2 Heartbeat](./02-heartbeat.md)

Detekce mrtvých spojení:
- Serverem iniciovaný ping/pong protokol
- Konfigurovatelný interval a timeout
- Close code `4001` pro neodpovídající klienty

### [10.3 Backpressure](./03-backpressure.md)

Zpracování pomalých klientů bez vyčerpání paměti:
- `maxBufferedBytes` — limit write bufferu
- `highWaterMark` — pozastavení pushů při procentuálním prahu
- Co se stane s push zprávami, když backpressure nastoupí

## Co se naučíte

Na konci této sekce porozumíte:
- Jak rate limiting chrání před zneužitím
- Jak heartbeat detekuje a uklízí mrtvá spojení
- Jak backpressure předchází vyčerpání paměti od pomalých konzumentů

---

Začněte s: [Rate limiting](./01-rate-limiting.md)
