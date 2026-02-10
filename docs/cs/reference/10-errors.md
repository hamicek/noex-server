# Chyby

Zpracování chyb v noex-server: chybové kódy, třída `NoexServerError` a formát chybových odpovědí na drátě.

## Import

```typescript
import { ErrorCode, NoexServerError } from '@hamicek/noex-server';
```

## ErrorCode

```typescript
const ErrorCode = {
  PARSE_ERROR: 'PARSE_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNKNOWN_OPERATION: 'UNKNOWN_OPERATION',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  BACKPRESSURE: 'BACKPRESSURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BUCKET_NOT_DEFINED: 'BUCKET_NOT_DEFINED',
  QUERY_NOT_DEFINED: 'QUERY_NOT_DEFINED',
  RULES_NOT_AVAILABLE: 'RULES_NOT_AVAILABLE',
} as const;

type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

### Přehled chybových kódů

| Kód | Popis |
|-----|-------|
| `PARSE_ERROR` | Příchozí zpráva není platný JSON nebo není JSON objekt. |
| `INVALID_REQUEST` | Zpráva neobsahuje povinná pole (`id`, `type`) nebo mají neplatné typy. |
| `UNKNOWN_OPERATION` | Pole `type` neodpovídá žádné známé operaci. |
| `VALIDATION_ERROR` | Parametry operace neprošly validací (např. chybějící `bucket`). |
| `NOT_FOUND` | Požadovaný zdroj nebyl nalezen (např. klíč neexistuje v bucketu). |
| `ALREADY_EXISTS` | Zdroj již existuje (např. vložení duplicitního klíče). |
| `CONFLICT` | Konflikt při operaci (např. transakční konflikt). |
| `UNAUTHORIZED` | Autentizace je vyžadována, ale klient se nepřihlásil, nebo session vypršela. |
| `FORBIDDEN` | Klient je autentizovaný, ale nemá oprávnění pro požadovanou operaci. |
| `RATE_LIMITED` | Překročen rate limit nebo limit počtu subscriptions na spojení. |
| `BACKPRESSURE` | Zápis do bufferu serveru je plný; klient by měl zpomalit. |
| `INTERNAL_ERROR` | Neočekávaná chyba na straně serveru. Vrací se, když je zachycena výjimka, která není `NoexServerError`. |
| `BUCKET_NOT_DEFINED` | Požadovaný store bucket není definován v konfiguraci store. |
| `QUERY_NOT_DEFINED` | Požadovaný pojmenovaný dotaz není definován. |
| `RULES_NOT_AVAILABLE` | Byla požadována operace `rules.*`, ale na serveru není nakonfigurován rule engine. |

---

## NoexServerError

```typescript
class NoexServerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown);
}
```

Vlastní třída chyby používaná interně serverem. Když je `NoexServerError` vyhozena při zpracování požadavku, je serializována do `ErrorResponse` s odpovídajícím `code`, `message` a `details`. Jakákoliv jiná výjimka vede k odpovědi `INTERNAL_ERROR`.

**Vlastnosti:**

| Název | Typ | Popis |
|-------|-----|-------|
| code | `ErrorCode` | Strojově čitelný chybový kód. |
| message | `string` | Lidsky čitelný popis chyby. |
| details | `unknown` | Volitelná strukturovaná data (např. `{ retryAfterMs }` pro rate limiting). |
| name | `string` | Vždy `'NoexServerError'`. |

**Příklad:**

```typescript
import { NoexServerError, ErrorCode } from '@hamicek/noex-server';

throw new NoexServerError(
  ErrorCode.VALIDATION_ERROR,
  'Bucket name is required',
  { field: 'bucket' },
);
```

---

## Formát chybové odpovědi

Při výskytu chyby server odesílá `ErrorResponse`:

```typescript
interface ErrorResponse {
  readonly id: number;
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}
```

Pole `id` odpovídá `id` původního `ClientRequest`, takže klient může přiřadit chybu k požadavku, který ji způsobil. Pro chyby parsování, kde nelze extrahovat platné `id`, je `id` rovno `0`.

**Příklad — formát na drátě:**

```json
{
  "id": 42,
  "type": "error",
  "code": "NOT_FOUND",
  "message": "Key \"user:999\" not found in bucket \"users\"",
  "details": null
}
```

**Příklad — chyba parsování (id = 0):**

```json
{
  "id": 0,
  "type": "error",
  "code": "PARSE_ERROR",
  "message": "Invalid JSON"
}
```

---

## Mapování chyb

Server mapuje výjimky na chybové odpovědi podle těchto pravidel:

1. **`NoexServerError`** — `code`, `message` a `details` chyby jsou přeposlány přímo klientovi.
2. **Jakákoliv jiná výjimka** — Server odpoví `INTERNAL_ERROR` a generickou zprávou `"Internal server error"`. Původní detaily chyby nejsou klientovi odhaleny.

```
Client Request
  → checkAuth()        → UNAUTHORIZED / FORBIDDEN
  → checkRateLimit()   → RATE_LIMITED
  → routeRequest()     → UNKNOWN_OPERATION / VALIDATION_ERROR / NOT_FOUND / ...
  → catch(error)
      NoexServerError  → ErrorResponse(error.code, error.message, error.details)
      other            → ErrorResponse(INTERNAL_ERROR, "Internal server error")
```

---

## Viz také

- [Protokol](./03-protocol.md) — Kompletní specifikace protokolu
- [Konfigurace](./02-configuration.md) — Konfigurace serveru
- [Typy](./09-types.md) — Typy serveru
- [Autentizace](./07-authentication.md) — Chybové scénáře autentizace
