# Nastavení testů

Nastavte spolehlivé, izolované testovací prostředí pro noex-server pomocí Vitest a balíčku `ws`. Každý test dostane vlastní Store, server a WebSocket připojení — žádný sdílený stav, žádné kolize portů, žádné nestabilní testy.

## Co se naučíte

- `port: 0` a `host: '127.0.0.1'` — OS přidělí náhodný port na loopbacku
- Pomocné funkce: `connectClient`, `sendRequest`, `closeClient`, `flush`
- Životní cyklus `beforeEach` / `afterEach` pro čistou izolaci
- Konfigurace Vitest pro integrační testy noex-serveru
- Časté chyby a jak se jim vyhnout

## Prerekvizity

Nainstalujte testovací závislosti:

```bash
npm install -D vitest ws @types/ws
```

## Konfigurace Vitest

Vytvořte `vitest.config.ts` v kořeni projektu:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
```

- **`globals: false`** — explicitní importy (`describe`, `it`, `expect`) zabraňují kolizím názvů
- **`environment: 'node'`** — WebSocket a síťové API vyžadují reálné Node.js prostředí
- **`testTimeout: 10_000`** — WebSocket testy zahrnují skutečné I/O; 10 sekund zabraňuje falešným timeoutům

## Port 0 a loopback binding

Nejdůležitější vzor pro stabilní testy serveru: **navázat na náhodný port na loopbacku**.

```typescript
const server = await NoexServer.start({
  store,
  port: 0,            // OS přidělí volný port
  host: '127.0.0.1',  // Pouze loopback — žádné vystavení do sítě
});

// Přečtení skutečného přiděleného portu
console.log(server.port); // např. 54321
```

Proč je to důležité:

| Problém | Řešení |
|---------|--------|
| Kolize portů při paralelních testech | `port: 0` — každý test dostane unikátní port |
| Dialogy firewallu na macOS | `host: '127.0.0.1'` — nikdy se neváže na externí rozhraní |
| Omezení CI prostředí | Loopback je vždy dostupný, nepotřebuje oprávnění |

## Pomocné funkce

Každý soubor s integračními testy potřebuje malou sadu helperů. Definují se přímo v každém testovacím souboru — žádný sdílený modul není potřeba.

### connectClient

Otevře WebSocket spojení a čeká na welcome zprávu:

```typescript
import { WebSocket } from 'ws';

function connectClient(
  port: number,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
  });
}
```

Server posílá `welcome` zprávu okamžitě po připojení. `connectClient` se resolvne až po jejím přijetí, takže připojení je plně navázané.

### sendRequest

Odešle požadavek a čeká na korelovanou odpověď:

```typescript
let requestIdCounter = 1;

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}
```

Klíčové detaily:
- Automaticky inkrementuje `id` pro zajištění unikátní korelace
- **Ignoruje push zprávy** — resolvne se pouze když uvidí své vlastní `id` v odpovědi
- V `beforeEach` je nutné resetovat `requestIdCounter = 1` pro předvídatelné chování

### closeClient

Elegantně uzavře WebSocket spojení:

```typescript
function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}
```

### flush

Počká na dokončení asynchronního zpracování na straně serveru:

```typescript
function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Použijte `flush()` po operacích, kde server potřebuje čas na aktualizaci interního stavu (např. počet spojení po odpojení). Není potřeba po `sendRequest` — ten sám o sobě čeká na odpověď.

## Životní cyklus testů

Vzor `beforeEach` / `afterEach` zajišťuje úplnou izolaci mezi testy:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

describe('Moje feature', () => {
  let server: NoexServer;
  let store: Store;
  let ws: WebSocket;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  beforeEach(async () => {
    requestIdCounter = 1;

    // Čistý store pro každý test — unikátní jméno zabraňuje kolizím
    store = await Store.start({ name: `test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

    const conn = await connectClient(server.port);
    ws = conn.ws;
    clients.push(ws);
  });

  afterEach(async () => {
    // Uzavření všech klientských spojení
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) {
        c.close();
      }
    }
    clients.length = 0;

    // Zastavení serveru
    if (server?.isRunning) {
      await server.stop();
    }

    // Zastavení store
    if (store) {
      await store.stop();
    }
  });

  it('vloží a přečte záznam', async () => {
    const insertResp = await sendRequest(ws, {
      type: 'store.insert',
      bucket: 'users',
      data: { name: 'Alice' },
    });
    expect(insertResp['type']).toBe('result');

    const inserted = insertResp['data'] as Record<string, unknown>;

    const getResp = await sendRequest(ws, {
      type: 'store.get',
      bucket: 'users',
      key: inserted['id'],
    });

    expect(getResp['type']).toBe('result');
    const data = getResp['data'] as Record<string, unknown>;
    expect(data['name']).toBe('Alice');
  });
});
```

### Proč sledovat klienty v poli?

Testy vytvářející více spojení musí všechny uklidit. Každý WebSocket se přidá do `clients[]` a v `afterEach` se projdou:

```typescript
it('zvládá více spojení', async () => {
  const c2 = await connectClient(server.port);
  clients.push(c2.ws); // Sledování pro cleanup

  const c3 = await connectClient(server.port);
  clients.push(c3.ws); // Sledování pro cleanup

  // Testovací logika...
});
```

### Pořadí cleanup

Pořadí úklidu je důležité:

```
1. Uzavřít všechny WebSocket klienty
2. Zastavit server (server.stop())
3. Zastavit store (store.stop())
```

Uzavření klientů jako první zabraňuje chybám „connection reset". Zastavení serveru před store zajistí, že žádné operace nejsou v letu.

## Kompletní šablona testovacího souboru

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

// ── Helpery ──────────────────────────────────────────────────────

let requestIdCounter = 1;

function connectClient(
  port: number,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
  });
}

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Testy ────────────────────────────────────────────────────────

describe('Moje feature', () => {
  let server: NoexServer;
  let store: Store;
  let ws: WebSocket;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  beforeEach(async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: `test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });

    server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });
    const conn = await connectClient(server.port);
    ws = conn.ws;
    clients.push(ws);
  });

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) c.close();
    }
    clients.length = 0;
    if (server?.isRunning) await server.stop();
    if (store) await store.stop();
  });

  it('funguje', async () => {
    const resp = await sendRequest(ws, {
      type: 'store.all',
      bucket: 'users',
    });
    expect(resp['type']).toBe('result');
    expect(resp['data']).toEqual([]);
  });
});
```

## Testování chybových odpovědí

Chybové odpovědi mají konzistentní strukturu. Testujte jak `type`, tak `code`:

```typescript
it('vrací BUCKET_NOT_DEFINED pro neznámý bucket', async () => {
  const resp = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'nonexistent',
  });

  expect(resp['type']).toBe('error');
  expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
});
```

Pro chyby na úrovni protokolu (neplatný JSON, chybějící `id`) použijte `collectMessages` místo `sendRequest`, protože není žádné `id` pro korelaci:

```typescript
function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      msgs.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

it('odpoví PARSE_ERROR na neplatný JSON', async () => {
  const response = collectMessages(ws, 1);
  ws.send('not valid json{{{');
  const [msg] = await response;

  expect(msg!['type']).toBe('error');
  expect(msg!['code']).toBe('PARSE_ERROR');
});
```

## Testování multi-client scénářů

Další klienty připojujte přímo v jednotlivých testech:

```typescript
it('data vložená jedním klientem jsou viditelná druhému', async () => {
  // ws je již připojený z beforeEach

  // Připojení druhého klienta
  const conn2 = await connectClient(server.port);
  const ws2 = conn2.ws;
  clients.push(ws2); // Sledování pro cleanup

  // Klient 1 vkládá
  const insertResp = await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Alice' },
  });
  const inserted = insertResp['data'] as Record<string, unknown>;

  // Klient 2 čte — vidí stejná data
  const getResp = await sendRequest(ws2, {
    type: 'store.get',
    bucket: 'users',
    key: inserted['id'],
  });

  const data = getResp['data'] as Record<string, unknown>;
  expect(data['name']).toBe('Alice');
});
```

## Časté chyby

| Chyba | Řešení |
|-------|--------|
| Pevně zadaný port (např. `port: 3000`) | Použijte `port: 0` — pevné porty kolidují při paralelním běhu testů |
| Neresetování `requestIdCounter` | Přidejte `requestIdCounter = 1` do `beforeEach` |
| Zapomenuté `clients.push(ws)` | Každé nové spojení musí být sledováno pro cleanup |
| Aserce na počet spojení bez `flush()` | Server aktualizuje počty asynchronně — nejprve `await flush()` |
| Nezastavení store v `afterEach` | Neuklizené store se hromadí a zpomalují testy |

## Cvičení

Napište test, který:
1. Spustí nový Store a Server s `port: 0`
2. Připojí dva klienty
3. Klient 1 vloží záznam
4. Klient 2 přečte záznam a ověří, že se shoduje
5. Oba klienti jsou řádně uklizeni

<details>
<summary>Řešení</summary>

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

let requestIdCounter = 1;

function connectClient(port: number) {
  return new Promise<{ ws: WebSocket; welcome: Record<string, unknown> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      resolve({ ws, welcome: JSON.parse(data.toString()) });
    });
    ws.once('error', reject);
  });
}

function sendRequest(ws: WebSocket, payload: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

describe('Multi-client test', () => {
  let server: NoexServer;
  let store: Store;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) c.close();
    }
    clients.length = 0;
    if (server?.isRunning) await server.stop();
    if (store) await store.stop();
  });

  it('klient 2 vidí data vložená klientem 1', async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: 'multi-client-test' });
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

    const c1 = await connectClient(server.port);
    const c2 = await connectClient(server.port);
    clients.push(c1.ws, c2.ws);

    // Klient 1 vkládá
    const insertResp = await sendRequest(c1.ws, {
      type: 'store.insert',
      bucket: 'items',
      data: { name: 'SdilenaPrvek' },
    });
    const inserted = insertResp['data'] as Record<string, unknown>;

    // Klient 2 čte
    const getResp = await sendRequest(c2.ws, {
      type: 'store.get',
      bucket: 'items',
      key: inserted['id'],
    });

    expect(getResp['type']).toBe('result');
    expect((getResp['data'] as Record<string, unknown>)['name']).toBe('SdilenaPrvek');
  });
});
```

</details>

## Shrnutí

- Použijte `port: 0` + `host: '127.0.0.1'` v každém testu — náhodný port na loopbacku zabraňuje kolizím
- `connectClient` čeká na welcome zprávu — spojení je plně připravené po resolvnutí
- `sendRequest` automaticky koreluje podle `id` — push zprávy jsou transparentně ignorovány
- Resetujte `requestIdCounter = 1` v `beforeEach` pro předvídatelné chování
- Sledujte všechna WebSocket spojení v poli `clients[]` a uklízejte je v `afterEach`
- Pořadí úklidu: uzavřít klienty, zastavit server, zastavit store
- Použijte `flush()` pouze když server potřebuje čas na asynchronní vedlejší efekty (např. počet spojení)
- Použijte `collectMessages` pro chyby na úrovni protokolu, které nemají korelované `id`

---

Další: [Testování subscriptions a auth](./02-testovani-subscriptions-a-auth.md)
