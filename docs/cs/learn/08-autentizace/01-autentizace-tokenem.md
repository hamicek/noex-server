# Autentizace tokenem

Zabezpečte server pomocí token-based autentizace. Klienti pošlou token přes `auth.login`, server ho validuje vaší vlastní funkcí a vytvoří session.

## Co se naučíte

- `AuthConfig` s funkcí `validate`
- Flow `auth.login` — token na session
- Příznak `required` — blokování neautentizovaných požadavků
- Pole `requiresAuth` ve welcome zprávě
- Struktura `AuthSession`

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession } from '@hamicek/noex-server';

const store = await Store.start({ name: 'auth-demo' });

store.defineBucket('users', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    name: { type: 'string', required: true },
    role: { type: 'string', default: 'user' },
  },
});

const auth: AuthConfig = {
  validate: async (token: string): Promise<AuthSession | null> => {
    // Vaše vlastní validační logika (např. ověření JWT, dotaz do databáze)
    if (token === 'valid-token-alice') {
      return {
        userId: 'alice',
        roles: ['admin'],
        metadata: { email: 'alice@example.com' },
        expiresAt: Date.now() + 3600_000, // 1 hodina
      };
    }
    return null; // Neplatný token
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## AuthConfig

```typescript
interface AuthConfig {
  validate: (token: string) => Promise<AuthSession | null>;
  required?: boolean;        // Výchozí: true pokud je auth nakonfigurován
  permissions?: PermissionConfig;
}
```

- **`validate`** — přijímá token string, vrací `AuthSession` při úspěchu nebo `null` při neúspěchu. Zde implementujete ověření JWT, vyhledání v databázi, kontrolu API klíče atd.
- **`required`** — když `true` (výchozí), všechny ne-auth požadavky vyžadují autentizaci. Když `false`, neautentizovaní klienti mohou stále posílat požadavky.
- **`permissions`** — volitelné kontroly oprávnění per operaci (viz [Oprávnění](./02-opravneni.md))

## AuthSession

Objekt session vrácený funkcí `validate`:

```typescript
interface AuthSession {
  userId: string;
  roles: readonly string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;   // Unix timestamp v milisekundách
}
```

- **`userId`** — unikátní identifikátor uživatele
- **`roles`** — pole rolí pro kontrolu oprávnění
- **`metadata`** — volitelná extra data (email, zobrazované jméno atd.)
- **`expiresAt`** — volitelný timestamp expirace — server ho kontroluje při každém požadavku

## Welcome zpráva

Při připojení klienta server pošle welcome zprávu indikující, zda je autentizace povinná:

```jsonc
← { "type": "welcome",
    "version": "1.0.0",
    "serverTime": 1706745600000,
    "requiresAuth": true }
```

`requiresAuth` je `true` když je `auth` nakonfigurován a `required !== false`.

## auth.login

Odešlete token pro autentizaci:

```jsonc
→ { "id": 1, "type": "auth.login", "token": "valid-token-alice" }

← { "id": 1, "type": "result",
    "data": {
      "userId": "alice",
      "roles": ["admin"],
      "expiresAt": 1706749200000
    } }
```

**Povinná pole:**
- `token` — neprázdný string

### Chyby přihlášení

```jsonc
// Chybějící token
→ { "id": 2, "type": "auth.login" }
← { "id": 2, "type": "error",
    "code": "VALIDATION_ERROR",
    "message": "Missing or invalid \"token\": expected non-empty string" }

// Neplatný token (validate vrátilo null)
→ { "id": 3, "type": "auth.login", "token": "wrong-token" }
← { "id": 3, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Invalid token" }

// Expirovaný token (session.expiresAt < Date.now())
→ { "id": 4, "type": "auth.login", "token": "expired-token" }
← { "id": 4, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Token has expired" }
```

## Povinná vs volitelná autentizace

### Povinná autentizace (výchozí)

Když `required: true`, jakýkoli požadavek mimo `auth.*` bez platné session vrátí `UNAUTHORIZED`:

```jsonc
// Ještě nepřihlášen
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }

// Nejprve se přihlásit
→ { "id": 2, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 2, "type": "result", "data": { "userId": "alice", ... } }

// Teď to funguje
→ { "id": 3, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 3, "type": "result", "data": { ... } }
```

### Volitelná autentizace

S `required: false` mohou neautentizovaní klienti posílat požadavky, ale nemají session:

```typescript
const auth: AuthConfig = {
  validate: async (token) => { /* ... */ },
  required: false,
};
```

```jsonc
// Funguje bez přihlášení
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "result", "data": { ... } }

// Login je stále dostupný pro kontrolu oprávnění
→ { "id": 2, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 2, "type": "result", "data": { "userId": "alice", ... } }
```

## Bez nakonfigurované autentizace

Když `auth` není předán do `NoexServer.start()`, všechny `auth.*` požadavky vrátí `UNKNOWN_OPERATION`:

```jsonc
→ { "id": 1, "type": "auth.login", "token": "abc" }
← { "id": 1, "type": "error",
    "code": "UNKNOWN_OPERATION",
    "message": "Authentication is not configured" }
```

## Kódy chyb

| Kód chyby | Příčina |
|-----------|---------|
| `VALIDATION_ERROR` | Chybějící nebo neplatné pole `token` |
| `UNAUTHORIZED` | Neplatný token, expirovaný token nebo vyžadována autentizace |
| `UNKNOWN_OPERATION` | Auth není na serveru nakonfigurován |

## Praktický příklad

```typescript
const auth: AuthConfig = {
  validate: async (token) => {
    const users: Record<string, AuthSession> = {
      'token-alice': { userId: 'alice', roles: ['admin'] },
      'token-bob':   { userId: 'bob', roles: ['user'] },
    };
    return users[token] ?? null;
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });

// Klient se připojí a obdrží welcome
// ← { "type": "welcome", ..., "requiresAuth": true }

// Přihlášení
const loginResp = await sendRequest(ws, {
  type: 'auth.login',
  token: 'token-alice',
});
console.log(loginResp.data.userId); // "alice"
console.log(loginResp.data.roles);  // ["admin"]

// Teď všechny operace fungují
const getResp = await sendRequest(ws, {
  type: 'store.get',
  bucket: 'users',
  key: 'u1',
});
```

## Cvičení

Vytvořte server s povinnou autentizací. Napište sekvenci ukazující:
1. Klient se připojí a vidí `requiresAuth: true`
2. Požadavek `store.get` selže s `UNAUTHORIZED`
3. `auth.login` s neplatným tokenem selže s `UNAUTHORIZED`
4. `auth.login` s platným tokenem uspěje
5. Stejný `store.get` teď funguje

<details>
<summary>Řešení</summary>

```jsonc
// 1. Klient se připojí
← { "type": "welcome", "version": "1.0.0", "serverTime": ..., "requiresAuth": true }

// 2. Požadavek bez autentizace
→ { "id": 1, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 1, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }

// 3. Špatný token
→ { "id": 2, "type": "auth.login", "token": "wrong" }
← { "id": 2, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Invalid token" }

// 4. Správný token
→ { "id": 3, "type": "auth.login", "token": "valid-token-alice" }
← { "id": 3, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"], "expiresAt": ... } }

// 5. Teď to funguje
→ { "id": 4, "type": "store.get", "bucket": "users", "key": "u1" }
← { "id": 4, "type": "result", "data": { ... } }
```

</details>

## Shrnutí

- Auth konfigurujte pomocí `AuthConfig.validate` — vaše vlastní funkce pro převod tokenu na session
- `auth.login` validuje token a vytvoří session per připojení
- `required: true` (výchozí) blokuje všechny ne-auth požadavky do přihlášení
- `required: false` umožňuje neautentizovaný přístup, ale stále podporuje přihlášení
- Session obsahuje `userId`, `roles`, volitelné `metadata` a `expiresAt`
- Welcome zpráva klientům sdělí, zda je auth povinný přes `requiresAuth`

---

Další: [Oprávnění](./02-opravneni.md)
