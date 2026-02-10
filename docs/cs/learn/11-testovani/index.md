# Část 11: Testování

Strategie a helpery pro testování WebSocket serverových aplikací.

## Kapitoly

### [11.1 Nastavení testů](./01-vzory-nastaveni.md)

Nastavení spolehlivého testovacího prostředí:
- `port: 0` pro náhodné přiřazení portu
- `host: '127.0.0.1'` pro lokální binding
- Helpery `sendRequest` a `waitForPush`
- Správný cleanup pomocí `server.stop()` v `afterEach`

### [11.2 Testování subscriptions a auth](./02-testovani-subscriptions-a-auth.md)

Testování složitých scénářů:
- Nastavení subscriptions a vzory `waitForPush`
- `store.settle()` — čekání na přehodnocení dotazu před asercí
- Multi-client testy s auth tokeny
- Pořadí push listenerů: vždy nastavit PŘED mutací, která je spouští

## Co se naučíte

Na konci této sekce budete schopni:
- Nastavit izolovaná, stabilní testovací prostředí
- Psát spolehlivé testy pro subscriptions a push zprávy
- Testovat autentizaci a oprávnění s více klienty

---

Začněte s: [Nastavení testů](./01-vzory-nastaveni.md)
