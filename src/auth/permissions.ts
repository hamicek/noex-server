import type { ClientRequest } from '../protocol/types.js';
import type { AuthSession, PermissionConfig } from '../config.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── Permission check ─────────────────────────────────────────────

export function checkPermissions(
  session: AuthSession,
  request: ClientRequest,
  permissions: PermissionConfig,
): void {
  const resource = extractResource(request);

  if (!permissions.check(session, request.type, resource)) {
    throw new NoexServerError(
      ErrorCode.FORBIDDEN,
      `No permission for ${request.type} on ${resource}`,
    );
  }
}

// ── Resource extraction ──────────────────────────────────────────

export function extractResource(request: ClientRequest): string {
  const { type } = request;

  if (type.startsWith('store.')) {
    if (type === 'store.subscribe') {
      const query = request['query'];
      if (typeof query === 'string') return query;
    }
    if (type === 'store.unsubscribe') {
      const subscriptionId = request['subscriptionId'];
      if (typeof subscriptionId === 'string') return subscriptionId;
    }
    const bucket = request['bucket'];
    if (typeof bucket === 'string') return bucket;
    return '*';
  }

  if (type.startsWith('rules.')) {
    const topic = request['topic'];
    if (typeof topic === 'string') return topic;
    const key = request['key'];
    if (typeof key === 'string') return key;
    const pattern = request['pattern'];
    if (typeof pattern === 'string') return pattern;
    return '*';
  }

  return '*';
}
