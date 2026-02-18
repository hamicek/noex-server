// ── Procedure Executor ───────────────────────────────────────────
//
// Executes individual procedure steps against the store and rules engine.
//

import type { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';
import type {
  ProcedureStep,
  ExecutionContext,
  ConditionOperator,
} from './procedure-types.js';
import { resolveValue, resolveRef } from './reference-resolver.js';

export async function executeStep(
  step: ProcedureStep,
  ctx: ExecutionContext,
  store: Store,
  rules: RuleEngine | null,
): Promise<void> {
  if (ctx.returned) return;

  switch (step.action) {
    case 'store.get':
      return executeStoreGet(step, ctx, store);
    case 'store.where':
      return executeStoreWhere(step, ctx, store);
    case 'store.findOne':
      return executeStoreFindOne(step, ctx, store);
    case 'store.insert':
      return executeStoreInsert(step, ctx, store);
    case 'store.update':
      return executeStoreUpdate(step, ctx, store);
    case 'store.delete':
      return executeStoreDelete(step, ctx, store);
    case 'store.count':
      return executeStoreCount(step, ctx, store);
    case 'aggregate':
      return executeAggregate(step, ctx);
    case 'rules.emit':
      return executeRulesEmit(step, ctx, rules);
    case 'rules.setFact':
      return executeRulesSetFact(step, ctx, rules);
    case 'rules.getFact':
      return executeRulesGetFact(step, ctx, rules);
    case 'if':
      return executeCondition(step, ctx, store, rules);
    case 'transform':
      return executeTransform(step, ctx);
    case 'return':
      return executeReturn(step, ctx);
  }
}

export async function executeSteps(
  steps: readonly ProcedureStep[],
  ctx: ExecutionContext,
  store: Store,
  rules: RuleEngine | null,
): Promise<void> {
  for (const step of steps) {
    if (ctx.returned) break;
    await executeStep(step, ctx, store, rules);
  }
}

// ── Store operations ─────────────────────────────────────────────

async function executeStoreGet(
  step: Extract<ProcedureStep, { action: 'store.get' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const key = resolveValue(step.key, ctx);
  const bucket = store.bucket(step.bucket);
  const record = await bucket.get(key);
  ctx.results.set(step.as, record ?? null);
}

async function executeStoreWhere(
  step: Extract<ProcedureStep, { action: 'store.where' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const filter = resolveValue(step.filter, ctx) as Record<string, unknown>;
  const bucket = store.bucket(step.bucket);
  const records = await bucket.where(filter);
  ctx.results.set(step.as, records);
}

async function executeStoreFindOne(
  step: Extract<ProcedureStep, { action: 'store.findOne' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const filter = resolveValue(step.filter, ctx) as Record<string, unknown>;
  const bucket = store.bucket(step.bucket);
  const record = await bucket.findOne(filter);
  ctx.results.set(step.as, record ?? null);
}

async function executeStoreInsert(
  step: Extract<ProcedureStep, { action: 'store.insert' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const data = resolveValue(step.data, ctx) as Record<string, unknown>;
  const bucket = store.bucket(step.bucket);
  const record = await bucket.insert(data);
  if (step.as) {
    ctx.results.set(step.as, record);
  }
}

async function executeStoreUpdate(
  step: Extract<ProcedureStep, { action: 'store.update' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const key = resolveValue(step.key, ctx);
  const data = resolveValue(step.data, ctx) as Record<string, unknown>;
  const bucket = store.bucket(step.bucket);
  const record = await bucket.update(key, data);
  if (step.as) {
    ctx.results.set(step.as, record);
  }
}

async function executeStoreDelete(
  step: Extract<ProcedureStep, { action: 'store.delete' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const key = resolveValue(step.key, ctx);
  const bucket = store.bucket(step.bucket);
  await bucket.delete(key);
}

async function executeStoreCount(
  step: Extract<ProcedureStep, { action: 'store.count' }>,
  ctx: ExecutionContext,
  store: Store,
): Promise<void> {
  const filter = step.filter
    ? resolveValue(step.filter, ctx) as Record<string, unknown>
    : undefined;
  const bucket = store.bucket(step.bucket);
  const count = await bucket.count(filter);
  ctx.results.set(step.as, count);
}

// ── Aggregate ────────────────────────────────────────────────────

function executeAggregate(
  step: Extract<ProcedureStep, { action: 'aggregate' }>,
  ctx: ExecutionContext,
): Promise<void> {
  const source = ctx.results.get(step.source);
  if (!Array.isArray(source)) {
    throw new Error(
      `aggregate: source "${step.source}" is not an array`,
    );
  }

  let result: number;

  switch (step.op) {
    case 'count':
      result = source.length;
      break;

    case 'sum':
      result = source.reduce(
        (acc, item) => acc + (toNumber(item, step.field) ?? 0),
        0,
      );
      break;

    case 'avg': {
      if (source.length === 0) {
        result = 0;
        break;
      }
      const sum = source.reduce(
        (acc, item) => acc + (toNumber(item, step.field) ?? 0),
        0,
      );
      result = sum / source.length;
      break;
    }

    case 'min': {
      const values = source
        .map((item) => toNumber(item, step.field))
        .filter((v): v is number => v !== null);
      result = values.length > 0 ? Math.min(...values) : 0;
      break;
    }

    case 'max': {
      const values = source
        .map((item) => toNumber(item, step.field))
        .filter((v): v is number => v !== null);
      result = values.length > 0 ? Math.max(...values) : 0;
      break;
    }
  }

  ctx.results.set(step.as, result);
  return Promise.resolve();
}

function toNumber(item: unknown, field: string): number | null {
  if (typeof item !== 'object' || item === null) return null;
  const value = (item as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : null;
}

// ── Rules operations ─────────────────────────────────────────────

function executeRulesEmit(
  step: Extract<ProcedureStep, { action: 'rules.emit' }>,
  ctx: ExecutionContext,
  rules: RuleEngine | null,
): Promise<void> {
  if (rules === null) {
    throw new Error('rules.emit: rule engine is not configured');
  }
  const topic = resolveValue(step.topic, ctx) as string;
  const data = step.data
    ? resolveValue(step.data, ctx) as Record<string, unknown>
    : {};
  rules.emit(topic, data);
  return Promise.resolve();
}

function executeRulesSetFact(
  step: Extract<ProcedureStep, { action: 'rules.setFact' }>,
  ctx: ExecutionContext,
  rules: RuleEngine | null,
): Promise<void> {
  if (rules === null) {
    throw new Error('rules.setFact: rule engine is not configured');
  }
  const key = resolveValue(step.key, ctx) as string;
  const value = resolveValue(step.value, ctx);
  rules.setFact(key, value);
  return Promise.resolve();
}

function executeRulesGetFact(
  step: Extract<ProcedureStep, { action: 'rules.getFact' }>,
  ctx: ExecutionContext,
  rules: RuleEngine | null,
): Promise<void> {
  if (rules === null) {
    throw new Error('rules.getFact: rule engine is not configured');
  }
  const key = resolveValue(step.key, ctx) as string;
  const value = rules.getFact(key);
  ctx.results.set(step.as, value ?? null);
  return Promise.resolve();
}

// ── Flow control ─────────────────────────────────────────────────

async function executeCondition(
  step: Extract<ProcedureStep, { action: 'if' }>,
  ctx: ExecutionContext,
  store: Store,
  rules: RuleEngine | null,
): Promise<void> {
  const refValue = resolveRef(step.condition.ref, ctx);
  const conditionValue = step.condition.value !== undefined
    ? resolveValue(step.condition.value, ctx)
    : undefined;

  const matches = evaluateCondition(refValue, step.condition.operator, conditionValue);

  if (matches) {
    await executeSteps(step.then, ctx, store, rules);
  } else if (step.else) {
    await executeSteps(step.else, ctx, store, rules);
  }
}

function evaluateCondition(
  actual: unknown,
  operator: ConditionOperator,
  expected: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return (actual as number) > (expected as number);
    case 'gte':
      return (actual as number) >= (expected as number);
    case 'lt':
      return (actual as number) < (expected as number);
    case 'lte':
      return (actual as number) <= (expected as number);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
  }
}

// ── Transform ────────────────────────────────────────────────────

function executeTransform(
  step: Extract<ProcedureStep, { action: 'transform' }>,
  ctx: ExecutionContext,
): Promise<void> {
  const source = ctx.results.get(step.source);

  switch (step.operation) {
    case 'pluck': {
      if (!Array.isArray(source)) {
        throw new Error(`transform.pluck: source "${step.source}" is not an array`);
      }
      const field = step.args as string;
      ctx.results.set(
        step.as,
        source.map((item) =>
          typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>)[field]
            : undefined,
        ),
      );
      break;
    }

    case 'pick': {
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        throw new Error(`transform.pick: source "${step.source}" is not an object`);
      }
      const fields = step.args as string[];
      const picked: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in (source as Record<string, unknown>)) {
          picked[field] = (source as Record<string, unknown>)[field];
        }
      }
      ctx.results.set(step.as, picked);
      break;
    }

    case 'filter': {
      if (!Array.isArray(source)) {
        throw new Error(`transform.filter: source "${step.source}" is not an array`);
      }
      const filterDef = step.args as Record<string, unknown>;
      const resolvedFilter = resolveValue(filterDef, ctx) as Record<string, unknown>;
      ctx.results.set(
        step.as,
        source.filter((item) => {
          if (typeof item !== 'object' || item === null) return false;
          const record = item as Record<string, unknown>;
          return Object.entries(resolvedFilter).every(
            ([key, val]) => record[key] === val,
          );
        }),
      );
      break;
    }

    case 'map': {
      if (!Array.isArray(source)) {
        throw new Error(`transform.map: source "${step.source}" is not an array`);
      }
      const mapDef = step.args as Record<string, unknown>;
      ctx.results.set(
        step.as,
        source.map((item) => {
          if (typeof item !== 'object' || item === null) return item;
          return { ...(item as Record<string, unknown>), ...resolveValue(mapDef, ctx) as Record<string, unknown> };
        }),
      );
      break;
    }
  }

  return Promise.resolve();
}

// ── Return ───────────────────────────────────────────────────────

function executeReturn(
  step: Extract<ProcedureStep, { action: 'return' }>,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.returnValue = resolveValue(step.value, ctx);
  ctx.returned = true;
  return Promise.resolve();
}
