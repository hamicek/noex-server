# Oprávnění

Řiďte, co každý autentizovaný uživatel může dělat, pomocí per-operation kontrol oprávnění.

## Co se naučíte

- `PermissionConfig.check` — signatura funkce pro oprávnění
- Jak se `operation` a `resource` extrahují z požadavků
- Vzory přístupu na základě rolí
- Error kód `FORBIDDEN`

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession, PermissionConfig } from '@hamicek/noex-server';

const store = await Store.start({ name: 'permissions-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

store.defineBucket('audit', {
  key: 'id',
  schema: {
    id:     { type: 'string', generated: 'uuid' },
    action: { type: 'string', required: true },
  },
});

const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    // Admini mohou vše
    if (session.roles.includes('admin')) return true;
    // Běžní uživatelé mohou pouze číst
    if (operation === 'store.get' || operation === 'store.all') return true;
    // Vše ostatní zamítnout
    return false;
  },
};

const auth: AuthConfig = {
  validate: async (token) => {
    const users: Record<string, AuthSession> = {
      'token-admin': { userId: 'alice', roles: ['admin'] },
      'token-user':  { userId: 'bob', roles: ['user'] },
    };
    return users[token] ?? null;
  },
  required: true,
  permissions,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## PermissionConfig

```typescript
interface PermissionConfig {
  check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

- **`session`** — session autentizovaného uživatele (`userId`, `roles`, `metadata`)
- **`operation`** — typ zprávy (např. `"store.insert"`, `"rules.emit"`)
- **`resource`** — extrahovaný z požadavku (viz níže)
- **Vrací** `true` pro povolení, `false` pro zamítnutí

Funkce `check` je volána při každém požadavku **po** autentizaci. Je volána pouze když:
1. `permissions` je nakonfigurován v `AuthConfig`
2. Uživatel má aktivní session

## Extrakce resource

Parametr `resource` je extrahován z požadavku na základě typu operace:

### Store operace

| Operace | Resource | Fallback |
|---------|----------|----------|
| `store.subscribe` | `query` (název dotazu) | `"*"` |
| `store.unsubscribe` | `subscriptionId` | `"*"` |
| Ostatní `store.*` | `bucket` | `"*"` |

### Rules operace

| Operace | Resource | Fallback |
|---------|----------|----------|
| `rules.emit` | `topic` | `"*"` |
| `rules.setFact`, `rules.getFact`, `rules.deleteFact` | `key` | `"*"` |
| `rules.queryFacts`, `rules.subscribe` | `pattern` | `"*"` |
| `rules.getAllFacts`, `rules.stats` | — | `"*"` |

### Ostatní operace

Všechny ostatní operace používají `"*"` jako resource.

## Chyba FORBIDDEN

Když `check` vrátí `false`, server odpoví `FORBIDDEN`:

```jsonc
// Bob (role: "user") se pokusí vložit
→ { "id": 1, "type": "store.insert", "bucket": "users",
    "data": { "name": "Charlie" } }
← { "id": 1, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.insert on users" }
```

Chybová zpráva obsahuje operaci i resource pro ladění.

## Vzory přístupu na základě rolí

### Jednoduchá kontrola rolí

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;
    if (session.roles.includes('user')) {
      return operation.startsWith('store.get') || operation === 'store.all';
    }
    return false;
  },
};
```

### Oprávnění na úrovni bucketu

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;

    // Uživatelé mohou číst jakýkoli bucket, ale zapisovat pouze do svých dat
    if (operation === 'store.get' || operation === 'store.all') return true;

    // Pouze manažeři mohou zapisovat do bucketu "audit"
    if (resource === 'audit') return session.roles.includes('manager');

    return session.roles.includes('editor');
  },
};
```

### Allowlist operací

```typescript
const ROLE_PERMISSIONS: Record<string, Set<string>> = {
  admin:  new Set(['*']),
  editor: new Set(['store.get', 'store.all', 'store.insert', 'store.update', 'store.where']),
  viewer: new Set(['store.get', 'store.all', 'store.where', 'store.count']),
};

const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    for (const role of session.roles) {
      const allowed = ROLE_PERMISSIONS[role];
      if (allowed?.has('*') || allowed?.has(operation)) return true;
    }
    return false;
  },
};
```

## Kompletní flow auth + oprávnění

```
Požadavek klienta
      │
      ▼
┌─────────────────┐
│ Je auth povinný  │──▶ Ano ──▶ Autentizován? ──▶ Ne ──▶ UNAUTHORIZED
│ a není auth.*?   │                │
└─────────────────┘               Ano
                                   │
                                   ▼
                          ┌──────────────┐
                          │ Expirace      │──▶ Expiroval? ──▶ Ano ──▶ UNAUTHORIZED
                          │ session?      │
                          └──────┬───────┘
                                 │ Ne
                                 ▼
                          ┌──────────────┐
                          │ Oprávnění     │──▶ check() = false ──▶ FORBIDDEN
                          │ nakonfig.?    │
                          └──────┬───────┘
                                 │ check() = true
                                 ▼
                          Zpracovat požadavek
```

## Kódy chyb

| Kód chyby | Příčina |
|-----------|---------|
| `FORBIDDEN` | `permissions.check()` vrátilo `false` |
| `UNAUTHORIZED` | Neautentizován (při `required: true`) nebo session expirovala |

## Praktický příklad

```typescript
// Přihlášení jako admin
await sendRequest(ws, { type: 'auth.login', token: 'token-admin' });

// Admin může vkládat
const insertResp = await sendRequest(ws, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Charlie' },
});
console.log(insertResp.data.name); // "Charlie"

// Přihlášení jako běžný uživatel (na jiném připojení)
await sendRequest(ws2, { type: 'auth.login', token: 'token-user' });

// Uživatel může číst
const getResp = await sendRequest(ws2, {
  type: 'store.get',
  bucket: 'users',
  key: insertResp.data.id,
});
console.log(getResp.data.name); // "Charlie"

// Uživatel nemůže vkládat
const failResp = await sendRequest(ws2, {
  type: 'store.insert',
  bucket: 'users',
  data: { name: 'Denied' },
});
console.log(failResp.code); // "FORBIDDEN"
```

## Cvičení

Implementujte systém oprávnění, kde:
1. Role `admin` může dělat vše
2. Role `editor` může číst a zapisovat do bucketu `users`, ale nemůže mazat
3. Role `viewer` může pouze číst (get, all, where, count)

Pak ukažte požadavky od každé role demonstrující povolené a zamítnuté operace.

<details>
<summary>Řešení</summary>

```typescript
const permissions: PermissionConfig = {
  check: (session, operation, resource) => {
    if (session.roles.includes('admin')) return true;

    if (session.roles.includes('editor')) {
      if (operation === 'store.delete') return false;
      return true;
    }

    if (session.roles.includes('viewer')) {
      const readOps = new Set(['store.get', 'store.all', 'store.where', 'store.count', 'store.findOne']);
      return readOps.has(operation);
    }

    return false;
  },
};
```

```jsonc
// Editor: vložení funguje
→ { "id": 1, "type": "store.insert", "bucket": "users", "data": { "name": "Alice" } }
← { "id": 1, "type": "result", "data": { "id": "a1", "name": "Alice", ... } }

// Editor: mazání zamítnuto
→ { "id": 2, "type": "store.delete", "bucket": "users", "key": "a1" }
← { "id": 2, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.delete on users" }

// Viewer: čtení funguje
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "a1" }
← { "id": 3, "type": "result", "data": { "id": "a1", "name": "Alice", ... } }

// Viewer: vložení zamítnuto
→ { "id": 4, "type": "store.insert", "bucket": "users", "data": { "name": "Bob" } }
← { "id": 4, "type": "error",
    "code": "FORBIDDEN",
    "message": "No permission for store.insert on users" }
```

</details>

## Shrnutí

- `PermissionConfig.check(session, operation, resource)` — vraťte `true` pro povolení, `false` pro zamítnutí
- `operation` je typ zprávy (např. `store.insert`, `rules.emit`)
- `resource` je extrahován z požadavku: bucket, topic, key, pattern nebo `"*"`
- Oprávnění se kontrolují **po** autentizaci — vyžaduje aktivní session
- `FORBIDDEN` obsahuje operaci a resource v chybové zprávě
- Běžné vzory: na základě rolí, na úrovni bucketu, allowlist operací

---

Další: [Životní cyklus session](./03-zivotni-cyklus-session.md)
