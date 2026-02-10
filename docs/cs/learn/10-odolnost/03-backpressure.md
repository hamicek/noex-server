# Backpressure

Zpracování pomalých klientů bez vyčerpání paměti. Když write buffer WebSocketu klienta překročí high water mark, push zprávy se tiše zahazují, dokud se buffer nevyprázdní.

## Co se naučíte

- `BackpressureConfig` — `maxBufferedBytes` a `highWaterMark`
- Kdy se backpressure aktivuje — výpočet prahu
- Co se zahazuje (pouze push zprávy) a co není ovlivněno (request/response)
- Proč zahozené push zprávy nezpůsobí ztrátu dat — pouze dočasnou neaktuálnost
- Výchozí konfigurace (1 MB buffer, 80% práh)

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

const store = await Store.start({ name: 'backpressure-demo' });

store.defineBucket('events', {
  key: 'id',
  schema: {
    id:      { type: 'string', generated: 'uuid' },
    payload: { type: 'string', required: true },
  },
});

store.defineQuery('all-events', async (ctx) => ctx.bucket('events').all());

const server = await NoexServer.start({
  store,
  port: 8080,
  backpressure: {
    maxBufferedBytes: 1_048_576,  // 1 MB
    highWaterMark: 0.8,           // 80%
  },
});
```

## BackpressureConfig

```typescript
interface BackpressureConfig {
  readonly maxBufferedBytes: number;  // Celková kapacita bufferu (výchozí: 1_048_576)
  readonly highWaterMark: number;     // Zlomek 0.0–1.0 (výchozí: 0.8)
}
```

- **`maxBufferedBytes`** — maximální velikost write bufferu WebSocketu v bytech
- **`highWaterMark`** — zlomek `maxBufferedBytes`, při kterém se push zprávy začnou zahazovat

**Výchozí hodnoty:**

```typescript
{
  maxBufferedBytes: 1_048_576,  // 1 MB
  highWaterMark: 0.8,           // 80%
}
```

## Výpočet prahu

Backpressure se aktivuje, když:

```
ws.bufferedAmount >= maxBufferedBytes × highWaterMark
```

S výchozími hodnotami:

```
práh = 1_048_576 × 0.8 = 838 861 bytů
```

Když interní write buffer WebSocketu obsahuje 838 861 nebo více bytů čekajících dat, push zprávy se zahazují.

## Co se zahazuje

**Pouze push zprávy** (aktualizace subscriptions) se zahazují během backpressure:

```
                          Buffer < práh          Buffer ≥ práh
                          ─────────────          ─────────────
Request/Response          ✓ Vždy odesláno        ✓ Vždy odesláno
Push (subscription)       ✓ Odesláno normálně    ✗ Tiše zahozeno
Push (rules event)        ✓ Odesláno normálně    ✗ Tiše zahozeno
```

Request/response není nikdy ovlivněn backpressure. Pokud klient pošle `store.get`, vždy dostane odpověď bez ohledu na stav bufferu.

## Proč je zahazování push zpráv bezpečné

Reaktivní subscriptions na dotazy automaticky znovu odešlou data při další změně stavu. Zahození pushe znamená, že klient má dočasně neaktuální data, ne trvale chybná data:

```
Mutace A → push "data = [1, 2, 3]"    ──▶ ZAHOZENO (backpressure)
                                            Klient stále vidí stará data

Mutace B → push "data = [1, 2, 3, 4]" ──▶ Buffer vyprázdněn → ODESLÁNO ✓
                                            Klient dohoní
```

Další mutace, která vyvolá stejnou subscription, odešle kompletní, aktuální výsledek — klient přeskočí mezilehlé stavy, ale vždy konverguje ke správnému finálnímu stavu.

## Jak to funguje interně

Když push zpráva dorazí do ConnectionServer GenServeru:

```
Push zpráva přijata
  │
  ▼
Kontrola: ws.bufferedAmount >= práh?
  │
  ├── Ne  → Odeslat push klientovi
  │
  └── Ano → Zahodit push (žádná chyba, žádná notifikace)
```

Kontrola se provádí při každém pushi. Jakmile buffer klesne pod práh, push zprávy se automaticky obnoví.

## Scénáře backpressure

### Normální provoz (buffer prázdný)

```
Klient je rychlý, buffer zůstává blízko 0

Store mutace → push "data = [A]"   → bufferedAmount: 0    → ODESLÁNO ✓
Store mutace → push "data = [A,B]" → bufferedAmount: 50   → ODESLÁNO ✓
```

### Pomalý klient (buffer se plní)

```
Klient je pomalý, nečte dostatečně rychle

Store mutace → push 1 → bufferedAmount: 200 000  → ODESLÁNO ✓
Store mutace → push 2 → bufferedAmount: 500 000  → ODESLÁNO ✓
Store mutace → push 3 → bufferedAmount: 850 000  → ZAHOZENO ✗ (≥ 838 861)
Store mutace → push 4 → bufferedAmount: 900 000  → ZAHOZENO ✗
                         Klient přečte nějaká data...
Store mutace → push 5 → bufferedAmount: 100 000  → ODESLÁNO ✓ (zpět pod práh)
```

### Vlastní práh

Nastavte `highWaterMark: 1.0` pro zahazování pouze při kompletně plném bufferu:

```typescript
backpressure: {
  maxBufferedBytes: 2_097_152,  // 2 MB
  highWaterMark: 1.0,           // Zahazovat pouze když buffer = 2 MB
}
```

Nebo použijte nižší práh pro agresivnější zahazování:

```typescript
backpressure: {
  maxBufferedBytes: 524_288,  // 512 KB
  highWaterMark: 0.5,         // Začít zahazovat od 256 KB
}
```

## Žádná notifikace klientovi

Když se push zprávy zahazují, klient neobdrží žádnou chybu ani varování. To je záměrné:

- Klient je již pomalý (proto se backpressure aktivoval)
- Odesílání více dat pomalému klientovi by problém zhoršilo
- Další úspěšný push bude obsahovat nejnovější stav

## Srovnání s rate limitingem

| Feature | Rate limiting | Backpressure |
|---------|--------------|--------------|
| **Co omezuje** | Příchozí požadavky | Odchozí push zprávy |
| **Kdy se aktivuje** | Příliš mnoho požadavků za okno | Write buffer WebSocketu plný |
| **Klient vidí** | Chybu `RATE_LIMITED` | Nic (push tiše zahozen) |
| **Ovlivňuje** | Všechny operace | Pouze push zprávy |
| **Obnova** | Čekat `retryAfterMs` | Automatická (buffer se vyprázdní) |

## Funkční příklad

```typescript
const server = await NoexServer.start({
  store,
  port: 8080,
  backpressure: {
    maxBufferedBytes: 1_048_576, // 1 MB
    highWaterMark: 0.8,          // Zahazovat push při 80% bufferu
  },
});

// Klient se přihlásí k all-events
// → { "id": 1, "type": "store.subscribe", "query": "all-events" }
// ← { "id": 1, "type": "result",
//     "data": { "subscriptionId": "sub-1", "initialData": [] } }

// Rychlé mutace vyvolají push aktualizace:
// ← { "type": "push", "channel": "subscription",
//     "subscriptionId": "sub-1", "data": [...] }   ← ODESLÁNO ✓

// Pokud klient nestíhá, buffer roste...
// Push zprávy se začnou zahazovat, když buffer ≥ 838 861 bytů

// Když klient dohoní, push zprávy se automaticky obnoví
// Další push obsahuje nejnovější kompletní stav
```

## Cvičení

Při následující konfiguraci:
```typescript
backpressure: { maxBufferedBytes: 100_000, highWaterMark: 0.5 }
```

1. Jaký je práh, při kterém se push zprávy začnou zahazovat?
2. Klient má `ws.bufferedAmount = 49_999`. Je další push odeslán nebo zahozen?
3. Klient má `ws.bufferedAmount = 50_000`. Je další push odeslán nebo zahozen?
4. Pokud se 3 push zprávy za sebou zahodí a pak se buffer vyprázdní, jaká data klient dostane při dalším pushi?

<details>
<summary>Řešení</summary>

1. **Práh:** `100_000 × 0.5 = 50_000 bytů`

2. **49 999 bytů:** Push je **odeslán** ✓
   `49_999 < 50_000` → pod prahem

3. **50 000 bytů:** Push je **zahozen** ✗
   `50_000 >= 50_000` → na nebo nad prahem

4. **Po vyprázdnění bufferu:** Klient obdrží **nejnovější kompletní výsledek** z reaktivního dotazu — ne 3 zmeškaných mezilehlých stavů. Reaktivní dotazy vždy posílají celý aktuální stav, takže klient dohoní v jednom pushi. Žádná data se trvale neztratí.

</details>

## Shrnutí

- Backpressure monitoruje `ws.bufferedAmount` proti `maxBufferedBytes × highWaterMark`
- Výchozí: 1 MB buffer, 80% práh (838 861 bytů)
- Zahazují se pouze push zprávy (subscriptions a eventy) — request/response není nikdy ovlivněn
- Zahozené push zprávy jsou tiché — klientovi se neposílá žádná chyba
- Reaktivní dotazy přirozeně znovu odešlou při další mutaci — klient konverguje ke správnému stavu
- Žádná trvalá ztráta dat — pouze dočasná neaktuálnost během backpressure
- Obnova je automatická — když se buffer vyprázdní, push zprávy se obnoví

---

Další: [Nastavení testů](../11-testovani/01-nastaveni-testu.md)
