# Zpracování chyb

noex-server používá 15 typovaných chybových kódů. Každá chybová response přesně říká, co se pokazilo a jak situaci napravit. Tato kapitola dokumentuje všechny chybové kódy spolu se strategiemi pro obnovu.

## Co se naučíte

- Všech 15 chybových kódů s popisy
- Strukturu chybových response
- Strategie obnovy pro jednotlivé chyby
- Vzory pro zpracování chyb na straně klienta

## Struktura chybové response

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: bucket",
  "details": { "field": "bucket" }
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `id` | `number` | Převzato z requestu (nebo `0` u parse errors) |
| `type` | `"error"` | Vždy `"error"` |
| `code` | `string` | Jeden z 15 chybových kódů |
| `message` | `string` | Popis čitelný pro člověka |
| `details` | `object?` | Nepovinný doplňující kontext |

## Přehled chybových kódů

### Chyby protokolu

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `PARSE_ERROR` | Nevalidní JSON, payload není objekt | Opravte JSON. Response má `id: 0`, protože původní `id` nešlo načíst |
| `INVALID_REQUEST` | Chybí pole `id` nebo `type` | Zahrnujte obě pole do každého requestu |
| `UNKNOWN_OPERATION` | Nerozpoznaný typ operace | Zkontrolujte název operace — platné prefixy: `store.*`, `rules.*`, `auth.*` |

```jsonc
// PARSE_ERROR — invalid JSON
→ not valid json{{{
← { "id": 0, "type": "error", "code": "PARSE_ERROR", "message": "Invalid JSON" }

// INVALID_REQUEST — missing type
→ { "id": 1 }
← { "id": 1, "type": "error", "code": "INVALID_REQUEST", "message": "Missing required field: type" }

// UNKNOWN_OPERATION
→ { "id": 1, "type": "store.fly" }
← { "id": 1, "type": "error", "code": "UNKNOWN_OPERATION", "message": "Unknown operation: store.fly" }
```

### Validační chyby

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `VALIDATION_ERROR` | Chybějící nebo neplatná pole pro danou operaci | Zkontrolujte povinná pole pro konkrétní operaci |
| `BUCKET_NOT_DEFINED` | Bucket s daným názvem neexistuje | Použijte bucket definovaný přes `store.defineBucket()` |
| `QUERY_NOT_DEFINED` | Query s daným názvem neexistuje | Použijte query definovanou přes `store.defineQuery()` |

```jsonc
// VALIDATION_ERROR — missing required bucket field
→ { "id": 1, "type": "store.insert", "data": { "name": "Alice" } }
← { "id": 1, "type": "error", "code": "VALIDATION_ERROR", "message": "Missing required field: bucket" }

// BUCKET_NOT_DEFINED
→ { "id": 1, "type": "store.all", "bucket": "nonexistent" }
← { "id": 1, "type": "error", "code": "BUCKET_NOT_DEFINED", "message": "Bucket not defined: nonexistent" }
```

### Datové chyby

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `NOT_FOUND` | Subscription nenalezena (při unsubscribe) | Ověřte subscriptionId |
| `ALREADY_EXISTS` | Duplicitní primární klíč | Použijte jiný klíč nebo nechte server vygenerovat vlastní |
| `CONFLICT` | Konflikt verzí v transakci | Opakujte transakci s čerstvými daty |

### Chyby autentizace

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `UNAUTHORIZED` | Neautentizováno, nebo token neplatný/expirovaný | Odešlete `auth.login` s platným tokenem |
| `FORBIDDEN` | Autentizováno, ale nedostatečná oprávnění | Použijte token s odpovídajícími rolemi |

```jsonc
// UNAUTHORIZED — not logged in, auth required
→ { "id": 1, "type": "store.all", "bucket": "users" }
← { "id": 1, "type": "error", "code": "UNAUTHORIZED", "message": "Authentication required" }

// FORBIDDEN — logged in but not allowed
→ { "id": 2, "type": "store.clear", "bucket": "users" }
← { "id": 2, "type": "error", "code": "FORBIDDEN", "message": "Permission denied for store.clear on users" }
```

### Rate limiting a backpressure

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `RATE_LIMITED` | Příliš mnoho requestů v aktuálním okně | Počkejte `retryAfterMs` (z details) a opakujte |
| `BACKPRESSURE` | Zápis. buffer serveru pro toto spojení je plný | Zpomalte — snižte počet subscriptions nebo čtěte data méně často |

```jsonc
// RATE_LIMITED
← { "id": 99, "type": "error", "code": "RATE_LIMITED", "message": "Rate limit exceeded",
    "details": { "retryAfterMs": 2000 } }
```

### Infrastrukturní chyby

| Kód | Kdy nastane | Náprava |
|-----|-------------|---------|
| `RULES_NOT_AVAILABLE` | Operace `rules.*`, ale rules engine není nakonfigurován | Nastavte `rules` v ServerConfig |
| `INTERNAL_ERROR` | Neočekávaná chyba serveru | Nahlaste problém; spojení zůstává otevřené |

## Zpracování chyb na straně klienta

Praktický vzor pro zpracování chyb ve vašem klientovi:

```typescript
async function safeRequest(ws: WebSocket, payload: Record<string, unknown>) {
  const response = await sendRequest(ws, payload);

  if (response.type === 'error') {
    switch (response.code) {
      case 'UNAUTHORIZED':
        // Re-authenticate
        await sendRequest(ws, { type: 'auth.login', token: getNewToken() });
        return safeRequest(ws, payload); // Retry

      case 'RATE_LIMITED':
        // Wait and retry
        const delay = response.details?.retryAfterMs ?? 1000;
        await new Promise((r) => setTimeout(r, delay));
        return safeRequest(ws, payload); // Retry

      case 'CONFLICT':
        // Transaction conflict — retry with fresh data
        throw new ConflictError(response.message);

      case 'VALIDATION_ERROR':
      case 'BUCKET_NOT_DEFINED':
      case 'QUERY_NOT_DEFINED':
        // Programming error — fix the code
        throw new Error(`Client error: ${response.code}: ${response.message}`);

      default:
        throw new Error(`Server error: ${response.code}: ${response.message}`);
    }
  }

  return response.data;
}
```

## Přehled strategií obnovy

| Kategorie | Kódy | Strategie |
|-----------|------|-----------|
| **Opravte kód** | `PARSE_ERROR`, `INVALID_REQUEST`, `UNKNOWN_OPERATION`, `VALIDATION_ERROR`, `BUCKET_NOT_DEFINED`, `QUERY_NOT_DEFINED`, `RULES_NOT_AVAILABLE` | Programátorské chyby. Opravte request. |
| **Znovu autentizujte** | `UNAUTHORIZED`, `FORBIDDEN` | Přihlaste se platným tokenem nebo získejte token se správnými rolemi. |
| **Opakujte** | `RATE_LIMITED`, `CONFLICT` | Počkejte a opakujte. `RATE_LIMITED` poskytuje `retryAfterMs`. `CONFLICT` vyžaduje čerstvá data. |
| **Zpomalte** | `BACKPRESSURE` | Snižte frekvenci operací. |
| **Nahlaste** | `INTERNAL_ERROR` | Neočekávaná chyba serveru. Spojení zůstává použitelné. |
| **Ošetřete v logice** | `NOT_FOUND`, `ALREADY_EXISTS` | Očekávané stavy — ošetřete v aplikační logice. |

## Cvičení

Klient obdrží tyto tři chybové response. U každé identifikujte příčinu a napište správný postup obnovy:

```jsonc
← { "id": 3, "type": "error", "code": "BUCKET_NOT_DEFINED", "message": "Bucket not defined: orders" }
← { "id": 7, "type": "error", "code": "RATE_LIMITED", "message": "Rate limit exceeded", "details": { "retryAfterMs": 3000 } }
← { "id": 12, "type": "error", "code": "UNAUTHORIZED", "message": "Session expired" }
```

<details>
<summary>Řešení</summary>

1. **BUCKET_NOT_DEFINED** — Bucket `orders` nebyl na serveru definován přes `store.defineBucket('orders', ...)`. Jedná se o chybu konfigurace na straně serveru. Definujte bucket před jeho použitím.

2. **RATE_LIMITED** — Klient odeslal příliš mnoho requestů. Počkejte 3000ms (hodnota z `retryAfterMs`) a poté request zopakujte.

3. **UNAUTHORIZED** — Platnost autentizační session vypršela. Znovu se autentizujte odesláním `{ type: "auth.login", token: "<fresh-token>" }` a poté zopakujte původní request.

</details>

## Shrnutí

- 15 chybových kódů pokrývajících protokol, validaci, data, autentizaci, rate limiting a infrastrukturu
- Každá chybová response má `code` a `message`; některé obsahují i `details`
- Chyby neukončují spojení — následné requesty stále fungují
- Programátorské chyby (PARSE_ERROR, VALIDATION_ERROR apod.) znamenají opravu kódu
- Přechodné chyby (RATE_LIMITED, CONFLICT) znamenají opakování se strategií
- Chyby autentizace (UNAUTHORIZED, FORBIDDEN) znamenají opětovné přihlášení

---

Další: [Základní CRUD](../04-store-crud/01-zakladni-crud.md)
