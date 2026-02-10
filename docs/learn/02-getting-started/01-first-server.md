# Your First Server

In this chapter you'll install noex-server, create a store with a bucket, and start the server. By the end, you'll have a running WebSocket server that accepts connections and processes CRUD requests.

## What You'll Learn

- How to install `@hamicek/noex-server` and its peer dependencies
- How to create a Store and define a bucket with a schema
- How to start the server with `NoexServer.start()`
- What the server does on startup

## Installation

```bash
npm install @hamicek/noex-server @hamicek/noex @hamicek/noex-store
```

`@hamicek/noex` and `@hamicek/noex-store` are required peer dependencies. The server uses noex for GenServer supervision and noex-store for data management.

If you also want rules engine support:

```bash
npm install @hamicek/noex-rules
```

**Requirements:** Node.js >= 20.

## Creating a Store

Before starting the server, you need a Store instance with at least one bucket:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-app' });

store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    title:  { type: 'string', required: true },
    done:   { type: 'boolean', default: false },
  },
});
```

A **bucket** is a named collection of records. Each bucket has a `key` field (primary key) and a schema that defines field types, required fields, defaults, and auto-generation.

## Starting the Server

```typescript
import { NoexServer } from '@hamicek/noex-server';

const server = await NoexServer.start({
  port: 8080,
  store,
});

console.log(`Server running on ws://localhost:${server.port}`);
```

`NoexServer.start()` is async — it initializes the HTTP server, sets up WebSocket upgrade handling, creates the ConnectionSupervisor, and begins listening.

## What Happens on Startup

1. The HTTP server binds to the configured `port` and `host`
2. A `ConnectionSupervisor` (simple_one_for_one) is created to manage connections
3. The WebSocket upgrade handler is registered
4. If `rateLimit` is configured, a RateLimiter GenServer is started
5. The server is ready to accept connections

## Complete Working Example

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

async function main() {
  // 1. Create the store
  const store = await Store.start({ name: 'todo-app' });

  // 2. Define a bucket
  store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:     { type: 'string', generated: 'uuid' },
      title:  { type: 'string', required: true },
      done:   { type: 'boolean', default: false },
    },
  });

  // 3. Define a reactive query (for subscriptions later)
  store.defineQuery('all-tasks', async (ctx) => ctx.bucket('tasks').all());

  // 4. Start the server
  const server = await NoexServer.start({
    port: 8080,
    store,
  });

  console.log(`Listening on ws://localhost:${server.port}`);
  console.log(`Connections: ${server.connectionCount}`);
  console.log(`Running: ${server.isRunning}`);
}

main();
```

## Server Properties

After starting, the server exposes:

| Property | Type | Description |
|----------|------|-------------|
| `server.port` | `number` | The port the server is listening on |
| `server.connectionCount` | `number` | Current number of active WebSocket connections |
| `server.isRunning` | `boolean` | Whether the server is accepting connections |

The `port` property is especially useful when starting with `port: 0` (random port assignment), which is the recommended pattern for tests.

## Stopping the Server

```typescript
await server.stop();
```

Or with a grace period that notifies clients before closing:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

## Exercise

Create a server with two buckets: `users` (fields: `id`, `name`, `email`, `role` with default `'user'`) and `posts` (fields: `id`, `title`, `body`, `authorId`). Start the server on port 3000.

<details>
<summary>Solution</summary>

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'blog' });

  store.defineBucket('users', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true },
      role:  { type: 'string', default: 'user' },
    },
  });

  store.defineBucket('posts', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      title:    { type: 'string', required: true },
      body:     { type: 'string', required: true },
      authorId: { type: 'string', required: true },
    },
  });

  const server = await NoexServer.start({ port: 3000, store });
  console.log(`Blog server on ws://localhost:${server.port}`);
}

main();
```

</details>

## Summary

- Install `@hamicek/noex-server` with `@hamicek/noex` and `@hamicek/noex-store` as peer dependencies
- Create a Store and define buckets with schemas before starting the server
- `NoexServer.start(config)` returns a running server instance
- The server manages connections through a GenServer supervisor
- Use `server.stop()` for cleanup, optionally with `gracePeriodMs`

---

Next: [Connecting a Client](./02-connecting-client.md)
