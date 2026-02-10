# Část 4: Store CRUD operace

Práce se záznamy přes WebSocket protokol — vkládání, čtení, aktualizace, mazání, dotazy a agregace.

## Kapitoly

### [4.1 Základní CRUD](./01-zakladni-crud.md)

Základní životní cyklus záznamu:
- `store.insert` — vytvoření nových záznamů s validací schématu
- `store.get` — načtení podle primárního klíče
- `store.update` — úprava existujících záznamů se sledováním verzí
- `store.delete` — smazání záznamů

### [4.2 Dotazy a filtrování](./02-dotazy-a-filtrovani.md)

Vyhledávání záznamů odpovídajících kritériím:
- `store.all` — načtení všech záznamů z bucketu
- `store.where` — filtrování s podmínkami
- `store.findOne` — získání první shody
- `store.count` — počet odpovídajících záznamů

### [4.3 Stránkování a agregace](./03-strankovani-a-agregace.md)

Práce s velkými datasety a výpočetními hodnotami:
- `store.first` / `store.last` — N záznamů od začátku nebo konce
- `store.paginate` — cursor-based stránkování
- `store.sum` / `store.avg` / `store.min` / `store.max` — numerické agregace

### [4.4 Metadata a statistiky](./04-metadata-a-statistiky.md)

Inspekce a správa store:
- `store.buckets` — výpis definovaných bucketů
- `store.stats` — statistiky store
- `store.clear` — smazání všech záznamů z bucketu

## Co se naučíte

Na konci této sekce budete schopni:
- Provádět kompletní CRUD operace přes WebSocket
- Dotazovat a filtrovat záznamy s různými operátory
- Stránkovat přes velké sady výsledků
- Počítat agregace a prohlížet metadata store

---

Začněte s: [Základní CRUD](./01-zakladni-crud.md)
