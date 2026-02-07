import { ErrorCode } from './codes.js';
import type { ClientRequest } from './types.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ParseRequest {
  readonly ok: true;
  readonly kind: 'request';
  readonly request: ClientRequest;
}

export interface ParsePong {
  readonly ok: true;
  readonly kind: 'pong';
  readonly timestamp: number;
}

export interface ParseFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
}

export type ParseResult = ParseRequest | ParsePong | ParseFailure;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseMessage(raw: string): ParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: ErrorCode.PARSE_ERROR, message: 'Invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: ErrorCode.PARSE_ERROR, message: 'Message must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];

  if (typeof type !== 'string' || type.length === 0) {
    return {
      ok: false,
      code: ErrorCode.INVALID_REQUEST,
      message: 'Message must include non-empty string "type"',
    };
  }

  // Pong is a special system message — no id required
  if (type === 'pong') {
    const timestamp = obj['timestamp'];
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return {
        ok: false,
        code: ErrorCode.INVALID_REQUEST,
        message: 'Pong must include finite numeric "timestamp"',
      };
    }
    return { ok: true, kind: 'pong', timestamp };
  }

  const id = obj['id'];
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    return {
      ok: false,
      code: ErrorCode.INVALID_REQUEST,
      message: 'Request must include finite numeric "id"',
    };
  }

  return { ok: true, kind: 'request', request: obj as unknown as ClientRequest };
}
