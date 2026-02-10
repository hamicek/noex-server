# Connecting a Client

Now that you have a running server, let's connect a WebSocket client and send requests. You'll learn the welcome message, request/response format, and how to build a reusable `sendRequest` helper.

## What You'll Learn

- How to connect to the server via WebSocket
- What the welcome message contains
- How to send a request and receive a response
- How to build a `sendRequest` helper for request/response correlation

## Connecting via WebSocket

Any WebSocket client works — browser's built-in `WebSocket`, Node.js `ws` library, `websocat` CLI, etc. The server listens on `ws://host:port/` (configurable path).

### Node.js (with `ws` library)

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

### Browser

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log('Received:', msg);
};
```

## The Welcome Message

The first message you receive after connecting is always a `welcome`:

```jsonc
{
  "type": "welcome",
  "version": "1.0.0",
  "requiresAuth": false,
  "serverTime": 1706745600000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"welcome"` | Always `"welcome"` |
| `version` | `string` | Protocol version (currently `"1.0.0"`) |
| `requiresAuth` | `boolean` | Whether you must call `auth.login` before other operations |
| `serverTime` | `number` | Server timestamp in milliseconds (Unix epoch) |

If `requiresAuth` is `true`, you must send an `auth.login` request before any `store.*` or `rules.*` operation, otherwise you'll get `UNAUTHORIZED` errors.

## Sending a Request

Every request is a JSON object with an `id` (number) and `type` (operation name):

```typescript
ws.send(JSON.stringify({
  id: 1,
  type: 'store.insert',
  bucket: 'tasks',
  data: { title: 'Learn noex-server' },
}));
```

The server responds with the same `id`:

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

Or an error:

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: title"
}
```

## The sendRequest Helper

Manually tracking `id` values is tedious. Here's a reusable helper that handles correlation:

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

Now sending requests is straightforward:

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

**Important:** The handler ignores messages where `msg.id` doesn't match. This is essential because the server may send push messages (which have no `id`) or responses to other in-flight requests.

## Complete Working Example

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

## Exercise

Write a client that:
1. Connects to `ws://localhost:8080`
2. Waits for the welcome message and prints the protocol version
3. Inserts three tasks: "Task A", "Task B", "Task C"
4. Retrieves all tasks with `store.all`
5. Prints the count of tasks

<details>
<summary>Solution</summary>

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

## Summary

- Connect to `ws://host:port/` — the first message is always a `welcome`
- Every request needs a unique numeric `id` and an operation `type`
- The server echoes the `id` in the response for correlation
- The `sendRequest` helper pattern is essential for async request/response
- Push messages (no `id`) are ignored by the correlation handler — this is by design

---

Next: [Configuration](./03-configuration.md)
