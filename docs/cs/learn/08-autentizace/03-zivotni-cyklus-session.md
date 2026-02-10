# Životní cyklus session

Kontrolujte, ukončujte a řešte expiraci autentizovaných sessions.

## Co se naučíte

- `auth.whoami` — inspekce aktuální session
- `auth.logout` — ukončení session
- Expirace session a automatický cleanup
- Re-autentizace po expiraci nebo odhlášení
- Izolace auth stavu per připojení

## Nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { NoexServer, AuthConfig, AuthSession } from '@hamicek/noex-server';

const store = await Store.start({ name: 'session-demo' });

store.defineBucket('notes', {
  key: 'id',
  schema: {
    id:   { type: 'string', generated: 'uuid' },
    text: { type: 'string', required: true },
  },
});

const auth: AuthConfig = {
  validate: async (token) => {
    if (token === 'token-alice') {
      return {
        userId: 'alice',
        roles: ['admin'],
        expiresAt: Date.now() + 3600_000, // 1 hodina od teď
      };
    }
    if (token === 'token-short') {
      return {
        userId: 'bob',
        roles: ['user'],
        expiresAt: Date.now() + 5_000, // Expiruje za 5 sekund
      };
    }
    return null;
  },
  required: true,
};

const server = await NoexServer.start({ store, auth, port: 8080 });
```

## auth.whoami

Inspekce aktuální session bez vedlejších efektů:

```jsonc
// Po přihlášení
→ { "id": 1, "type": "auth.whoami" }
← { "id": 1, "type": "result",
    "data": {
      "authenticated": true,
      "userId": "alice",
      "roles": ["admin"],
      "expiresAt": 1706749200000
    } }
```

Když není autentizován:

```jsonc
→ { "id": 2, "type": "auth.whoami" }
← { "id": 2, "type": "result",
    "data": { "authenticated": false } }
```

**Poznámka:** `auth.whoami` také kontroluje expiraci session. Pokud session expirovala, vymaže ji a vrátí `{ authenticated: false }`:

```jsonc
// Session expirovala od posledního požadavku
→ { "id": 3, "type": "auth.whoami" }
← { "id": 3, "type": "result",
    "data": { "authenticated": false } }
```

## auth.logout

Ukončení aktuální session:

```jsonc
→ { "id": 4, "type": "auth.logout" }
← { "id": 4, "type": "result", "data": { "loggedOut": true } }
```

Po odhlášení:
- Session je vymazána
- Pokud `required: true`, další ne-auth požadavky vrátí `UNAUTHORIZED`
- Klient se může znovu přihlásit pomocí `auth.login`

```jsonc
// Po odhlášení jsou požadavky blokovány (při required: true)
→ { "id": 5, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 5, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Authentication required" }
```

## Expirace session

Když má session nastaveno `expiresAt`, server ho kontroluje při každém požadavku:

```
Login ──▶ Session aktivní ──▶ ... ──▶ expiresAt dosažen
                                          │
                                          ▼
                                    Session vymazána
                                          │
                                          ▼
                                    UNAUTHORIZED
                                    "Session expired"
```

### Expirace při běžných požadavcích

```jsonc
// Přihlášení s krátkodobým tokenem (5 sekund)
→ { "id": 1, "type": "auth.login", "token": "token-short" }
← { "id": 1, "type": "result",
    "data": { "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// Funguje okamžitě
→ { "id": 2, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 2, "type": "result", "data": null }

// Po 5 sekundách...
→ { "id": 3, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 3, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Session expired" }
```

### Expirace při whoami

`auth.whoami` detekuje expiraci a vrátí `authenticated: false` místo vyhození chyby:

```jsonc
// Session expirovala
→ { "id": 4, "type": "auth.whoami" }
← { "id": 4, "type": "result",
    "data": { "authenticated": false } }
```

### Expirace při přihlášení

Pokud `validate` vrátí session kde `expiresAt` je již v minulosti, samotné přihlášení selže:

```jsonc
→ { "id": 5, "type": "auth.login", "token": "already-expired-token" }
← { "id": 5, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Token has expired" }
```

## Re-autentizace

Po odhlášení nebo expiraci session se klient může znovu přihlásit:

```jsonc
// 1. Přihlášení
→ { "id": 1, "type": "auth.login", "token": "token-alice" }
← { "id": 1, "type": "result", "data": { "userId": "alice", ... } }

// 2. Práce...
→ { "id": 2, "type": "store.insert", "bucket": "notes", "data": { "text": "hello" } }
← { "id": 2, "type": "result", "data": { ... } }

// 3. Odhlášení
→ { "id": 3, "type": "auth.logout" }
← { "id": 3, "type": "result", "data": { "loggedOut": true } }

// 4. Opětovné přihlášení (stejný nebo jiný token)
→ { "id": 4, "type": "auth.login", "token": "token-alice" }
← { "id": 4, "type": "result", "data": { "userId": "alice", ... } }

// 5. Pokračování v práci
→ { "id": 5, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 5, "type": "result", "data": { ... } }
```

## Izolace per připojení

Auth stav je uložen per připojení. Dvě WebSocket připojení jsou zcela nezávislá:

```
Připojení A: auth.login("token-alice")  ──▶  session = alice
Připojení B: auth.login("token-bob")    ──▶  session = bob

Připojení A: auth.logout               ──▶  session = null
Připojení B: auth.whoami                ──▶  stále bob ✓
```

- Odhlášení na jednom připojení NEOVLIVNÍ ostatní připojení
- Každé připojení spravuje svou session nezávisle
- Subscriptions patří připojení, ne uživateli

## Kompletní timeline session

```
Připojení
  │
  ▼
← welcome { requiresAuth: true }
  │
  ▼
→ auth.login { token: "..." }
← result { userId, roles, expiresAt }
  │
  ▼
→ store.get / rules.emit / ...     ◀── oprávnění kontrolována zde
← result { ... }
  │
  ▼
→ auth.whoami                      ◀── kontrola, zda stále platí
← result { authenticated: true, ... }
  │
  ... čas plyne ...
  │
  ▼
→ store.get                        ◀── expiresAt < now
← error { UNAUTHORIZED, "Session expired" }
  │
  ▼
→ auth.login { token: "new-token" }   ◀── re-autentizace
← result { userId, roles, expiresAt }
  │
  ▼
→ auth.logout
← result { loggedOut: true }
  │
  ▼
Odpojení (session a subscriptions uklideny)
```

## Kódy chyb

| Kód chyby | Příčina |
|-----------|---------|
| `UNAUTHORIZED` | Neautentizován, session expirovala |
| `UNKNOWN_OPERATION` | Auth není nakonfigurován |

## Praktický příklad

```typescript
// Přihlášení
const loginResp = await sendRequest(ws, {
  type: 'auth.login',
  token: 'token-alice',
});
console.log(loginResp.data.userId);    // "alice"
console.log(loginResp.data.expiresAt); // 1706749200000

// Kontrola session
const whoamiResp = await sendRequest(ws, { type: 'auth.whoami' });
console.log(whoamiResp.data.authenticated); // true
console.log(whoamiResp.data.userId);        // "alice"

// Odhlášení
const logoutResp = await sendRequest(ws, { type: 'auth.logout' });
console.log(logoutResp.data.loggedOut); // true

// Ověření, že session je pryč
const whoami2 = await sendRequest(ws, { type: 'auth.whoami' });
console.log(whoami2.data.authenticated); // false
```

## Cvičení

Napište kompletní scénář životního cyklu session:
1. Připojte se a zkontrolujte `whoami` (neměl by být autentizován)
2. Přihlaste se s tokenem, který expiruje za 5 sekund
3. Ověřte session pomocí `whoami`
4. Počkejte na expiraci tokenu
5. Zkuste store operaci (měla by selhat s `Session expired`)
6. Re-autentizujte se s dlouhodobějším tokenem
7. Ověřte novou session pomocí `whoami`

<details>
<summary>Řešení</summary>

```jsonc
// 1. Kontrola počátečního stavu
→ { "id": 1, "type": "auth.whoami" }
← { "id": 1, "type": "result", "data": { "authenticated": false } }

// 2. Přihlášení s krátkým tokenem
→ { "id": 2, "type": "auth.login", "token": "token-short" }
← { "id": 2, "type": "result",
    "data": { "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// 3. Ověření session
→ { "id": 3, "type": "auth.whoami" }
← { "id": 3, "type": "result",
    "data": { "authenticated": true, "userId": "bob", "roles": ["user"], "expiresAt": 1706745605000 } }

// 4-5. Po 5 sekundách, store požadavek selže
→ { "id": 4, "type": "store.get", "bucket": "notes", "key": "n1" }
← { "id": 4, "type": "error",
    "code": "UNAUTHORIZED",
    "message": "Session expired" }

// 6. Re-autentizace
→ { "id": 5, "type": "auth.login", "token": "token-alice" }
← { "id": 5, "type": "result",
    "data": { "userId": "alice", "roles": ["admin"], "expiresAt": 1706749200000 } }

// 7. Ověření nové session
→ { "id": 6, "type": "auth.whoami" }
← { "id": 6, "type": "result",
    "data": { "authenticated": true, "userId": "alice", "roles": ["admin"], "expiresAt": 1706749200000 } }
```

</details>

## Shrnutí

- `auth.whoami` vrací info o aktuální session — `{ authenticated, userId, roles, expiresAt }`
- `auth.logout` vymaže session — `{ loggedOut: true }`
- Sessions mají volitelný `expiresAt` — server kontroluje expiraci při každém požadavku
- Expirované sessions jsou automaticky vymazány a vrátí `UNAUTHORIZED` ("Session expired")
- `auth.whoami` detekuje expiraci elegantně — vrátí `{ authenticated: false }` místo chyby
- Klienti se mohou re-autentizovat po odhlášení nebo expiraci novým `auth.login`
- Auth stav je per připojení — nezávislá připojení, nezávislé sessions

---

Další: [Architektura](../../09-zivotni-cyklus/01-architektura.md)
