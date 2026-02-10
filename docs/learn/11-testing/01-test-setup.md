# Test Setup

Set up a reliable, isolated test environment for your noex-server using Vitest and the `ws` package. Every test gets its own Store, server, and WebSocket connections — no shared state, no port conflicts, no flaky tests.

## What You'll Learn

- `port: 0` and `host: '127.0.0.1'` — let the OS assign a random port on loopback
- Helper functions: `connectClient`, `sendRequest`, `closeClient`, `flush`
- `beforeEach` / `afterEach` lifecycle for clean isolation
- Vitest configuration for noex-server integration tests
- Common pitfalls and how to avoid them

## Prerequisites

Install the test dependencies:

```bash
npm install -D vitest ws @types/ws
```

## Vitest Configuration

Create `vitest.config.ts` at the project root:

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

- **`globals: false`** — explicit imports (`describe`, `it`, `expect`) prevent naming collisions
- **`environment: 'node'`** — WebSocket and net APIs require a real Node.js environment
- **`testTimeout: 10_000`** — WebSocket tests involve real I/O; 10 seconds prevents false timeouts

## Port 0 and Loopback Binding

The most critical pattern for non-flaky server tests: **bind to a random port on loopback**.

```typescript
const server = await NoexServer.start({
  store,
  port: 0,            // OS assigns a free port
  host: '127.0.0.1',  // Loopback only — no network exposure
});

// Read the actual assigned port
console.log(server.port); // e.g. 54321
```

Why this matters:

| Problem | Fixed by |
|---------|----------|
| Port conflicts between parallel tests | `port: 0` — each test gets a unique port |
| Firewall popups on macOS | `host: '127.0.0.1'` — never binds to external interfaces |
| CI environment restrictions | Loopback is always available, no permissions needed |

## Helper Functions

Every integration test file needs a small set of helpers. These are defined inline in each test file — no shared module required.

### connectClient

Opens a WebSocket connection and waits for the welcome message:

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

The server sends a `welcome` message immediately on connect. `connectClient` resolves only after receiving it, guaranteeing the connection is fully established.

### sendRequest

Sends a request and waits for the correlated response:

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

Key details:
- Auto-increments `id` to ensure unique correlation
- **Ignores push messages** — only resolves when it sees its own `id` in the response
- Must reset `requestIdCounter = 1` in `beforeEach` to keep IDs predictable

### closeClient

Gracefully closes a WebSocket connection:

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

Waits for asynchronous server-side processing to complete:

```typescript
function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Use `flush()` after operations where the server needs time to update internal state (e.g. connection count after disconnect). Not needed after `sendRequest` — that already waits for the response.

## Test Lifecycle

The `beforeEach` / `afterEach` pattern ensures complete isolation between tests:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

describe('My Feature', () => {
  let server: NoexServer;
  let store: Store;
  let ws: WebSocket;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  beforeEach(async () => {
    requestIdCounter = 1;

    // Fresh store per test — unique name prevents collisions
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
    // Close all client connections
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) {
        c.close();
      }
    }
    clients.length = 0;

    // Stop server
    if (server?.isRunning) {
      await server.stop();
    }

    // Stop store
    if (store) {
      await store.stop();
    }
  });

  it('inserts and retrieves a record', async () => {
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

### Why Track Clients in an Array?

Tests that create multiple connections need to clean them all up. Pushing every WebSocket into `clients[]` and iterating in `afterEach` prevents leaked connections:

```typescript
it('handles multiple connections', async () => {
  const c2 = await connectClient(server.port);
  clients.push(c2.ws); // Track for cleanup

  const c3 = await connectClient(server.port);
  clients.push(c3.ws); // Track for cleanup

  // Test logic...
});
```

### Cleanup Order

The cleanup order matters:

```
1. Close all WebSocket clients
2. Stop the server (server.stop())
3. Stop the store (store.stop())
```

Closing clients first prevents "connection reset" errors. Stopping the server before the store ensures no operations are in flight.

## Complete Test File Template

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

// ── Helpers ──────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────

describe('My Feature', () => {
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

  it('works', async () => {
    const resp = await sendRequest(ws, {
      type: 'store.all',
      bucket: 'users',
    });
    expect(resp['type']).toBe('result');
    expect(resp['data']).toEqual([]);
  });
});
```

## Testing Error Responses

Error responses follow a consistent structure. Assert both `type` and `code`:

```typescript
it('returns BUCKET_NOT_DEFINED for unknown bucket', async () => {
  const resp = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'nonexistent',
  });

  expect(resp['type']).toBe('error');
  expect(resp['code']).toBe('BUCKET_NOT_DEFINED');
});
```

For protocol-level errors (invalid JSON, missing `id`), use `collectMessages` instead of `sendRequest` since there's no `id` to correlate:

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

it('responds with PARSE_ERROR for invalid JSON', async () => {
  const response = collectMessages(ws, 1);
  ws.send('not valid json{{{');
  const [msg] = await response;

  expect(msg!['type']).toBe('error');
  expect(msg!['code']).toBe('PARSE_ERROR');
});
```

## Testing Multi-Client Scenarios

Connect additional clients within individual tests:

```typescript
it('data inserted by one client is visible to another', async () => {
  // ws is already connected from beforeEach

  // Connect a second client
  const conn2 = await connectClient(server.port);
  const ws2 = conn2.ws;
  clients.push(ws2); // Track for cleanup

  // Client 1 inserts
  const insertResp = await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Alice' },
  });
  const inserted = insertResp['data'] as Record<string, unknown>;

  // Client 2 reads — sees the same data
  const getResp = await sendRequest(ws2, {
    type: 'store.get',
    bucket: 'users',
    key: inserted['id'],
  });

  const data = getResp['data'] as Record<string, unknown>;
  expect(data['name']).toBe('Alice');
});
```

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Hardcoded port (e.g. `port: 3000`) | Use `port: 0` — hardcoded ports collide in parallel test runs |
| Not resetting `requestIdCounter` | Add `requestIdCounter = 1` in `beforeEach` |
| Forgetting `clients.push(ws)` | Every new connection must be tracked for cleanup |
| Asserting connection count without `flush()` | Server updates counts asynchronously — `await flush()` first |
| Not stopping store in `afterEach` | Leaked stores accumulate and slow down the suite |

## Exercise

Write a test that:
1. Starts a fresh Store and Server with `port: 0`
2. Connects two clients
3. Client 1 inserts a record
4. Client 2 reads the record and verifies it matches
5. Both clients are properly cleaned up

<details>
<summary>Solution</summary>

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

  it('client 2 sees data inserted by client 1', async () => {
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

    // Client 1 inserts
    const insertResp = await sendRequest(c1.ws, {
      type: 'store.insert',
      bucket: 'items',
      data: { name: 'SharedItem' },
    });
    const inserted = insertResp['data'] as Record<string, unknown>;

    // Client 2 reads
    const getResp = await sendRequest(c2.ws, {
      type: 'store.get',
      bucket: 'items',
      key: inserted['id'],
    });

    expect(getResp['type']).toBe('result');
    expect((getResp['data'] as Record<string, unknown>)['name']).toBe('SharedItem');
  });
});
```

</details>

## Summary

- Use `port: 0` + `host: '127.0.0.1'` for every test — random port on loopback prevents conflicts
- `connectClient` waits for the welcome message — connection is fully ready when it resolves
- `sendRequest` auto-correlates by `id` — push messages are transparently ignored
- Reset `requestIdCounter = 1` in `beforeEach` for predictable test behavior
- Track all WebSocket connections in a `clients[]` array and clean them up in `afterEach`
- Cleanup order: close clients, stop server, stop store
- Use `flush()` only when the server needs time for async side-effects (e.g. connection count)
- Use `collectMessages` for protocol-level errors that don't have a correlated `id`

---

Next: [Testing Subscriptions and Auth](./02-testing-subscriptions-auth.md)
