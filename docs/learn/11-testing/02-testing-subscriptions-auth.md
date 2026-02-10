# Testing Subscriptions and Auth

Reactive subscriptions and authentication introduce asynchronous push messages and stateful connections. This chapter covers the helpers and timing patterns that make these tests reliable.

## What You'll Learn

- `waitForPush` — listen for a push message by `subscriptionId`
- `expectNoPush` — assert that no push arrives within a time window
- `store.settle()` — wait for all pending query re-evaluations before asserting
- The critical rule: set up the push listener **before** the mutation that triggers it
- Auth test fixtures: `createAuth`, `validSession`, token-based login flows
- Multi-client tests with independent authentication states

## Server Setup for Subscription Tests

Subscription tests need `defineQuery` calls before starting the server:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

let requestIdCounter = 1;
let storeCounter = 0;

// ... connectClient, sendRequest, closeClient, flush helpers from Chapter 11.1 ...

describe('Subscription tests', () => {
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

    // Define queries BEFORE starting the server
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

## The waitForPush Helper

Listens for a push message matching a specific `subscriptionId`:

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

Key behavior:
- Filters by `type === 'push'` **and** `subscriptionId` — ignores responses and other pushes
- Times out after 2 seconds by default — prevents tests from hanging indefinitely
- Removes the listener after resolving — no accumulation of stale handlers

## The Critical Timing Rule

**Always set up the push listener BEFORE the mutation that triggers it.**

```typescript
// ✓ Correct: listener is ready before the mutation
const pushPromise = waitForPush(ws, subscriptionId);  // 1. Listen first

await sendRequest(ws, {                                // 2. Mutate second
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

await store.settle();                                  // 3. Wait for re-evaluation
const push = await pushPromise;                        // 4. Receive the push
```

```typescript
// ✗ Wrong: mutation fires before listener is attached
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Alice' },
});

// Push may have already been sent and missed!
const push = await waitForPush(ws, subscriptionId);
```

The push message is sent as soon as the query re-evaluates. If the listener isn't attached yet, the message arrives with no handler and is lost.

## store.settle()

`store.settle()` waits for all pending query re-evaluations to complete. Without it, the push may not have been generated yet when you try to receive it.

```typescript
await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Bob' },
});

await store.settle();  // Ensures the query has re-evaluated
const push = await pushPromise;
```

The flow looks like this:

```
Client sends store.insert
  │
  ▼
Server inserts record, sends response
  │
  ▼
Store detects data change, schedules query re-evaluation
  │
  ▼
store.settle() ← waits here until re-evaluation completes
  │
  ▼
Push message sent to subscribed clients
```

**When to use `store.settle()`:** Always call it between a mutation and asserting on a push. Without it, the test may pass locally but fail in CI due to timing differences.

## Complete Subscription Test

Putting it all together — subscribe, mutate, assert on the push:

```typescript
it('sends push when record is inserted', async () => {
  // 1. Subscribe and get subscriptionId
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subData = subResp['data'] as Record<string, unknown>;
  const subscriptionId = subData['subscriptionId'] as string;

  // 2. Set up push listener BEFORE mutation
  const pushPromise = waitForPush(ws, subscriptionId);

  // 3. Mutate
  await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Bob' },
  });

  // 4. Wait for query re-evaluation
  await store.settle();

  // 5. Assert on the push
  const push = await pushPromise;
  expect(push['type']).toBe('push');
  expect(push['channel']).toBe('subscription');
  expect(push['subscriptionId']).toBe(subscriptionId);

  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('Bob');
});
```

## The expectNoPush Helper

Asserts that a subscription does **not** receive a push within a given time window:

```typescript
function expectNoPush(
  ws: WebSocket,
  subscriptionId: string,
  ms = 300,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(); // No push received — test passes
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

Use it to verify unsubscribe works:

```typescript
it('stops push after unsubscribe', async () => {
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Unsubscribe
  await sendRequest(ws, {
    type: 'store.unsubscribe',
    subscriptionId,
  });

  // Set up the "no push" listener
  const noPushPromise = expectNoPush(ws, subscriptionId);

  // Mutate — should NOT trigger a push
  await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Ghost' },
  });

  await store.settle();
  await noPushPromise; // Resolves after 300ms with no push — test passes
});
```

## Testing Multiple Subscriptions

A single connection can hold multiple subscriptions. Use `Promise.all` to wait for pushes from both:

```typescript
it('receives pushes for multiple subscriptions', async () => {
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

  // all-users returns the array
  const users = push1['data'] as Record<string, unknown>[];
  expect(users).toHaveLength(1);
  expect(users[0]!['name']).toBe('Alice');

  // user-count returns the scalar
  expect(push2['data']).toBe(1);
});
```

## Multi-Client Subscription Tests

Test that mutations from one client trigger pushes to another client's subscriptions:

```typescript
it('client 1 receives push when client 2 mutates', async () => {
  // Client 1 subscribes
  const subResp = await sendRequest(ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Client 2 connects
  const conn2 = await connectClient(server.port);
  const ws2 = conn2.ws;
  clients.push(ws2);

  // Set up listener on client 1
  const pushPromise = waitForPush(ws, subscriptionId);

  // Client 2 inserts
  await sendRequest(ws2, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'FromClient2' },
  });

  await store.settle();

  // Client 1 receives the push
  const push = await pushPromise;
  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('FromClient2');
});
```

## Auth Test Fixtures

For auth tests, define reusable session fixtures and a `createAuth` factory:

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

Use it to start a server with auth:

```typescript
server = await NoexServer.start({
  store,
  port: 0,
  host: '127.0.0.1',
  auth: createAuth(),
});
```

## Testing the Auth Flow

### Login and Verify Access

```typescript
it('authenticates and allows operations', async () => {
  const { ws, welcome } = await connectClient(server.port);
  clients.push(ws);

  expect(welcome['requiresAuth']).toBe(true);

  // Login
  const loginResp = await sendRequest(ws, {
    type: 'auth.login',
    token: 'valid-user',
  });
  expect(loginResp['type']).toBe('result');
  expect(loginResp['data']).toMatchObject({
    userId: 'user-1',
    roles: ['user'],
  });

  // Now store operations work
  const insertResp = await sendRequest(ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'Alice' },
  });
  expect(insertResp['type']).toBe('result');
});
```

### Blocked Before Auth

```typescript
it('blocks operations before login', async () => {
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

### Connection Isolation

Auth state is per-connection. Logging in on one connection does not affect another:

```typescript
it('auth state is independent per connection', async () => {
  const { ws: ws1 } = await connectClient(server.port);
  const { ws: ws2 } = await connectClient(server.port);
  clients.push(ws1, ws2);

  // Only ws1 logs in
  await sendRequest(ws1, { type: 'auth.login', token: 'valid-user' });

  // ws1 can access store
  const resp1 = await sendRequest(ws1, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp1['type']).toBe('result');

  // ws2 cannot — still unauthenticated
  const resp2 = await sendRequest(ws2, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp2['type']).toBe('error');
  expect(resp2['code']).toBe('UNAUTHORIZED');
});
```

## Testing Permissions

Use the `permissions.check` callback to control access per-operation:

```typescript
it('grants admin access while denying user', async () => {
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

  // User is denied store.clear
  const userClear = await sendRequest(userWs, {
    type: 'store.clear',
    bucket: 'users',
  });
  expect(userClear['code']).toBe('FORBIDDEN');

  // Admin is allowed
  const adminClear = await sendRequest(adminWs, {
    type: 'store.clear',
    bucket: 'users',
  });
  expect(adminClear['type']).toBe('result');
});
```

## Testing Session Expiration

Create a session with `expiresAt` in the near future:

```typescript
it('detects session expiry between operations', async () => {
  const shortLived: AuthSession = {
    userId: 'user-1',
    roles: ['user'],
    expiresAt: Date.now() + 200, // Expires in 200ms
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

  // Login succeeds
  const loginResp = await sendRequest(ws, {
    type: 'auth.login',
    token: 'short-lived',
  });
  expect(loginResp['type']).toBe('result');

  // Wait for session to expire
  await flush(300);

  // Next request is rejected
  const resp = await sendRequest(ws, {
    type: 'store.all',
    bucket: 'users',
  });
  expect(resp['type']).toBe('error');
  expect(resp['code']).toBe('UNAUTHORIZED');
  expect(resp['message']).toBe('Session expired');
});
```

## Timing Cheat Sheet

| Scenario | Pattern |
|----------|---------|
| Wait for a push | `const p = waitForPush(ws, subId)` → mutate → `await store.settle()` → `await p` |
| Assert no push | `const p = expectNoPush(ws, subId)` → mutate → `await store.settle()` → `await p` |
| Multiple pushes from one mutation | Set up all `waitForPush` promises → mutate → `settle()` → `Promise.all(...)` |
| Sequential pushes | Await first push fully, then set up next `waitForPush`, mutate again |
| Connection count after disconnect | `await closeClient(ws)` → `await flush(200)` → assert `server.connectionCount` |

## Exercise

Write a test that:
1. Starts a server with auth enabled
2. Client 1 logs in as `valid-user` and subscribes to `all-users`
3. Client 2 logs in as `valid-admin` and inserts a record
4. Client 1 receives a push with the new record
5. Client 2 unsubscribed client 1's subscription should fail with `NOT_FOUND` (subscriptions are per-connection)

<details>
<summary>Solution</summary>

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

  // Client 1: login + subscribe
  const c1 = await connectClient(server.port);
  clients.push(c1.ws);
  await sendRequest(c1.ws, { type: 'auth.login', token: 'valid-user' });

  const subResp = await sendRequest(c1.ws, {
    type: 'store.subscribe',
    query: 'all-users',
  });
  const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

  // Client 2: login
  const c2 = await connectClient(server.port);
  clients.push(c2.ws);
  await sendRequest(c2.ws, { type: 'auth.login', token: 'valid-admin' });

  // Set up push listener on client 1
  const pushPromise = waitForPush(c1.ws, subscriptionId);

  // Client 2 inserts
  await sendRequest(c2.ws, {
    type: 'store.insert',
    bucket: 'users',
    data: { name: 'AdminInserted' },
  });

  await store.settle();

  // Client 1 receives push
  const push = await pushPromise;
  const results = push['data'] as Record<string, unknown>[];
  expect(results).toHaveLength(1);
  expect(results[0]!['name']).toBe('AdminInserted');

  // Client 2 cannot unsubscribe client 1's subscription
  const unsubResp = await sendRequest(c2.ws, {
    type: 'store.unsubscribe',
    subscriptionId,
  });
  expect(unsubResp['type']).toBe('error');
  expect(unsubResp['code']).toBe('NOT_FOUND');
});
```

</details>

## Summary

- `waitForPush(ws, subscriptionId)` filters by `type === 'push'` and `subscriptionId` — ignores everything else
- `expectNoPush(ws, subscriptionId)` passes when no push arrives within the time window (default 300ms)
- **Always** set up the push listener before the mutation — otherwise the push is lost
- **Always** call `store.settle()` between a mutation and asserting on a push — it waits for query re-evaluation
- Use `Promise.all` to await multiple pushes triggered by a single mutation
- Auth test fixtures (`createAuth`, `validSession`, `adminSession`) simplify repetitive setup
- Auth state is per-connection — test isolation by connecting multiple clients
- `permissions.check(session, operation, resource)` receives the full context for role-based decisions
- Session expiration tests use `expiresAt: Date.now() + N` with `flush()` to simulate time passing

---

Next: [Real-time Dashboard](../12-projects/01-realtime-dashboard.md)
