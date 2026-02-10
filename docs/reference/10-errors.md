# Errors

Error handling in noex-server: error codes, the `NoexServerError` class, and the wire format of error responses.

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

### Error Code Reference

| Code | Description |
|------|-------------|
| `PARSE_ERROR` | Incoming message is not valid JSON or is not a JSON object. |
| `INVALID_REQUEST` | Message is missing required fields (`id`, `type`) or they have invalid types. |
| `UNKNOWN_OPERATION` | The `type` field does not match any known operation. |
| `VALIDATION_ERROR` | Operation parameters failed validation (e.g., missing `bucket`). |
| `NOT_FOUND` | Requested resource was not found (e.g., key does not exist in a bucket). |
| `ALREADY_EXISTS` | Resource already exists (e.g., inserting a duplicate key). |
| `CONFLICT` | Conflict during operation (e.g., transaction conflict). |
| `UNAUTHORIZED` | Authentication is required but the client has not logged in, or the session has expired. |
| `FORBIDDEN` | The client is authenticated but lacks permission for the requested operation. |
| `RATE_LIMITED` | Rate limit exceeded, or per-connection subscription limit reached. |
| `BACKPRESSURE` | Server write buffer is full; the client should slow down. |
| `INTERNAL_ERROR` | Unexpected server-side error. Returned when a non-`NoexServerError` exception is caught. |
| `BUCKET_NOT_DEFINED` | The requested store bucket is not defined in the store configuration. |
| `QUERY_NOT_DEFINED` | The requested named query is not defined. |
| `RULES_NOT_AVAILABLE` | A `rules.*` operation was requested but no rule engine is configured on the server. |

---

## NoexServerError

```typescript
class NoexServerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown);
}
```

Custom error class used internally by the server. When a `NoexServerError` is thrown during request handling, it is serialized to an `ErrorResponse` with the matching `code`, `message`, and `details`. Any other exception results in an `INTERNAL_ERROR` response.

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| code | `ErrorCode` | Machine-readable error code. |
| message | `string` | Human-readable error description. |
| details | `unknown` | Optional structured data (e.g., `{ retryAfterMs }` for rate limiting). |
| name | `string` | Always `'NoexServerError'`. |

**Example:**

```typescript
import { NoexServerError, ErrorCode } from '@hamicek/noex-server';

throw new NoexServerError(
  ErrorCode.VALIDATION_ERROR,
  'Bucket name is required',
  { field: 'bucket' },
);
```

---

## Error Response Format

When an error occurs, the server sends an `ErrorResponse`:

```typescript
interface ErrorResponse {
  readonly id: number;
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}
```

The `id` field matches the `id` of the original `ClientRequest`, so the client can correlate the error with the request that caused it. For parse errors where no valid `id` can be extracted, `id` is `0`.

**Example — wire format:**

```json
{
  "id": 42,
  "type": "error",
  "code": "NOT_FOUND",
  "message": "Key \"user:999\" not found in bucket \"users\"",
  "details": null
}
```

**Example — parse error (id = 0):**

```json
{
  "id": 0,
  "type": "error",
  "code": "PARSE_ERROR",
  "message": "Invalid JSON"
}
```

---

## Error Mapping

The server maps exceptions to error responses using these rules:

1. **`NoexServerError`** — The error's `code`, `message`, and `details` are forwarded directly to the client.
2. **Any other exception** — The server responds with `INTERNAL_ERROR` and a generic `"Internal server error"` message. The original error details are not exposed to the client.

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

## See Also

- [Protocol](./03-protocol.md) — Full protocol specification
- [Configuration](./02-configuration.md) — Server configuration
- [Types](./09-types.md) — Server types
- [Authentication](./07-authentication.md) — Auth error scenarios
