import type { RuleEngine } from '@hamicek/noex-rules';
import { RuleValidationError } from '@hamicek/noex-rules';
import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import { generateSubscriptionId } from './query-subscription-map.js';

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

// ── Error mapping ─────────────────────────────────────────────────

export function mapRulesError(error: unknown): NoexServerError {
  if (error instanceof NoexServerError) return error;

  if (error instanceof RuleValidationError) {
    return new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      error.message,
      error.details,
    );
  }

  // Fallback: match by error name for cross-module-boundary resilience
  // (instanceof fails when multiple copies of @hamicek/noex-rules are resolved)
  if (error instanceof Error) {
    if (error.name === 'RuleValidationError') {
      return new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        error.message,
        (error as unknown as Record<string, unknown>)['details'],
      );
    }
    if (error.message.includes('is not running')) {
      return new NoexServerError(
        ErrorCode.RULES_NOT_AVAILABLE,
        error.message,
      );
    }
    return new NoexServerError(
      ErrorCode.INTERNAL_ERROR,
      error.message,
    );
  }

  return new NoexServerError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred',
  );
}

// ── Rules operations ──────────────────────────────────────────────

export async function handleRulesRequest(
  request: ClientRequest,
  engine: RuleEngine,
): Promise<unknown> {
  try {
    return await dispatchRulesOperation(request, engine);
  } catch (error) {
    throw mapRulesError(error);
  }
}

async function dispatchRulesOperation(
  request: ClientRequest,
  engine: RuleEngine,
): Promise<unknown> {
  switch (request.type) {
    case 'rules.emit': {
      const topic = requireString(request, 'topic');
      const data = (request['data'] as Record<string, unknown> | undefined) ?? {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid "data": expected object',
        );
      }
      const correlationId = request['correlationId'];
      if (correlationId !== undefined && correlationId !== null) {
        if (typeof correlationId !== 'string' || correlationId.length === 0) {
          throw new NoexServerError(
            ErrorCode.VALIDATION_ERROR,
            'Invalid "correlationId": expected non-empty string',
          );
        }
        const causationId = request['causationId'] as string | undefined;
        return engine.emitCorrelated(topic, data, correlationId, causationId);
      }
      return engine.emit(topic, data);
    }

    case 'rules.setFact': {
      const key = requireString(request, 'key');
      const value = request['value'];
      if (value === undefined) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          'Missing "value": expected a value',
        );
      }
      return engine.setFact(key, value);
    }

    case 'rules.getFact': {
      const key = requireString(request, 'key');
      return engine.getFact(key) ?? null;
    }

    case 'rules.deleteFact': {
      const key = requireString(request, 'key');
      return { deleted: engine.deleteFact(key) };
    }

    case 'rules.queryFacts': {
      const pattern = requireString(request, 'pattern');
      return engine.queryFacts(pattern);
    }

    case 'rules.getAllFacts': {
      return engine.getAllFacts();
    }

    case 'rules.stats': {
      return engine.getStats();
    }

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown rules operation "${request.type}"`,
      );
  }
}

// ── Subscription operations ──────────────────────────────────────

export function handleRulesSubscribe(
  request: ClientRequest,
  engine: RuleEngine,
  subscriptions: Map<string, () => void>,
  onPush: (subscriptionId: string, data: unknown) => void,
): { subscriptionId: string } {
  try {
    const pattern = requireString(request, 'pattern');
    const subscriptionId = generateSubscriptionId();

    const unsub = engine.subscribe(pattern, (event, topic) => {
      if (subscriptions.has(subscriptionId)) {
        onPush(subscriptionId, { topic, event });
      }
    });

    subscriptions.set(subscriptionId, unsub);

    return { subscriptionId };
  } catch (error) {
    throw mapRulesError(error);
  }
}

export function handleRulesUnsubscribe(
  request: ClientRequest,
  subscriptions: Map<string, () => void>,
): { unsubscribed: true } {
  const subscriptionId = requireString(request, 'subscriptionId');
  const unsub = subscriptions.get(subscriptionId);

  if (!unsub) {
    throw new NoexServerError(
      ErrorCode.NOT_FOUND,
      `Subscription "${subscriptionId}" not found`,
    );
  }

  unsub();
  subscriptions.delete(subscriptionId);
  return { unsubscribed: true };
}
