// ── Procedure Engine ─────────────────────────────────────────────
//
// Manages procedure registration and execution.
//

import type { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';
import type {
  ProcedureConfig,
  ProcedureResult,
  ProcedureInfo,
  ExecutionContext,
  ProceduresConfig,
  InputFieldDef,
} from './procedure-types.js';
import { DEFAULT_TIMEOUT_MS } from './procedure-types.js';
import { validateProcedure } from './procedure-validator.js';
import { executeSteps } from './procedure-executor.js';

export class ProcedureNotFoundError extends Error {
  constructor(name: string) {
    super(`Procedure "${name}" not found`);
    this.name = 'ProcedureNotFoundError';
  }
}

export class ProcedureAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Procedure "${name}" already exists`);
    this.name = 'ProcedureAlreadyExistsError';
  }
}

export class ProcedureTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Procedure "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'ProcedureTimeoutError';
  }
}

export class ProcedureInputError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid procedure input: ${issues.join('; ')}`);
    this.name = 'ProcedureInputError';
    this.issues = issues;
  }
}

export class ProcedureEngine {
  readonly #store: Store;
  readonly #rules: RuleEngine | null;
  readonly #procedures = new Map<string, ProcedureConfig>();
  readonly #config: ProceduresConfig;

  constructor(
    store: Store,
    rules?: RuleEngine | null,
    config?: ProceduresConfig,
  ) {
    this.#store = store;
    this.#rules = rules ?? null;
    this.#config = config ?? {};
  }

  register(config: ProcedureConfig): void {
    const validated = validateProcedure(config, this.#config);

    if (this.#procedures.has(validated.name)) {
      throw new ProcedureAlreadyExistsError(validated.name);
    }

    this.#procedures.set(validated.name, validated);
  }

  unregister(name: string): boolean {
    return this.#procedures.delete(name);
  }

  update(name: string, updates: Partial<ProcedureConfig>): void {
    const existing = this.#procedures.get(name);
    if (!existing) {
      throw new ProcedureNotFoundError(name);
    }

    const merged = { ...existing, ...updates, name: existing.name };
    const validated = validateProcedure(merged, this.#config);
    this.#procedures.set(name, validated);
  }

  get(name: string): ProcedureConfig | undefined {
    return this.#procedures.get(name);
  }

  list(): ProcedureInfo[] {
    return [...this.#procedures.values()].map((p) => ({
      name: p.name,
      description: p.description,
      stepsCount: p.steps.length,
    }));
  }

  async call(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ProcedureResult> {
    const procedure = this.#procedures.get(name);
    if (!procedure) {
      throw new ProcedureNotFoundError(name);
    }

    const validatedInput = this.#validateInput(input, procedure.input);
    const timeoutMs = procedure.timeoutMs
      ?? this.#config.defaultTimeoutMs
      ?? DEFAULT_TIMEOUT_MS;

    const ctx: ExecutionContext = {
      input: validatedInput,
      results: new Map(),
    };

    const executionPromise = this.#execute(procedure, ctx);

    const result = await Promise.race([
      executionPromise,
      this.#timeout(name, timeoutMs),
    ]);

    return result;
  }

  async #execute(
    procedure: ProcedureConfig,
    ctx: ExecutionContext,
  ): Promise<ProcedureResult> {
    if (procedure.transaction) {
      await this.#store.transaction(async () => {
        await executeSteps(procedure.steps, ctx, this.#store, this.#rules);
      });
    } else {
      await executeSteps(procedure.steps, ctx, this.#store, this.#rules);
    }

    return {
      success: true,
      result: ctx.returnValue,
      results: Object.fromEntries(ctx.results),
    };
  }

  #timeout(name: string, ms: number): Promise<never> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new ProcedureTimeoutError(name, ms)), ms);
    });
  }

  #validateInput(
    input: Record<string, unknown>,
    schema: Readonly<Record<string, InputFieldDef>> | undefined,
  ): Record<string, unknown> {
    if (!schema) return input;

    const issues: string[] = [];
    const result: Record<string, unknown> = { ...input };

    for (const [key, def] of Object.entries(schema)) {
      const value = input[key];
      const isRequired = def.required !== false;

      if (value === undefined || value === null) {
        if (def.default !== undefined) {
          result[key] = def.default;
        } else if (isRequired) {
          issues.push(`Missing required input "${key}"`);
        }
        continue;
      }

      if (!matchesType(value, def.type)) {
        issues.push(
          `Input "${key}": expected ${def.type}, got ${typeof value}`,
        );
      }
    }

    if (issues.length > 0) {
      throw new ProcedureInputError(issues);
    }

    return result;
  }
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    default: return true;
  }
}
