import type { ClientRequest } from '../protocol/types.js';
import type { AuthSession, PermissionConfig, PermissionRule } from '../config.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

// ── Permission check ─────────────────────────────────────────────

export function checkPermissions(
  session: AuthSession,
  request: ClientRequest,
  permissions: PermissionConfig,
): void {
  const resource = extractResource(request);

  if (isAllowed(session, request.type, resource, permissions)) return;

  throw new NoexServerError(
    ErrorCode.FORBIDDEN,
    `No permission for ${request.type} on ${resource}`,
  );
}

// ── Evaluation pipeline ──────────────────────────────────────────

export function isAllowed(
  session: AuthSession,
  operation: string,
  resource: string,
  permissions: PermissionConfig,
): boolean {
  // 1. Custom check override
  if (permissions.check !== undefined) {
    const result = permissions.check(session, operation, resource);
    if (typeof result === 'boolean') return result;
    // undefined → fall through to declarative rules
  }

  // 2. Declarative rules — first matching rule wins
  if (permissions.rules !== undefined) {
    for (const rule of permissions.rules) {
      if (!session.roles.includes(rule.role)) continue;
      if (!operationMatches(operation, rule.allow)) continue;
      if (!resourceConstraintsSatisfied(operation, resource, rule)) continue;
      return true;
    }
  }

  // 3. Default
  return (permissions.default ?? 'allow') === 'allow';
}

// ── Pattern matching ─────────────────────────────────────────────

export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

export function operationMatches(
  operation: string,
  patterns: string | readonly string[],
): boolean {
  const list = typeof patterns === 'string' ? [patterns] : patterns;
  return list.some(pattern => matchPattern(pattern, operation));
}

// ── Resource constraints ─────────────────────────────────────────

export function resourceConstraintsSatisfied(
  operation: string,
  resource: string,
  rule: PermissionRule,
): boolean {
  if (rule.buckets !== undefined && operation.startsWith('store.')) {
    return rule.buckets.includes(resource);
  }
  if (rule.topics !== undefined && operation.startsWith('rules.')) {
    return rule.topics.some(topic => matchPattern(topic, resource));
  }
  return true;
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
