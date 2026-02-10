# Část 3: Protokol

Zvládněte JSON-over-WebSocket protokol, který pohání veškerou komunikaci mezi klienty a serverem.

## Kapitoly

### [3.1 Formát zpráv](./01-format-zprav.md)

Pochopte strukturu každé zprávy:
- JSON textové rámce přes WebSocket
- Verze protokolu 1.0.0
- Čtyři kategorie zpráv: request, response, push, system

### [3.2 Požadavek a odpověď](./02-pozadavek-a-odpoved.md)

Naučte se, jak funguje korelace request/response:
- Pole `id` pro párování odpovědí s požadavky
- Routing operací: `store.*`, `rules.*`, `auth.*`
- Result vs error odpovědi

### [3.3 Push zprávy](./03-push-zpravy.md)

Pochopte serverem iniciované zprávy:
- Kanál `subscription` pro aktualizace store dotazů
- Kanál `event` pro shody rules enginu
- `subscriptionId` pro demultiplexování pushů

### [3.4 Zpracování chyb](./04-zpracovani-chyb.md)

Zvládněte každou chybu, kterou server může vrátit:
- Všech 15 error kódů s popisy
- Strategie obnovy pro každou chybu
- Vzory pro zpracování chyb na straně klienta

## Co se naučíte

Na konci této sekce porozumíte:
- Jak je každá zpráva strukturovaná a směrovaná
- Jak korelovat požadavky s odpověďmi pomocí `id`
- Jak přicházejí push zprávy a jak je demultiplexovat
- Jak zpracovat každý error kód, který server může vrátit

---

Začněte s: [Formát zpráv](./01-format-zprav.md)
