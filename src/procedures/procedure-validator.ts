// ── Procedure Validator ──────────────────────────────────────────
//
// Validates a ProcedureConfig before registration.
//

import type {
  ProcedureConfig,
  ProceduresConfig,
} from './procedure-types.js';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_CONDITION_DEPTH,
} from './procedure-types.js';

export class ProcedureValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Procedure validation failed: ${issues.join('; ')}`);
    this.name = 'ProcedureValidationError';
    this.issues = issues;
  }
}

const VALID_ACTIONS = new Set([
  'store.get', 'store.where', 'store.findOne', 'store.insert',
  'store.update', 'store.delete', 'store.count',
  'aggregate',
  'rules.emit', 'rules.setFact', 'rules.getFact',
  'if', 'transform', 'return',
]);

const VALID_INPUT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
const VALID_AGGREGATE_OPS = new Set(['sum', 'avg', 'min', 'max', 'count']);
const VALID_TRANSFORM_OPS = new Set(['map', 'filter', 'pick', 'pluck']);
const VALID_CONDITION_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists',
]);

export function validateProcedure(
  config: unknown,
  limits?: ProceduresConfig,
): ProcedureConfig {
  const issues: string[] = [];

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new ProcedureValidationError(['Procedure config must be an object']);
  }

  const c = config as Record<string, unknown>;

  // name
  if (typeof c['name'] !== 'string' || c['name'].length === 0) {
    issues.push('Missing or invalid "name": expected non-empty string');
  }

  // description
  if (c['description'] !== undefined && typeof c['description'] !== 'string') {
    issues.push('"description" must be a string');
  }

  // input
  if (c['input'] !== undefined) {
    validateInput(c['input'], issues);
  }

  // transaction
  if (c['transaction'] !== undefined && typeof c['transaction'] !== 'boolean') {
    issues.push('"transaction" must be a boolean');
  }

  // timeoutMs
  if (c['timeoutMs'] !== undefined) {
    if (typeof c['timeoutMs'] !== 'number' || c['timeoutMs'] <= 0) {
      issues.push('"timeoutMs" must be a positive number');
    }
  }

  // steps
  if (!Array.isArray(c['steps'])) {
    issues.push('Missing or invalid "steps": expected array');
  } else if (c['steps'].length === 0) {
    issues.push('"steps" must contain at least one step');
  } else {
    const maxSteps = limits?.maxSteps ?? DEFAULT_MAX_STEPS;
    const totalSteps = countSteps(c['steps'] as unknown[]);
    if (totalSteps > maxSteps) {
      issues.push(`Total step count (${totalSteps}) exceeds maximum (${maxSteps})`);
    }

    const maxDepth = limits?.maxConditionDepth ?? DEFAULT_MAX_CONDITION_DEPTH;
    validateSteps(c['steps'] as unknown[], issues, 'steps', 0, maxDepth);
  }

  if (issues.length > 0) {
    throw new ProcedureValidationError(issues);
  }

  return c as unknown as ProcedureConfig;
}

function validateInput(input: unknown, issues: string[]): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.push('"input" must be an object');
    return;
  }

  for (const [key, def] of Object.entries(input as Record<string, unknown>)) {
    if (typeof def !== 'object' || def === null || Array.isArray(def)) {
      issues.push(`input.${key}: expected field definition object`);
      continue;
    }

    const fieldDef = def as Record<string, unknown>;
    if (!VALID_INPUT_TYPES.has(fieldDef['type'] as string)) {
      issues.push(
        `input.${key}.type: expected one of: ${[...VALID_INPUT_TYPES].join(', ')}`,
      );
    }
  }
}

function validateSteps(
  steps: unknown[],
  issues: string[],
  prefix: string,
  depth: number,
  maxDepth: number,
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;

    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      issues.push(`${path}: expected step object`);
      continue;
    }

    const s = step as Record<string, unknown>;
    const action = s['action'];

    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
      issues.push(
        `${path}.action: expected one of: ${[...VALID_ACTIONS].join(', ')}`,
      );
      continue;
    }

    validateStep(s, action, path, issues, depth, maxDepth);
  }
}

function validateStep(
  s: Record<string, unknown>,
  action: string,
  path: string,
  issues: string[],
  depth: number,
  maxDepth: number,
): void {
  switch (action) {
    case 'store.get':
      requireStepString(s, 'bucket', path, issues);
      requireStepString(s, 'key', path, issues);
      requireStepString(s, 'as', path, issues);
      break;

    case 'store.where':
      requireStepString(s, 'bucket', path, issues);
      requireStepObject(s, 'filter', path, issues);
      requireStepString(s, 'as', path, issues);
      break;

    case 'store.findOne':
      requireStepString(s, 'bucket', path, issues);
      requireStepObject(s, 'filter', path, issues);
      requireStepString(s, 'as', path, issues);
      break;

    case 'store.insert':
      requireStepString(s, 'bucket', path, issues);
      requireStepObject(s, 'data', path, issues);
      if (s['as'] !== undefined) requireStepString(s, 'as', path, issues);
      break;

    case 'store.update':
      requireStepString(s, 'bucket', path, issues);
      requireStepString(s, 'key', path, issues);
      requireStepObject(s, 'data', path, issues);
      if (s['as'] !== undefined) requireStepString(s, 'as', path, issues);
      break;

    case 'store.delete':
      requireStepString(s, 'bucket', path, issues);
      requireStepString(s, 'key', path, issues);
      break;

    case 'store.count':
      requireStepString(s, 'bucket', path, issues);
      if (s['filter'] !== undefined) requireStepObject(s, 'filter', path, issues);
      requireStepString(s, 'as', path, issues);
      break;

    case 'aggregate': {
      requireStepString(s, 'source', path, issues);
      requireStepString(s, 'as', path, issues);
      const op = s['op'];
      if (typeof op !== 'string' || !VALID_AGGREGATE_OPS.has(op)) {
        issues.push(
          `${path}.op: expected one of: ${[...VALID_AGGREGATE_OPS].join(', ')}`,
        );
      }
      if (op !== 'count') {
        requireStepString(s, 'field', path, issues);
      }
      break;
    }

    case 'rules.emit':
      requireStepString(s, 'topic', path, issues);
      if (s['data'] !== undefined) requireStepObject(s, 'data', path, issues);
      break;

    case 'rules.setFact':
      requireStepString(s, 'key', path, issues);
      if (s['value'] === undefined) {
        issues.push(`${path}.value: required`);
      }
      break;

    case 'rules.getFact':
      requireStepString(s, 'key', path, issues);
      requireStepString(s, 'as', path, issues);
      break;

    case 'if':
      validateConditionStep(s, path, issues, depth, maxDepth);
      break;

    case 'transform': {
      requireStepString(s, 'source', path, issues);
      requireStepString(s, 'as', path, issues);
      const operation = s['operation'];
      if (typeof operation !== 'string' || !VALID_TRANSFORM_OPS.has(operation)) {
        issues.push(
          `${path}.operation: expected one of: ${[...VALID_TRANSFORM_OPS].join(', ')}`,
        );
      }
      if (s['args'] === undefined) {
        issues.push(`${path}.args: required`);
      }
      break;
    }

    case 'return':
      if (s['value'] === undefined) {
        issues.push(`${path}.value: required`);
      }
      break;
  }
}

function validateConditionStep(
  s: Record<string, unknown>,
  path: string,
  issues: string[],
  depth: number,
  maxDepth: number,
): void {
  if (depth >= maxDepth) {
    issues.push(`${path}: condition nesting depth exceeds maximum (${maxDepth})`);
    return;
  }

  const condition = s['condition'];
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
    issues.push(`${path}.condition: expected object`);
  } else {
    const c = condition as Record<string, unknown>;
    if (typeof c['ref'] !== 'string' || c['ref'].length === 0) {
      issues.push(`${path}.condition.ref: expected non-empty string`);
    }
    if (typeof c['operator'] !== 'string' || !VALID_CONDITION_OPS.has(c['operator'])) {
      issues.push(
        `${path}.condition.operator: expected one of: ${[...VALID_CONDITION_OPS].join(', ')}`,
      );
    }
  }

  const thenSteps = s['then'];
  if (!Array.isArray(thenSteps) || thenSteps.length === 0) {
    issues.push(`${path}.then: expected non-empty array of steps`);
  } else {
    validateSteps(thenSteps, issues, `${path}.then`, depth + 1, maxDepth);
  }

  if (s['else'] !== undefined) {
    const elseSteps = s['else'];
    if (!Array.isArray(elseSteps) || elseSteps.length === 0) {
      issues.push(`${path}.else: expected non-empty array of steps`);
    } else {
      validateSteps(elseSteps as unknown[], issues, `${path}.else`, depth + 1, maxDepth);
    }
  }
}

/** Count total steps including nested if/then/else branches. */
function countSteps(steps: unknown[]): number {
  let count = 0;
  for (const step of steps) {
    count++;
    if (typeof step === 'object' && step !== null && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      if (s['action'] === 'if') {
        if (Array.isArray(s['then'])) {
          count += countSteps(s['then'] as unknown[]);
        }
        if (Array.isArray(s['else'])) {
          count += countSteps(s['else'] as unknown[]);
        }
      }
    }
  }
  return count;
}

function requireStepString(
  s: Record<string, unknown>,
  field: string,
  path: string,
  issues: string[],
): void {
  const value = s[field];
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${path}.${field}: expected non-empty string`);
  }
}

function requireStepObject(
  s: Record<string, unknown>,
  field: string,
  path: string,
  issues: string[],
): void {
  const value = s[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path}.${field}: expected object`);
  }
}
