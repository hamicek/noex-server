import type { RuleEngine, RuleInput } from '@hamicek/noex-rules';
import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import { mapRulesError } from './rules-proxy.js';

// ── Validation helpers ────────────────────────────────────────────

function requireString(
  request: ClientRequest,
  field: string,
): string {
  const value = request[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${field}": expected non-empty string`,
    );
  }
  return value;
}

function requireObject(
  request: ClientRequest,
  field: string,
): Record<string, unknown> {
  const value = request[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${field}": expected object`,
    );
  }
  return value as Record<string, unknown>;
}

// ── Admin rules operations ────────────────────────────────────────

export async function handleAdminRulesRequest(
  request: ClientRequest,
  engine: RuleEngine,
): Promise<unknown> {
  try {
    return await dispatchAdminRulesOperation(request, engine);
  } catch (error) {
    if (error instanceof NoexServerError) throw error;
    throw mapRulesError(error);
  }
}

async function dispatchAdminRulesOperation(
  request: ClientRequest,
  engine: RuleEngine,
): Promise<unknown> {
  switch (request.type) {
    case 'rules.registerRule': {
      const ruleInput = requireObject(request, 'rule') as unknown as RuleInput;

      if (engine.getRule(ruleInput.id)) {
        throw new NoexServerError(
          ErrorCode.ALREADY_EXISTS,
          `Rule "${ruleInput.id}" already exists`,
        );
      }

      const rule = engine.registerRule(ruleInput);
      return {
        id: rule.id,
        name: rule.name,
        version: rule.version,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      };
    }

    case 'rules.unregisterRule': {
      const ruleId = requireString(request, 'ruleId');
      const removed = engine.unregisterRule(ruleId);
      if (!removed) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Rule "${ruleId}" not found`,
        );
      }
      return { ruleId, unregistered: true };
    }

    case 'rules.updateRule': {
      const ruleId = requireString(request, 'ruleId');
      const updates = requireObject(request, 'updates') as unknown as Partial<RuleInput>;
      const rule = engine.updateRule(ruleId, updates);
      return {
        id: rule.id,
        version: rule.version,
        updatedAt: rule.updatedAt,
      };
    }

    case 'rules.enableRule': {
      const ruleId = requireString(request, 'ruleId');
      const enabled = engine.enableRule(ruleId);
      if (!enabled) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Rule "${ruleId}" not found`,
        );
      }
      return { ruleId, enabled: true };
    }

    case 'rules.disableRule': {
      const ruleId = requireString(request, 'ruleId');
      const disabled = engine.disableRule(ruleId);
      if (!disabled) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Rule "${ruleId}" not found`,
        );
      }
      return { ruleId, enabled: false };
    }

    case 'rules.getRule': {
      const ruleId = requireString(request, 'ruleId');
      const rule = engine.getRule(ruleId);
      if (!rule) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Rule "${ruleId}" not found`,
        );
      }
      return rule;
    }

    case 'rules.getRules': {
      const rules = engine.getRules().map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        priority: r.priority,
        version: r.version,
        tags: r.tags,
        group: r.group,
      }));
      return { rules };
    }

    case 'rules.validateRule': {
      const ruleInput = requireObject(request, 'rule');
      return engine.validateRule(ruleInput);
    }

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown admin rules operation "${request.type}"`,
      );
  }
}
