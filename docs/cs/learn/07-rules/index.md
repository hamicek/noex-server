# Část 7: Integrace rules

Připojení noex-rules enginu k serveru a použití eventů, faktů a rules subscriptions přes WebSocket.

## Kapitoly

### [7.1 Nastavení](./01-nastaveni.md)

Aktivace rules enginu na serveru:
- Instalace `@hamicek/noex-rules`
- Předání enginu do `NoexServer.start({ rules })`
- Co se stane, když rules nejsou nakonfigurované (`RULES_NOT_AVAILABLE`)

### [7.2 Eventy a fakta](./02-eventy-a-fakta.md)

Práce s eventy a fakty přes protokol:
- `rules.emit` — emitování eventů do enginu
- `rules.setFact` / `rules.getFact` / `rules.deleteFact` — CRUD faktů
- `rules.queryFacts` / `rules.getAllFacts` — dotazy na fakta s patterny

### [7.3 Rules subscriptions](./03-rules-subscriptions.md)

Odběr shod rules enginu:
- `rules.subscribe` s patternem
- Push zprávy na kanálu `event`
- `rules.unsubscribe` a cleanup

## Co se naučíte

Na konci této sekce budete schopni:
- Připojit noex-rules engine k serveru
- Emitovat eventy a spravovat fakta přes WebSocket
- Přihlásit se k odběru shod rules enginu a přijímat push aktualizace

---

Začněte s: [Nastavení](./01-nastaveni.md)
