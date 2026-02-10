# Váš první server

V této kapitole nainstalujete noex-server, vytvoříte Store s bucketem a spustíte server. Na konci budete mít běžící WebSocket server, který přijímá spojení a zpracovává CRUD požadavky.

## Co se naučíte

- Jak nainstalovat `@hamicek/noex-server` a jeho peer dependencies
- Jak vytvořit Store a definovat bucket se schématem
- Jak spustit server pomocí `NoexServer.start()`
- Co se děje při startu serveru

## Instalace

```bash
npm install @hamicek/noex-server @hamicek/noex @hamicek/noex-store
```

`@hamicek/noex` a `@hamicek/noex-store` jsou povinné peer dependencies. Server používá noex pro GenServer supervizi a noex-store pro správu dat.

Pokud chcete i podporu rules engine:

```bash
npm install @hamicek/noex-rules
```

**Požadavky:** Node.js >= 20.

## Vytvoření Store

Před spuštěním serveru potřebujete instanci Store s alespoň jedním bucketem:

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

**Bucket** je pojmenovaná kolekce záznamů. Každý bucket má pole `key` (primární klíč) a schema, které definuje typy polí, povinná pole, výchozí hodnoty a automatické generování.

## Spuštění serveru

```typescript
import { NoexServer } from '@hamicek/noex-server';

const server = await NoexServer.start({
  port: 8080,
  store,
});

console.log(`Server running on ws://localhost:${server.port}`);
```

`NoexServer.start()` je asynchronní — inicializuje HTTP server, nastaví WebSocket upgrade handling, vytvoří ConnectionSupervisor a začne naslouchat.

## Co se děje při startu

1. HTTP server se naváže na nakonfigurovaný `port` a `host`
2. Vytvoří se `ConnectionSupervisor` (simple_one_for_one) pro správu spojení
3. Zaregistruje se WebSocket upgrade handler
4. Pokud je nakonfigurován `rateLimit`, spustí se RateLimiter GenServer
5. Server je připraven přijímat spojení

## Kompletní funkční příklad

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

## Vlastnosti serveru

Po spuštění server zpřístupňuje:

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `server.port` | `number` | Port, na kterém server naslouchá |
| `server.connectionCount` | `number` | Aktuální počet aktivních WebSocket spojení |
| `server.isRunning` | `boolean` | Zda server přijímá spojení |

Vlastnost `port` je obzvlášť užitečná při startu s `port: 0` (přiřazení náhodného portu), což je doporučený postup pro testy.

## Zastavení serveru

```typescript
await server.stop();
```

Nebo s odkladem, který upozorní klienty před uzavřením:

```typescript
await server.stop({ gracePeriodMs: 5000 });
```

## Cvičení

Vytvořte server se dvěma buckety: `users` (pole: `id`, `name`, `email`, `role` s výchozí hodnotou `'user'`) a `posts` (pole: `id`, `title`, `body`, `authorId`). Spusťte server na portu 3000.

<details>
<summary>Řešení</summary>

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

## Shrnutí

- Nainstalujte `@hamicek/noex-server` spolu s `@hamicek/noex` a `@hamicek/noex-store` jako peer dependencies
- Před spuštěním serveru vytvořte Store a definujte buckety se schématy
- `NoexServer.start(config)` vrací běžící instanci serveru
- Server spravuje spojení prostřednictvím GenServer supervisoru
- Pro ukončení použijte `server.stop()`, volitelně s `gracePeriodMs`

---

Další: [Připojení klienta](./02-pripojeni-klienta.md)
