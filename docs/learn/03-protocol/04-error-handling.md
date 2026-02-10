# Error Handling

noex-server uses 15 typed error codes. Every error response tells you exactly what went wrong and how to recover. This chapter documents all error codes with recovery strategies.

## What You'll Learn

- All 15 error codes with descriptions
- The structure of error responses
- Recovery strategies for each error
- Client-side error handling patterns

## Error Response Structure

```jsonc
{
  "id": 1,
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Missing required field: bucket",
  "details": { "field": "bucket" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Echoed from the request (or `0` for parse errors) |
| `type` | `"error"` | Always `"error"` |
| `code` | `string` | One of 15 error codes |
| `message` | `string` | Human-readable description |
| `details` | `object?` | Optional additional context |

## Error Code Reference

### Protocol Errors

| Code | When | Recovery |
|------|------|----------|
| `PARSE_ERROR` | Invalid JSON, non-object payload | Fix the JSON. Response has `id: 0` since the original `id` couldn't be parsed |
| `INVALID_REQUEST` | Missing `id` or `type` field | Include both fields in every request |
| `UNKNOWN_OPERATION` | Unrecognized operation type | Check the operation name — valid prefixes: `store.*`, `rules.*`, `auth.*` |

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

### Validation Errors

| Code | When | Recovery |
|------|------|----------|
| `VALIDATION_ERROR` | Missing or invalid fields for the operation | Check required fields for the specific operation |
| `BUCKET_NOT_DEFINED` | Bucket name doesn't exist | Use a bucket defined with `store.defineBucket()` |
| `QUERY_NOT_DEFINED` | Query name doesn't exist | Use a query defined with `store.defineQuery()` |

```jsonc
// VALIDATION_ERROR — missing required bucket field
→ { "id": 1, "type": "store.insert", "data": { "name": "Alice" } }
← { "id": 1, "type": "error", "code": "VALIDATION_ERROR", "message": "Missing required field: bucket" }

// BUCKET_NOT_DEFINED
→ { "id": 1, "type": "store.all", "bucket": "nonexistent" }
← { "id": 1, "type": "error", "code": "BUCKET_NOT_DEFINED", "message": "Bucket not defined: nonexistent" }
```

### Data Errors

| Code | When | Recovery |
|------|------|----------|
| `NOT_FOUND` | Subscription not found (for unsubscribe) | Verify the subscriptionId |
| `ALREADY_EXISTS` | Duplicate primary key | Use a different key or let the server generate one |
| `CONFLICT` | Version conflict in a transaction | Retry the transaction with fresh data |

### Auth Errors

| Code | When | Recovery |
|------|------|----------|
| `UNAUTHORIZED` | Not authenticated, or token invalid/expired | Send `auth.login` with a valid token |
| `FORBIDDEN` | Authenticated but insufficient permissions | Use a token with appropriate roles |

```jsonc
// UNAUTHORIZED — not logged in, auth required
→ { "id": 1, "type": "store.all", "bucket": "users" }
← { "id": 1, "type": "error", "code": "UNAUTHORIZED", "message": "Authentication required" }

// FORBIDDEN — logged in but not allowed
→ { "id": 2, "type": "store.clear", "bucket": "users" }
← { "id": 2, "type": "error", "code": "FORBIDDEN", "message": "Permission denied for store.clear on users" }
```

### Rate Limiting & Backpressure

| Code | When | Recovery |
|------|------|----------|
| `RATE_LIMITED` | Too many requests in the current window | Wait for `retryAfterMs` (from details) and retry |
| `BACKPRESSURE` | Server write buffer full for this connection | Slow down — reduce subscription count or read data less frequently |

```jsonc
// RATE_LIMITED
← { "id": 99, "type": "error", "code": "RATE_LIMITED", "message": "Rate limit exceeded",
    "details": { "retryAfterMs": 2000 } }
```

### Infrastructure Errors

| Code | When | Recovery |
|------|------|----------|
| `RULES_NOT_AVAILABLE` | `rules.*` operation but no rules engine configured | Configure `rules` in ServerConfig |
| `INTERNAL_ERROR` | Unexpected server error | Report the issue; the connection remains open |

## Client-Side Error Handling

A practical pattern for handling errors in your client:

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

## Error Recovery Summary

| Category | Codes | Strategy |
|----------|-------|----------|
| **Fix your code** | `PARSE_ERROR`, `INVALID_REQUEST`, `UNKNOWN_OPERATION`, `VALIDATION_ERROR`, `BUCKET_NOT_DEFINED`, `QUERY_NOT_DEFINED`, `RULES_NOT_AVAILABLE` | These are programming errors. Fix the request. |
| **Re-authenticate** | `UNAUTHORIZED`, `FORBIDDEN` | Login with a valid token or obtain a token with correct roles. |
| **Retry** | `RATE_LIMITED`, `CONFLICT` | Wait and retry. `RATE_LIMITED` provides `retryAfterMs`. `CONFLICT` requires fresh data. |
| **Back off** | `BACKPRESSURE` | Reduce the rate of operations. |
| **Report** | `INTERNAL_ERROR` | Unexpected server bug. The connection remains usable. |
| **Handle in logic** | `NOT_FOUND`, `ALREADY_EXISTS` | Expected conditions — handle in your application logic. |

## Exercise

A client receives these three error responses. For each, identify the cause and write the correct recovery action:

```jsonc
← { "id": 3, "type": "error", "code": "BUCKET_NOT_DEFINED", "message": "Bucket not defined: orders" }
← { "id": 7, "type": "error", "code": "RATE_LIMITED", "message": "Rate limit exceeded", "details": { "retryAfterMs": 3000 } }
← { "id": 12, "type": "error", "code": "UNAUTHORIZED", "message": "Session expired" }
```

<details>
<summary>Solution</summary>

1. **BUCKET_NOT_DEFINED** — The bucket `orders` hasn't been defined on the server with `store.defineBucket('orders', ...)`. This is a server-side configuration error. Define the bucket before using it.

2. **RATE_LIMITED** — The client sent too many requests. Wait 3000ms (from `retryAfterMs`), then retry the request.

3. **UNAUTHORIZED** — The auth session has expired. Re-authenticate by sending `{ type: "auth.login", token: "<fresh-token>" }`, then retry the original request.

</details>

## Summary

- 15 error codes covering protocol, validation, data, auth, rate limiting, and infrastructure
- Every error response has `code` and `message`; some include `details`
- Errors don't break the connection — subsequent requests still work
- Programming errors (PARSE_ERROR, VALIDATION_ERROR, etc.) mean fix the code
- Transient errors (RATE_LIMITED, CONFLICT) mean retry with a strategy
- Auth errors (UNAUTHORIZED, FORBIDDEN) mean re-authenticate

---

Next: [Basic CRUD](../04-store-crud/01-basic-crud.md)
