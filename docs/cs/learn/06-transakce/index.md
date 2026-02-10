# Část 6: Store transakce

Provádění více store operací atomicky — všechny uspějí, nebo všechny selžou.

## Kapitoly

### [6.1 Atomické operace](./01-atomicke-operace.md)

Jak transakce fungují:
- Zpráva `store.transaction` s polem operací
- Podporované ops: get, insert, update, delete, where, findOne, count
- Sémantika vše-nebo-nic
- Pole výsledků odpovídající pořadí operací

### [6.2 Transakční vzory](./02-transakcni-vzory.md)

Běžné vzory pro reálné použití:
- Cross-bucket operace (např. převod mezi účty)
- Read-modify-write v rámci jedné transakce
- Zpracování chyb a obnova při version konfliktu

## Co se naučíte

Na konci této sekce budete schopni:
- Provádět atomické multi-operační transakce přes WebSocket
- Aplikovat cross-bucket transakční vzory
- Zpracovat konflikty a chyby v transakcích

---

Začněte s: [Atomické operace](./01-atomicke-operace.md)
