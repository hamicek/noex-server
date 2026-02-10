# Připojení klienta

Teď, když máte běžící server, pojďme připojit WebSocket klienta a posílat požadavky. Naučíte se, co obsahuje welcome zpráva, jaký je formát požadavků a odpovědí a jak si vytvořit znovupoužitelný helper `sendRequest`.

## Co se naučíte

- Jak se připojit k serveru přes WebSocket
- Co obsahuje welcome zpráva
- Jak odeslat požadavek a přijmout odpověď
- Jak vytvořit helper `sendRequest` pro korelaci požadavků a odpovědí

## Připojení přes WebSocket

Funguje jakýkoli WebSocket klient — vestavěný `WebSocket` v prohlížeči, Node.js knihovna `ws`, CLI nástroj `websocat` atd. Server naslouchá na `ws://host:port/` (cesta je konfigurovatelná).

### Node.js (s knihovnou `ws`)

```bash
npm install ws
```

```typescript
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg);
});
```

### Prohlížeč

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Received:', msg);
};
```

## Welcome zpráva

První zpráva, kterou po připojení obdržíte, je vždy `welcome`:

```jsonc
{
  "type": "welcome",
  "version": "1.0.0",
  "requiresAuth": false,
  "serverTime": 1706745600000
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `type` | `"welcome"` | Vždy `"welcome"` |
| `version` | `string` | Verze protokolu (aktuálně `"1.0.0"`) |
| `requiresAuth` | `boolean` | Zda musíte zavolat `auth.login` před ostatními operacemi |
| `serverTime` | `number` | Časové razítko serveru v milisekundách (Unix epoch) |

Pokud je `requiresAuth` rovno `true`, musíte odeslat požadavek `auth.login` před jakoukoli operací `store.*` nebo `rules.*`, jinak dostanete chybu `UNAUTHORIZED`.

## Odeslání požadavku

Každý požadavek je JSON objekt s `id` (číslo) a `type` (název operace):

```typescript
ws.send(JSON.stringify({
  id: 1,
  type: 'store.insert',
  bucket: 'tasks',
  data: { title: 'Learn noex-server' },
}));
```

Server odpoví se stejným `id`:

```jsonc
{
  "id": 1,
  "type": "result",
  "data": {
    "id": "a1b2c3d4",
    "title": "Learn noex-server",
    "done": false,
    "_version": 1,
    "_createdAt": 1706745600000
  }
}
```

Nebo chybou:

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: title"
}
```

## Helper sendRequest

Ruční sledování hodnot `id` je únavné. Zde je znovupoužitelný helper, který se o korelaci postará:

```typescript
import { WebSocket } from 'ws';

let nextId = 1;

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = nextId++;

    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}
```

Odesílání požadavků je teď přímočaré:

```typescript
// Insert
const result = await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'tasks',
  data: { title: 'Buy groceries' },
});
console.log(result.data); // { id: "...", title: "Buy groceries", done: false, ... }

// Get
const task = await sendRequest(ws, {
  type: 'store.get',
  bucket: 'tasks',
  key: result.data.id,
});
console.log(task.data); // { id: "...", title: "Buy groceries", done: false, ... }
```

**Důležité:** Handler ignoruje zprávy, kde `msg.id` neodpovídá. To je zásadní, protože server může posílat push zprávy (bez `id`) nebo odpovědi na jiné rozpracované požadavky.

## Kompletní funkční příklad

```typescript
import { WebSocket } from 'ws';

let nextId = 1;

function connectClient(
  url: string,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString());
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
    const id = nextId++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

async function main() {
  // Connect and wait for welcome
  const { ws, welcome } = await connectClient('ws://localhost:8080');
  console.log('Protocol version:', welcome.version);
  console.log('Auth required:', welcome.requiresAuth);

  // Insert a task
  const insertResult = await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'tasks',
    data: { title: 'Learn noex-server', done: false },
  });
  console.log('Inserted:', insertResult.data);

  // List all tasks
  const allResult = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'tasks',
  });
  console.log('All tasks:', allResult.data);

  ws.close();
}

main();
```

## Cvičení

Napište klienta, který:
1. Se připojí na `ws://localhost:8080`
2. Počká na welcome zprávu a vypíše verzi protokolu
3. Vloží tři úkoly: "Task A", "Task B", "Task C"
4. Načte všechny úkoly pomocí `store.all`
5. Vypíše celkový počet úkolů

<details>
<summary>Řešení</summary>

```typescript
import { WebSocket } from 'ws';

let nextId = 1;

function connectClient(url: string) {
  return new Promise<{ ws: WebSocket; welcome: any }>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('message', (data) => resolve({ ws, welcome: JSON.parse(data.toString()) }));
    ws.once('error', reject);
  });
}

function sendRequest(ws: WebSocket, payload: Record<string, unknown>) {
  return new Promise<any>((resolve) => {
    const id = nextId++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.off('message', handler); resolve(msg); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

async function main() {
  const { ws, welcome } = await connectClient('ws://localhost:8080');
  console.log('Protocol:', welcome.version);

  for (const title of ['Task A', 'Task B', 'Task C']) {
    await sendRequest(ws, {
      type: 'store.insert',
      bucket: 'tasks',
      data: { title },
    });
  }

  const all = await sendRequest(ws, { type: 'store.all', bucket: 'tasks' });
  console.log(`Total tasks: ${all.data.length}`);

  ws.close();
}

main();
```

</details>

## Shrnutí

- Připojte se na `ws://host:port/` — první zpráva je vždy `welcome`
- Každý požadavek potřebuje unikátní číselné `id` a `type` operace
- Server ve své odpovědi vrací stejné `id` pro korelaci
- Vzor s helperem `sendRequest` je nezbytný pro asynchronní komunikaci požadavek/odpověď
- Push zprávy (bez `id`) jsou korelačním handlerem ignorovány — to je záměr

---

Další: [Konfigurace](./03-konfigurace.md)
