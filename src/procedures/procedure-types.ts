// ── Procedure Types ──────────────────────────────────────────────

export interface InputFieldDef {
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly required?: boolean;
  readonly default?: unknown;
}

export interface ProcedureConfig {
  readonly name: string;
  readonly description?: string;
  readonly input?: Readonly<Record<string, InputFieldDef>>;
  readonly steps: readonly ProcedureStep[];
  readonly transaction?: boolean;
  readonly timeoutMs?: number;
}

// ── Step types ───────────────────────────────────────────────────

export type ProcedureStep =
  | StoreGetStep
  | StoreWhereStep
  | StoreFindOneStep
  | StoreInsertStep
  | StoreUpdateStep
  | StoreDeleteStep
  | StoreCountStep
  | AggregateStep
  | RulesEmitStep
  | RulesSetFactStep
  | RulesGetFactStep
  | ConditionStep
  | TransformStep
  | ReturnStep;

// ── Store steps ──────────────────────────────────────────────────

export interface StoreGetStep {
  readonly action: 'store.get';
  readonly bucket: string;
  readonly key: string;
  readonly as: string;
}

export interface StoreWhereStep {
  readonly action: 'store.where';
  readonly bucket: string;
  readonly filter: Readonly<Record<string, unknown>>;
  readonly as: string;
}

export interface StoreFindOneStep {
  readonly action: 'store.findOne';
  readonly bucket: string;
  readonly filter: Readonly<Record<string, unknown>>;
  readonly as: string;
}

export interface StoreInsertStep {
  readonly action: 'store.insert';
  readonly bucket: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly as?: string;
}

export interface StoreUpdateStep {
  readonly action: 'store.update';
  readonly bucket: string;
  readonly key: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly as?: string;
}

export interface StoreDeleteStep {
  readonly action: 'store.delete';
  readonly bucket: string;
  readonly key: string;
}

export interface StoreCountStep {
  readonly action: 'store.count';
  readonly bucket: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly as: string;
}

// ── Aggregate step ───────────────────────────────────────────────

export interface AggregateStep {
  readonly action: 'aggregate';
  readonly source: string;
  readonly field: string;
  readonly op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  readonly as: string;
}

// ── Rules steps ──────────────────────────────────────────────────

export interface RulesEmitStep {
  readonly action: 'rules.emit';
  readonly topic: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RulesSetFactStep {
  readonly action: 'rules.setFact';
  readonly key: string;
  readonly value: unknown;
}

export interface RulesGetFactStep {
  readonly action: 'rules.getFact';
  readonly key: string;
  readonly as: string;
}

// ── Flow control ─────────────────────────────────────────────────

export interface ConditionStep {
  readonly action: 'if';
  readonly condition: {
    readonly ref: string;
    readonly operator: ConditionOperator;
    readonly value?: unknown;
  };
  readonly then: readonly ProcedureStep[];
  readonly else?: readonly ProcedureStep[];
}

export type ConditionOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'exists' | 'not_exists';

export interface TransformStep {
  readonly action: 'transform';
  readonly source: string;
  readonly operation: 'map' | 'filter' | 'pick' | 'pluck';
  readonly args: unknown;
  readonly as: string;
}

// ── Output ───────────────────────────────────────────────────────

export interface ReturnStep {
  readonly action: 'return';
  readonly value: unknown;
}

// ── Result types ─────────────────────────────────────────────────

export interface ProcedureResult {
  readonly success: boolean;
  readonly result?: unknown;
  readonly results: Readonly<Record<string, unknown>>;
}

export interface ProcedureInfo {
  readonly name: string;
  readonly description: string | undefined;
  readonly stepsCount: number;
}

// ── Execution context ────────────────────────────────────────────

export interface ExecutionContext {
  readonly input: Readonly<Record<string, unknown>>;
  readonly results: Map<string, unknown>;
  returnValue?: unknown;
  returned?: boolean;
}

// ── Config ───────────────────────────────────────────────────────

export interface ProceduresConfig {
  readonly maxSteps?: number;
  readonly maxConditionDepth?: number;
  readonly defaultTimeoutMs?: number;
}

export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_MAX_CONDITION_DEPTH = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;
