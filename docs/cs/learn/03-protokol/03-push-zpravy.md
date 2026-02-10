# Push zprávy

Push zprávy iniciuje server — přicházejí bez předchozího requestu. Server posílá data, když se změní výsledek odebírané query nebo když událost v rules engine odpovídá odebíranému vzoru.

## Co se naučíte

- Jak se push zprávy liší od response
- Dva push kanály: `subscription` a `event`
- Jak `subscriptionId` demultiplexuje push zprávy
- Jak zpracovávat push zprávy společně s request/response zprávami

## Push vs response

| | Response | Push |
|---|----------|------|
| Má `id` | Ano — odpovídá requestu | Ne |
| Spouštěč | Request klienta | Změna dat nebo shoda pravidla |
| Načasování | Po requestu | Kdykoli (asynchronně) |
| Korelace | Přes pole `id` | Přes `subscriptionId` |

```text
Client                                 Server
  │                                       │
  │── { id:1, type:"store.subscribe" } ──►│
  │◄── { id:1, type:"result", data:... }──│  ← Response (has id:1)
  │                                       │
  │   ... time passes, data changes ...   │
  │                                       │
  │◄── { type:"push", subscriptionId:... }│  ← Push (no id)
  │◄── { type:"push", subscriptionId:... }│  ← Push (no id)
```

## Kanál subscription

Když se přihlásíte k odběru reaktivní store query, push zprávy přicházejí na kanálu `subscription`:

```jsonc
// Subscribe to a query
→ { "id": 1, "type": "store.subscribe", "query": "all-users" }
← { "id": 1, "type": "result", "data": { "subscriptionId": "sub-1" } }

// Push arrives when data changes
← {
    "type": "push",
    "channel": "subscription",
    "subscriptionId": "sub-1",
    "data": [
      { "id": "u1", "name": "Alice", "role": "user" },
      { "id": "u2", "name": "Bob", "role": "admin" }
    ]
  }
```

Pole `data` obsahuje kompletní znovu vyhodnocený výsledek query — ne diff. U query vracejících pole je to pole; u skalárních query (count, sum apod.) je to jediná hodnota.

## Kanál event

Když se přihlásíte k odběru událostí rules engine se vzorem, push zprávy přicházejí na kanálu `event`:

```jsonc
// Subscribe to rule events
→ { "id": 2, "type": "rules.subscribe", "pattern": "order.*" }
← { "id": 2, "type": "result", "data": { "subscriptionId": "sub-2" } }

// Push arrives when a matching event fires
← {
    "type": "push",
    "channel": "event",
    "subscriptionId": "sub-2",
    "data": {
      "topic": "order.created",
      "event": { "orderId": "ORD-1", "total": 99.99 }
    }
  }
```

## Demultiplexování přes subscriptionId

Klient může mít více aktivních subscriptions. Pole `subscriptionId` určuje, ke které z nich push patří:

```text
Client has three subscriptions:
  sub-1 → "all-users" query
  sub-2 → "active-orders" query
  sub-3 → "alert.*" rules pattern

Incoming push:
  { type: "push", channel: "subscription", subscriptionId: "sub-2", data: [...] }
  → This is an update to the "active-orders" query.
```

## Zpracování push zpráv na klientovi

Helper `sendRequest` z kapitoly 2.2 push zprávy ignoruje (nemají `id`). Pro jejich zpracování potřebujete samostatný mechanismus:

```typescript
type PushHandler = (data: unknown) => void;

const pushHandlers = new Map<string, PushHandler>();

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'push') {
    const handler = pushHandlers.get(msg.subscriptionId);
    if (handler) {
      handler(msg.data);
    }
  }
  // Responses are handled by sendRequest's per-id handlers
});

// Register a push handler for a subscription
function onPush(subscriptionId: string, handler: PushHandler) {
  pushHandlers.set(subscriptionId, handler);
}

// Usage
const result = await sendRequest(ws, { type: 'store.subscribe', query: 'all-users' });
const subId = result.data.subscriptionId;

onPush(subId, (data) => {
  console.log('Users updated:', data);
});
```

## Helper waitForPush

V testech často potřebujete počkat na konkrétní push:

```typescript
function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Push timeout for ${subscriptionId}`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'push' && msg.subscriptionId === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg.data);
      }
    };

    ws.on('message', handler);
  });
}
```

**Důležité:** Nastavte push listener PŘED mutací, která ho spustí. Jinak můžete push zprávu propásnout.

## Funkční příklad

```typescript
// Subscribe and listen for changes
const subResult = await sendRequest(ws, {
  type: 'store.subscribe',
  query: 'all-users',
});
const subId = subResult.data.subscriptionId;

// Set up push listener BEFORE inserting
const pushPromise = waitForPush(ws, subId);

// This insert will trigger a push
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Carol' },
});

// Wait for the push
const updatedUsers = await pushPromise;
console.log('Updated list:', updatedUsers);
// [{ id: "...", name: "Alice" }, { id: "...", name: "Bob" }, { id: "...", name: "Carol" }]
```

## Cvičení

Napište funkci message router, která přijme surovou WebSocket zprávu jako string a směruje ji na správný handler podle typu. Měla by zvládnout: response (podle id), push zprávy (podle subscriptionId) a system zprávy (welcome, ping).

<details>
<summary>Řešení</summary>

```typescript
type ResponseHandler = (msg: Record<string, unknown>) => void;
type PushHandler = (data: unknown) => void;

const responseHandlers = new Map<number, ResponseHandler>();
const pushHandlers = new Map<string, PushHandler>();

function routeMessage(raw: string) {
  const msg = JSON.parse(raw);

  // Response (has id)
  if (msg.id !== undefined) {
    const handler = responseHandlers.get(msg.id);
    if (handler) {
      responseHandlers.delete(msg.id);
      handler(msg);
    }
    return;
  }

  // Push
  if (msg.type === 'push') {
    const handler = pushHandlers.get(msg.subscriptionId);
    if (handler) handler(msg.data);
    return;
  }

  // System messages
  if (msg.type === 'welcome') {
    console.log(`Protocol v${msg.version}, auth: ${msg.requiresAuth}`);
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
  } else if (msg.type === 'system') {
    console.log(`System: ${msg.event}`);
  }
}
```

</details>

## Shrnutí

- Push zprávy nemají `id` — jsou iniciované serverem, ne jako response
- Dva kanály: `subscription` (store queries) a `event` (rules engine)
- `subscriptionId` demultiplexuje push zprávy při více aktivních subscriptions
- Push data pro store queries jsou kompletní znovu vyhodnocený výsledek, ne diff
- Push listener vždy nastavte PŘED mutací, která push spustí
- Helper `waitForPush` je nezbytný pro testování

---

Další: [Zpracování chyb](./04-zpracovani-chyb.md)
