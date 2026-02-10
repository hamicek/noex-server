# Autentizace

Systém autentizace a autorizace klientů. Autentizace je volitelná — pokud je `auth` v `ServerConfig` vynechán, všechny auth operace vrací `UNKNOWN_OPERATION`. Při konfiguraci server validuje tokeny pomocí uživatelem poskytnuté funkce `validate` a vynucuje kontroly oprávnění na úrovni jednotlivých požadavků.

## Import

```typescript
import { NoexServer } from '@hamicek/noex-server';
import type { AuthConfig, AuthSession, PermissionConfig } from '@hamicek/noex-server';
```

---

## Operace

### auth.login

```
{ id, type: "auth.login", token: string }
```

Autentizuje spojení pomocí bearer tokenu. Server zavolá `AuthConfig.validate(token)` pro získání session. Pokud je token validní a nevypršel, spojení se stane autentizovaným a všechny následující požadavky jsou autorizovány v rámci vrácené session.

Re-autentizace je podporována — odeslání `auth.login` při již existující autentizaci nahradí aktuální session.

**Parametry:**

| Název | Typ | Povinný | Popis |
|-------|-----|---------|-------|
| token | `string` | ano | Neprázdný autentizační token předaný funkci `AuthConfig.validate`. |

**Návratová hodnota:** `{ userId: string, roles: string[], expiresAt: number | null }`

**Chyby:**

| Kód | Podmínka |
|-----|----------|
| `VALIDATION_ERROR` | Token chybí, je prázdný nebo není řetězec. |
| `UNAUTHORIZED` | `validate` vrátil `null` (neplatný token). |
| `UNAUTHORIZED` | `expiresAt` session je v minulosti (token již vypršel). |
| `UNKNOWN_OPERATION` | Autentizace není na serveru nakonfigurována. |

**Příklad:**

```typescript
// Klient posílá:
{ id: 1, type: "auth.login", token: "eyJhbGciOiJIUzI1NiIs..." }

// Server odpovídá (úspěch):
{
  id: 1,
  type: "result",
  data: {
    userId: "user-1",
    roles: ["user"],
    expiresAt: 1700000000000
  }
}

// Server odpovídá (neplatný token):
{ id: 1, type: "error", code: "UNAUTHORIZED", message: "Invalid token" }
```

---

### auth.logout

```
{ id, type: "auth.logout" }
```

Vymaže aktuální session a nastaví spojení jako neautentizované. Po odhlášení budou požadavky na chráněné operace dostávat chyby `UNAUTHORIZED`, dokud se klient znovu nepřihlásí.

Volání `auth.logout` bez aktivní autentizace je no-op — stále vrací `{ loggedOut: true }`.

**Parametry:** Žádné.

**Návratová hodnota:** `{ loggedOut: true }`

**Chyby:**

| Kód | Podmínka |
|-----|----------|
| `UNKNOWN_OPERATION` | Autentizace není na serveru nakonfigurována. |

**Příklad:**

```typescript
// Klient posílá:
{ id: 2, type: "auth.logout" }

// Server odpovídá:
{ id: 2, type: "result", data: { loggedOut: true } }
```

---

### auth.whoami

```
{ id, type: "auth.whoami" }
```

Vrátí informace o aktuální session. Pokud session od posledního požadavku vypršela, je automaticky vymazána a vrátí se `{ authenticated: false }`.

**Parametry:** Žádné.

**Návratová hodnota (autentizovaný):** `{ authenticated: true, userId: string, roles: string[], expiresAt: number | null }`

**Návratová hodnota (neautentizovaný):** `{ authenticated: false }`

**Chyby:**

| Kód | Podmínka |
|-----|----------|
| `UNKNOWN_OPERATION` | Autentizace není na serveru nakonfigurována. |

**Příklad:**

```typescript
// Autentizovaný:
{ id: 3, type: "result", data: { authenticated: true, userId: "user-1", roles: ["user"], expiresAt: null } }

// Neautentizovaný:
{ id: 3, type: "result", data: { authenticated: false } }
```

---

## Životní cyklus session

### Průběh spojení

1. Klient se připojí — obdrží `WelcomeMessage` s `requiresAuth: true` (nebo `false` když `auth.required` je `false`).
2. Klient odešle `auth.login` s tokenem.
3. Server zavolá `AuthConfig.validate(token)` — asynchronní funkci poskytnutou aplikací.
4. Pokud je token platný, session se uloží na spojení. Všechny následující požadavky jsou kontrolovány proti ní.
5. Při každém požadavku server kontroluje `expiresAt` — pokud session vypršela, je vymazána a vrátí se `UNAUTHORIZED`.
6. Klient se může kdykoli znovu autentizovat novým `auth.login`.
7. Klient se může odhlásit pomocí `auth.logout`.

### Expirace session

Pole `expiresAt` v `AuthSession` je volitelný Unix timestamp (milisekundy). Když je nastaveno:

- Při `auth.login`: pokud `expiresAt < Date.now()`, přihlášení je odmítnuto s `"Token has expired"`.
- Při následných požadavcích: pokud session od poslední kontroly vypršela, je vymazána a vrátí se `"Session expired"`.
- Při `auth.whoami`: vypršené session jsou detekovány a vrátí se `{ authenticated: false }`.

Pokud je `expiresAt` vynechán, session nikdy nevyprší.

### Volitelná autentizace

Když je `AuthConfig.required` nastaveno na `false`:

- Welcome zpráva hlásí `requiresAuth: false`.
- Neautentizovaní klienti mohou přistupovat ke všem operacím.
- Klienti se stále mohou přihlásit pro navázání session (užitečné pro funkce založené na oprávněních).
- Kontroly oprávnění se aplikují pouze pokud session existuje.

---

## Oprávnění

### PermissionConfig

Když je `AuthConfig.permissions` poskytnuto, každý ne-auth požadavek od autentizovaného klienta je před provedením zkontrolován funkcí `check`.

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

**Parametry předané funkci `check`:**

| Název | Typ | Popis |
|-------|-----|-------|
| session | `AuthSession` | Aktuální autentizovaná session. |
| operation | `string` | Typ požadavku, např. `"store.insert"`, `"rules.emit"`. |
| resource | `string` | Extrahovaný identifikátor prostředku (viz Extrakce prostředků níže). |

**Vrací:** `true` pro povolení, `false` pro zamítnutí s `FORBIDDEN`.

**Příklad:**

```typescript
const server = await NoexServer.start({
  store,
  auth: {
    validate: async (token) => { /* ... */ },
    permissions: {
      check: (session, operation, resource) => {
        // Administrátoři mohou vše
        if (session.roles.includes('admin')) return true;
        // Běžní uživatelé nemohou mazat buckety
        if (operation === 'store.clear') return false;
        return true;
      },
    },
  },
});
```

### Extrakce prostředků

Řetězec prostředku je automaticky extrahován z požadavku na základě namespace operace:

| Namespace | Logika extrakce | Příklad |
|-----------|----------------|---------|
| `store.*` | `request.bucket`, nebo `request.query` pro `store.subscribe`, nebo `request.subscriptionId` pro `store.unsubscribe`. Výchozí `"*"`. | `"users"` |
| `rules.*` | `request.topic`, `request.key` nebo `request.pattern` (v tomto pořadí). Výchozí `"*"`. | `"user:created"` |
| Ostatní | Vždy `"*"`. | `"*"` |

---

## Typy

### AuthConfig

```typescript
interface AuthConfig {
  readonly validate: (token: string) => Promise<AuthSession | null>;
  readonly required?: boolean;
  readonly permissions?: PermissionConfig;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| validate | `(token: string) => Promise<AuthSession \| null>` | — | Asynchronní funkce validující token a vracející session, nebo `null` pro neplatné tokeny. |
| required | `boolean` | `true` | Zda je autentizace vyžadována před přístupem k operacím. |
| permissions | `PermissionConfig` | — | Volitelná funkce kontroly oprávnění pro jednotlivé požadavky. |

### AuthSession

```typescript
interface AuthSession {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}
```

| Pole | Typ | Povinný | Popis |
|------|-----|---------|-------|
| userId | `string` | ano | Unikátní identifikátor uživatele. Používá se jako klíč rate limiteru při autentizaci. |
| roles | `readonly string[]` | ano | Uživatelské role, předané funkci kontroly oprávnění. |
| metadata | `Record<string, unknown>` | ne | Libovolná metadata připojená k session. |
| expiresAt | `number` | ne | Unix timestamp (ms) kdy session vyprší. Vynechte pro session bez expirace. |

### PermissionConfig

```typescript
interface PermissionConfig {
  readonly check: (
    session: AuthSession,
    operation: string,
    resource: string,
  ) => boolean;
}
```

---

## Viz také

- [Konfigurace](./02-configuration.md) — ServerConfig s polem AuthConfig
- [Protokol](./03-protocol.md) — WelcomeMessage s příznakem `requiresAuth`
- [Chyby](./10-errors.md) — Chybové kódy UNAUTHORIZED, FORBIDDEN, VALIDATION_ERROR
- [Životní cyklus](./08-lifecycle.md) — Rate limiting používá `userId` jako klíč po autentizaci
