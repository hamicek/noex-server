# Část 5: Reaktivní subscriptions

Odběr živých výsledků dotazů, které server automaticky pushuje při změně dat.

## Kapitoly

### [5.1 Odběr dotazů](./01-odber-dotazu.md)

Nastavení reaktivních subscriptions:
- Definice dotazů pomocí `store.defineQuery()`
- Přihlášení k odběru zprávou `store.subscribe`
- Přijetí úvodních dat a `subscriptionId`

### [5.2 Push aktualizace](./02-push-aktualizace.md)

Pochopení, jak mutace spouštějí push zprávy:
- Insert/update/delete způsobující přehodnocení
- `store.settle()` a kdy přicházejí push zprávy
- Skalární vs array výsledky dotazů v pushích

### [5.3 Parametrizované dotazy](./03-parametrizovane-dotazy.md)

Předávání parametrů dotazům při přihlášení k odběru:
- Definice dotazů s argumentem `params`
- Přihlášení s polem `params`
- Více klientů s různými parametry na stejném dotazu

### [5.4 Správa subscriptions](./04-sprava-subscriptions.md)

Řízení životního cyklu subscriptions:
- Odhlášení pomocí `store.unsubscribe`
- Limity subscriptions per connection
- Automatický cleanup při odpojení klienta

## Co se naučíte

Na konci této sekce budete schopni:
- Přihlásit se k odběru živých výsledků dotazů přes WebSocket
- Pochopit, kdy a proč přicházejí push zprávy
- Používat parametrizované dotazy pro personalizované datové streamy
- Spravovat životní cyklus subscriptions a cleanup

---

Začněte s: [Odběr dotazů](./01-odber-dotazu.md)
