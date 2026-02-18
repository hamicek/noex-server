// ── Reference Resolver ───────────────────────────────────────────
//
// Resolves `{{ ... }}` template references in procedure step values.
//
// Supported references:
//   {{ input.orderId }}    → input parameter
//   {{ order }}            → step result stored under 'order'
//   {{ order.total }}      → nested property of step result
//   {{ items.length }}     → array length
//   {{ total }}            → scalar step result
//

import type { ExecutionContext } from './procedure-types.js';

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Resolve a single dotted path against the execution context.
 *
 * Look-up order:
 *  1. `input.<path>` → context.input
 *  2. `<name>` or `<name>.<path>` → context.results
 */
export function resolveRef(path: string, ctx: ExecutionContext): unknown {
  const parts = path.split('.');

  if (parts[0] === 'input') {
    return resolvePath(ctx.input, parts.slice(1));
  }

  const rootName = parts[0]!;
  const root = ctx.results.get(rootName);
  if (parts.length === 1) return root;
  return resolvePath(root, parts.slice(1));
}

function resolvePath(root: unknown, parts: string[]): unknown {
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Resolve all `{{ ... }}` templates in a value.
 *
 * - If the entire value is a single `{{ ref }}` string, it resolves to the
 *   actual JS value (number, object, array, etc.) — NOT stringified.
 * - If the value contains mixed text like `"ID: {{ id }}"`, references are
 *   stringified and interpolated into the string.
 * - Objects and arrays are traversed recursively.
 * - Non-string primitives (number, boolean, null) pass through unchanged.
 */
export function resolveValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === 'string') {
    return resolveStringValue(value, ctx);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, ctx));
  }

  if (typeof value === 'object' && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveValue(val, ctx);
    }
    return resolved;
  }

  return value;
}

function resolveStringValue(str: string, ctx: ExecutionContext): unknown {
  // Fast path: exact match `{{ ref }}` — return the raw JS value
  const exactMatch = str.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exactMatch) {
    return resolveRef(exactMatch[1]!, ctx);
  }

  // Mixed template: interpolate as strings
  if (!TEMPLATE_RE.test(str)) return str;

  TEMPLATE_RE.lastIndex = 0;
  return str.replace(TEMPLATE_RE, (_match, path: string) => {
    const resolved = resolveRef(path.trim(), ctx);
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'object') return JSON.stringify(resolved);
    return String(resolved);
  });
}
