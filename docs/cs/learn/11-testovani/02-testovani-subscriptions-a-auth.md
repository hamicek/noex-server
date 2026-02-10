# Testování subscriptions a auth

Reaktivní subscriptions a autentizace přinášejí asynchronní push zprávy a stavová spojení. Tato kapitola pokrývá helpery a vzory pro správné načasování, díky kterým budou tyto testy spolehlivé.

## Co se naučíte

- `waitForPush` — naslouchání push zprávě podle `subscriptionId`
- `expectNoPush` — ověření, že žádný push nepřijde v daném časovém okně
- `store.settle()` — čekání na dokončení všech přehodnocení dotazů před asercí
- Klíčové pravidlo: push listener nastavit **před** mutací, která ho spouští
- Testovací fixtures pro auth: `createAuth`, `validSession`, token-based login flow
- Multi-client testy s nezávislými autentizačními stavy

## Nastavení serveru pro testy subscriptions

Testy subscriptions potřebují volání `defineQuery` před spuštěním serveru:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

let requestIdCounter = 1;
let storeCounter = 0;

// ... helpery connectClient, sendRequest, closeClient, flush z kapitoly 11.1 ...

describe('Testy subscriptions', () => {
  let server: NoexServer;
  let store: Store;
  let ws: WebSocket;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    requestIdCounter = 1;
    store = await Store.start({ name: `sub-test-${++storeCounter}` });

    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id:   { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
        role: { type: 'string', default: 'user' },
      },
    });

    // Definice dotazů PŘED spuštěním serveru
    store.defineQuery('all-users', async (ctx) => {
      return ctx.bucket('users').all();
    });

    store.defineQuery('user-count', async (ctx) => {
      return ctx.bucket('users').count();
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
});
```

## Helper waitForPush

Naslouchá push zprávě odpovídající konkrétnímu `subscriptionId`:

```typescript
function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for push on ${subscriptionId}`));
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}
```

Klíčové chování:
- Filtruje podle `type === 'push'` **a** `subscriptionId` — ignoruje odpovědi a ostatní pushe
- Výchozí timeout 2 sekundy — zabraňuje nekonečnému čekání testů
- Po resolvnutí odstraní listener — žádné hromadění zastaralých handlerů

## Klíčové pravidlo načasování

**Vždy nastavte push listener PŘED mutací, která ho spouští.**

```typescript
// ✓ Správně: listener je připraven před mutací
const pushPromise = waitForPush(ws, subscriptionId);  // 1. Nejprve naslouchat

await sendRequest(ws, {                                // 2. Poté mutovat
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

await store.settle();                                  // 3. Počkat na přehodnocení
const push = await pushPromise;                        // 4. Přijmout push
```

```typescript
// ✗ Špatně: mutace proběhne dříve než je listener připojený
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

// Push mohl být již odeslán a zmeškaný!
const push = await waitForPush(ws, subscriptionId);
```

Push zpráva se odesílá jakmile se dotaz přehodnotí. Pokud listener ještě není připojený, zpráva přijde bez handleru a je ztracena.

## store.settle()

`store.settle()` čeká na dokončení všech probíhajících přehodnocení dotazů. Bez něj nemusí být push ještě vygenerován, když se ho pokusíte přijmout.

```typescript
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Bob' },
});

await store.settle();  // Zajistí, že dotaz byl přehodnocen
const push = await pushPromise;
```

Tok vypadá takto:

```
Klient odešle store.insert
  │
  ▼
Server vloží záznam, odešle odpověď
  │
  ▼
Store detekuje změnu dat, naplánuje přehodnocení dotazu
  │
  ▼
store.settle() ← čeká zde, dokud se přehodnocení nedokončí
  │
  ▼
Push zpráva odeslána odběratelům
```

**Kdy použít `store.settle()`:** Vždy ho zavolejte mezi mutací a asercí na push. Bez něj může test projít lokálně, ale selhat v CI kvůli rozdílům v načasování.

## Kompletní test subscription

Celý vzor pohromadě — subscribe, mutace, aserce na push:

```typescript
it('odešle push při vložení záznamu', async () => {
  // 1. Přihlášení k odběru a získání subscriptionId
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subData = subResp['data'] as Record<string, unknown>;
  const subscriptionId = subData['subscriptionId'] as string;

  // 2. Nastavení push listeneru PŘED mutací
  const pushPromise = waitForPush(ws, subscriptionId);

  // 3. Mutace
  await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Bob' },
  });

  // 4. Čekání na přehodnocení dotazu
  await store.settle();

  // 5. Aserce na push
  const push = await pushPromise;
  expect(push['type']).toBe('push');
  expect(push['channel']).toBe('subscription');
  expect(push['subscriptionId']).toBe(subscriptionId);

  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('Bob');
});
```

## Helper expectNoPush

Ověří, že subscription **nedostane** push v daném časovém okně:

```typescript
function expectNoPush(
  ws: WebSocket,
  subscriptionId: string,
  ms = 300,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(); // Žádný push nepřišel — test prošel
    }, ms);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(`Unexpected push on ${subscriptionId}`));
      }
    };
    ws.on('message', handler);
  });
}
```

Použijte pro ověření, že unsubscribe funguje:

```typescript
it('zastaví push po unsubscribe', async () => {
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Odhlášení
  await sendRequest(ws, {
    type: 'store.unsubscribe',
    subscriptionId,
  });

  // Nastavení listeneru "žádný push"
  const noPushPromise = expectNoPush(ws, subscriptionId);

  // Mutace — NEMĚLA by vyvolat push
  await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Ghost' },
  });

  await store.settle();
  await noPushPromise; // Resolvne se po 300ms bez pushe — test prošel
});
```

## Testování více subscriptions

Jedno spojení může mít více subscriptions. Použijte `Promise.all` pro čekání na pushe z obou:

```typescript
it('přijímá pushe pro více subscriptions', async () => {
  const sub1Resp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  const sub2Resp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'user-count',
  });
  const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  const push1Promise = waitForPush(ws, sub1Id);
  const push2Promise = waitForPush(ws, sub2Id);

  await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Alice' },
  });

  await store.settle();

  const [push1, push2] = await Promise.all([push1Promise, push2Promise]);

  // all-users vrací pole
  const users = push1['data'] as Record<string, unknown>[];
  expect(users).toHaveLength(1);
  expect(users[0]!['name']).toBe('Alice');

  // user-count vrací skalár
  expect(push2['data']).toBe(1);
});
```

## Multi-client testy subscriptions

Ověřte, že mutace jednoho klienta vyvolají push u subscriptions druhého klienta:

```typescript
it('klient 1 dostane push když klient 2 mutuje', async () => {
  // Klient 1 se přihlásí k odběru
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Klient 2 se připojí
  const conn2 = await connectClient(server.port);
  const ws2 = conn2.ws;
  clients.push(ws2);

  // Nastavení listeneru na klientovi 1
  const pushPromise = waitForPush(ws, subscriptionId);

  // Klient 2 vloží data
  await sendRequest(ws2, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'OdKlienta2' },
  });

  await store.settle();

  // Klient 1 přijme push
  const push = await pushPromise;
  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('OdKlienta2');
});
```

## Testovací fixtures pro auth

Pro auth testy definujte znovupoužitelné session fixtures a factory `createAuth`:

```typescript
import type { AuthConfig, AuthSession } from '@hamicek/noex-server';

const validSession: AuthSession = {
  userId: 'user-1',
  roles: ['user'],
};

const adminSession: AuthSession = {
  userId: 'admin-1',
  roles: ['admin'],
};

function createAuth(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    validate: async (token) => {
      if (token === 'valid-user') return validSession;
      if (token === 'valid-admin') return adminSession;
      return null;
    },
    ...overrides,
  };
}
```

Použití pro spuštění serveru s auth:

```typescript
server = await NoexServer.start({
  store,
  port: 0,
  host: '127.0.0.1',
  auth: createAuth(),
});
```

## Testování auth flow

### Přihlášení a ověření přístupu

```typescript
it('autentizuje a povolí operace', async () => {
  const { ws, welcome } = await connectClient(server.port);
  clients.push(ws);

  expect(welcome['requiresAuth']).toBe(true);

  // Přihlášení
  const loginResp = await sendRequest(ws, {
    type: 'auth.login',
    token: 'valid-user',
  });
  expect(loginResp['type']).toBe('result');
  expect(loginResp['data']).toMatchObject({
    userId: 'user-1',
    roles: ['user'],
  });

  // Operace se store nyní fungují
  const insertResp = await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Alice' },
  });
  expect(insertResp['type']).toBe('result');
});
```

### Blokování před autentizací

```typescript
it('blokuje operace před přihlášením', async () => {
  const { ws } = await connectClient(server.port);
  clients.push(ws);

  const resp = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'users',
  });

  expect(resp['type']).toBe('error');
  expect(resp['code']).toBe('UNAUTHORIZED');
  expect(resp['message']).toBe('Authentication required');
});
```

### Izolace spojení

Auth stav je per-connection. Přihlášení na jednom spojení neovlivní druhé:

```typescript
it('auth stav je nezávislý na každém spojení', async () => {
  const { ws: ws1 } = await connectClient(server.port);
  const { ws: ws2 } = await connectClient(server.port);
  clients.push(ws1, ws2);

  // Pouze ws1 se přihlásí
  await sendRequest(ws1, { type: 'auth.login', token: 'valid-user' });

  // ws1 má přístup ke store
  const resp1 = await sendRequest(ws1, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp1['type']).toBe('result');

  // ws2 nemá — stále neautentizovaný
  const resp2 = await sendRequest(ws2, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp2['type']).toBe('error');
  expect(resp2['code']).toBe('UNAUTHORIZED');
});
```

## Testování oprávnění

Použijte callback `permissions.check` pro řízení přístupu podle operace:

```typescript
it('povolí adminovi a odepře uživateli', async () => {
  server = await NoexServer.start({
    store,
    port: 0,
    host: '127.0.0.1',
    auth: createAuth({
      permissions: {
        check: (session, operation) => {
          if (session.roles.includes('admin')) return true;
          return operation !== 'store.clear';
        },
      },
    }),
  });

  const { ws: userWs } = await connectClient(server.port);
  clients.push(userWs);
  await sendRequest(userWs, { type: 'auth.login', token: 'valid-user' });

  const { ws: adminWs } = await connectClient(server.port);
  clients.push(adminWs);
  await sendRequest(adminWs, { type: 'auth.login', token: 'valid-admin' });

  // Uživateli je odepřen store.clear
  const userClear = await sendRequest(userWs, {
    type: 'store.clear',
    bucket: 'users',
  });
  expect(userClear['code']).toBe('FORBIDDEN');

  // Admin má povolen
  const adminClear = await sendRequest(adminWs, {
    type: 'store.clear',
    bucket: 'users',
  });
  expect(adminClear['type']).toBe('result');
});
```

## Testování expirace session

Vytvořte session s `expiresAt` v blízké budoucnosti:

```typescript
it('detekuje expiraci session mezi operacemi', async () => {
  const shortLived: AuthSession = {
    userId: 'user-1',
    roles: ['user'],
    expiresAt: Date.now() + 200, // Vyprší za 200ms
  };

  server = await NoexServer.start({
    store,
    port: 0,
    host: '127.0.0.1',
    auth: {
      validate: async (token) =>
        token === 'short-lived' ? shortLived : null,
    },
  });

  const { ws } = await connectClient(server.port);
  clients.push(ws);

  // Přihlášení uspěje
  const loginResp = await sendRequest(ws, {
    type: 'auth.login',
    token: 'short-lived',
  });
  expect(loginResp['type']).toBe('result');

  // Čekání na expiraci session
  await flush(300);

  // Další požadavek je odmítnut
  const resp = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp['type']).toBe('error');
  expect(resp['code']).toBe('UNAUTHORIZED');
  expect(resp['message']).toBe('Session expired');
});
```

## Přehled načasování

| Scénář | Vzor |
|--------|------|
| Čekání na push | `const p = waitForPush(ws, subId)` → mutace → `await store.settle()` → `await p` |
| Ověření žádného pushe | `const p = expectNoPush(ws, subId)` → mutace → `await store.settle()` → `await p` |
| Více pushů z jedné mutace | Nastavit všechny `waitForPush` promise → mutace → `settle()` → `Promise.all(...)` |
| Sekvenční pushe | Počkat na první push, pak nastavit další `waitForPush`, znovu mutovat |
| Počet spojení po odpojení | `await closeClient(ws)` → `await flush(200)` → aserce na `server.connectionCount` |

## Cvičení

Napište test, který:
1. Spustí server s povolenou autentizací
2. Klient 1 se přihlásí jako `valid-user` a přihlásí se k odběru `all-users`
3. Klient 2 se přihlásí jako `valid-admin` a vloží záznam
4. Klient 1 přijme push s novým záznamem
5. Klient 2 se pokusí odhlásit subscription klienta 1 — selže s `NOT_FOUND` (subscriptions jsou per-connection)

<details>
<summary>Řešení</summary>

```typescript
it('multi-client auth + subscription flow', async () => {
  store = await Store.start({ name: 'exercise-test' });
  await store.defineBucket('users', {
    key: 'id',
    schema: {
      id:   { type: 'string', generated: 'uuid' },
      name: { type: 'string', required: true },
    },
  });
  store.defineQuery('all-users', async (ctx) => ctx.bucket('users').all());

  server = await NoexServer.start({
    store,
    port: 0,
    host: '127.0.0.1',
    auth: createAuth(),
  });

  // Klient 1: přihlášení + odběr
  const c1 = await connectClient(server.port);
  clients.push(c1.ws);
  await sendRequest(c1.ws, { type: 'auth.login', token: 'valid-user' });

  const subResp = await sendRequest(c1.ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Klient 2: přihlášení
  const c2 = await connectClient(server.port);
  clients.push(c2.ws);
  await sendRequest(c2.ws, { type: 'auth.login', token: 'valid-admin' });

  // Nastavení push listeneru na klientovi 1
  const pushPromise = waitForPush(c1.ws, subscriptionId);

  // Klient 2 vloží data
  await sendRequest(c2.ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'VlozenoAdminem' },
  });

  await store.settle();

  // Klient 1 přijme push
  const push = await pushPromise;
  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('VlozenoAdminem');

  // Klient 2 nemůže odhlásit subscription klienta 1
  const unsubResp = await sendRequest(c2.ws, {
    type: 'store.unsubscribe',
    subscriptionId,
  });
  expect(unsubResp['type']).toBe('error');
  expect(unsubResp['code']).toBe('NOT_FOUND');
});
```

</details>

## Shrnutí

- `waitForPush(ws, subscriptionId)` filtruje podle `type === 'push'` a `subscriptionId` — ignoruje vše ostatní
- `expectNoPush(ws, subscriptionId)` projde, když žádný push nepřijde v časovém okně (výchozí 300ms)
- **Vždy** nastavte push listener před mutací — jinak je push ztracen
- **Vždy** zavolejte `store.settle()` mezi mutací a asercí na push — čeká na přehodnocení dotazu
- Použijte `Promise.all` pro čekání na více pushů vyvolaných jednou mutací
- Auth test fixtures (`createAuth`, `validSession`, `adminSession`) zjednodušují opakující se setup
- Auth stav je per-connection — izolaci testujte připojením více klientů
- `permissions.check(session, operation, resource)` dostává úplný kontext pro rozhodování podle rolí
- Testy expirace session používají `expiresAt: Date.now() + N` s `flush()` pro simulaci plynutí času

---

Další: [Dashboard v reálném čase](../12-projekty/01-dashboard-v-realnem-case.md)
