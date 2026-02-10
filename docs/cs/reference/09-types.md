# Typy

Sdílené TypeScript typy exportované z `@hamicek/noex-server` pro statistiky serveru a introspekci spojení.

## Import

```typescript
import type {
  ServerStats,
  ConnectionsStats,
  ConnectionInfo,
  ConnectionMetadata,
} from '@hamicek/noex-server';
```

---

## ServerStats

Vrací `server.getStats()`. Poskytuje snapshot stavu běžícího serveru.

```typescript
interface ServerStats {
  readonly name: string;
  readonly port: number;
  readonly host: string;
  readonly connectionCount: number;
  readonly uptimeMs: number;
  readonly authEnabled: boolean;
  readonly rateLimitEnabled: boolean;
  readonly rulesEnabled: boolean;
  readonly connections: ConnectionsStats;
  readonly store: unknown;
  readonly rules: unknown;
}
```

| Název | Typ | Popis |
|-------|-----|-------|
| name | `string` | Název serveru z konfigurace. |
| port | `number` | Port, na kterém server naslouchá. |
| host | `string` | Host, na který je server navázán. |
| connectionCount | `number` | Počet aktivních WebSocket spojení. |
| uptimeMs | `number` | Milisekundy od spuštění serveru. |
| authEnabled | `boolean` | Zda je nakonfigurována autentizace. |
| rateLimitEnabled | `boolean` | Zda je nakonfigurován rate limiting. |
| rulesEnabled | `boolean` | Zda je připojen rule engine. |
| connections | `ConnectionsStats` | Agregované statistiky spojení. |
| store | `unknown` | Statistiky store (tvar závisí na `@hamicek/noex-store`). |
| rules | `unknown` | Statistiky rule enginu, nebo `null` pokud rules nejsou nakonfigurovány. |

**Příklad:**

```typescript
const stats = await server.getStats();

console.log(`Server: ${stats.name}`);
console.log(`Spojení: ${stats.connectionCount}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);
console.log(`Auth: ${stats.authEnabled ? 'zapnuto' : 'vypnuto'}`);
```

---

## ConnectionsStats

Agregované statistiky napříč všemi aktivními spojeními.

```typescript
interface ConnectionsStats {
  readonly active: number;
  readonly authenticated: number;
  readonly totalStoreSubscriptions: number;
  readonly totalRulesSubscriptions: number;
}
```

| Název | Typ | Popis |
|-------|-----|-------|
| active | `number` | Celkový počet aktivních spojení. |
| authenticated | `number` | Spojení, která dokončila autentizaci. |
| totalStoreSubscriptions | `number` | Součet všech aktivních store subscriptions napříč spojeními. |
| totalRulesSubscriptions | `number` | Součet všech aktivních rules subscriptions napříč spojeními. |

---

## ConnectionInfo

Detailní informace o jednom spojení. Vrací `server.getConnections()`.

```typescript
interface ConnectionInfo {
  readonly connectionId: string;
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}
```

| Název | Typ | Popis |
|-------|-----|-------|
| connectionId | `string` | Unikátní identifikátor spojení (např. `"conn-1"`). |
| remoteAddress | `string` | IP adresa klienta. |
| connectedAt | `number` | Unix timestamp (ms) navázání spojení. |
| authenticated | `boolean` | Zda spojení dokončilo autentizaci. |
| userId | `string \| null` | ID uživatele z auth session, nebo `null` pokud neautentizováno. |
| storeSubscriptionCount | `number` | Počet aktivních store subscriptions na tomto spojení. |
| rulesSubscriptionCount | `number` | Počet aktivních rules subscriptions na tomto spojení. |

**Příklad:**

```typescript
const connections = server.getConnections();

for (const conn of connections) {
  console.log(`${conn.connectionId}: ${conn.remoteAddress}`);
  console.log(`  Auth: ${conn.authenticated ? conn.userId : 'anonymní'}`);
  console.log(`  Store subs: ${conn.storeSubscriptionCount}`);
  console.log(`  Rules subs: ${conn.rulesSubscriptionCount}`);
}
```

---

## ConnectionMetadata

Interní metadata sledovaná per spojení v connection registru. Má stejná pole jako `ConnectionInfo` bez `connectionId`.

```typescript
interface ConnectionMetadata {
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}
```

---

## Viz také

- [NoexServer](./01-noex-server.md) — Třída serveru s `getStats()` a `getConnections()`
- [Konfigurace](./02-configuration.md) — Konfigurační typy serveru
- [Chyby](./10-errors.md) — Chybové kódy a třída chyby
- [Životní cyklus](./08-lifecycle.md) — Životní cyklus spojení a monitoring
