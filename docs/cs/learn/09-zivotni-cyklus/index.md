# Část 9: Životní cyklus připojení

Pochopení vnitřní architektury serveru — jak jsou spojení supervizovaná, sledovaná a ukončovaná.

## Kapitoly

### [9.1 Architektura](./01-architektura.md)

Jak je server vnitřně strukturovaný:
- GenServer per WebSocket spojení
- `ConnectionSupervisor` se strategií `simple_one_for_one`
- Dočasná restart strategie — spadlá spojení se uklidí, nerestartují

### [9.2 Registr spojení](./02-registr.md)

Inspekce aktivních spojení:
- `server.getConnections()` — per-connection metadata
- `server.getStats()` — agregované statistiky serveru
- `server.connectionCount` a `server.isRunning`

### [9.3 Elegantní ukončení](./03-elegantni-ukonceni.md)

Čisté zastavení serveru:
- `server.stop({ gracePeriodMs })` — notifikace klientů a čekání
- Systémová zpráva o ukončení odeslaná všem spojením
- Cleanup subscriptions a sekvence zavření spojení

## Co se naučíte

Na konci této sekce porozumíte:
- Jak GenServer supervize dělá každé spojení nezávislým a odolným vůči chybám
- Jak prohlížet spojení a stav serveru za běhu
- Jak funguje elegantní ukončení s notifikací klientů

---

Začněte s: [Architektura](./01-architektura.md)
