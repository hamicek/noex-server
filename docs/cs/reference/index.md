# API Reference

Kompletní API reference pro `@hamicek/noex-server`. Každá třída, metoda, typ, konfigurační možnost a protokolová zpráva zdokumentovaná se signaturami a příklady.

## Server

| Modul | Popis |
|-------|-------|
| [NoexServer](./01-noex-server.md) | Hlavní třída serveru — spuštění, zastavení, port, spojení, statistiky |
| [Konfigurace](./02-configuration.md) | Všechna konfigurační rozhraní a jejich výchozí hodnoty |
| [Protokol](./03-protocol.md) | Specifikace WebSocket protokolu — formáty request/response/push zpráv |

## Operace

| Modul | Popis |
|-------|-------|
| [Store operace](./04-store-operations.md) | CRUD, dotazy, agregace a administrační operace nad store |
| [Store subscriptions](./05-store-subscriptions.md) | Reaktivní subscriptions, push notifikace a transakce |
| [Rules operace](./06-rules-operations.md) | Operace rule enginu — události, fakty, subscriptions, statistiky |

## Infrastruktura

| Modul | Popis |
|-------|-------|
| [Autentizace](./07-authentication.md) | Přihlášení, odhlášení, životní cyklus session, oprávnění |
| [Životní cyklus](./08-lifecycle.md) | Heartbeat, backpressure, limity spojení, rate limiting, graceful shutdown |
| [Typy](./09-types.md) | Sdílené typy — ServerStats, ConnectionsStats, ConnectionInfo, ConnectionMetadata |
| [Chyby](./10-errors.md) | ErrorCode enum, třída NoexServerError, formát chybových odpovědí |

## Rychlé odkazy

```typescript
import { NoexServer, ErrorCode, NoexServerError } from '@hamicek/noex-server';
import type { ServerConfig, AuthConfig, AuthSession } from '@hamicek/noex-server';
```

### Spuštění serveru

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'my-store' });
const server = await NoexServer.start({ store, port: 8080 });
```

### Spuštění s autentizací

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => {
      // Vrátí AuthSession nebo null
      return { userId: 'u1', roles: ['admin'] };
    },
  },
});
```

### Graceful zastavení

```typescript
await server.stop({ gracePeriodMs: 5000 });
```
