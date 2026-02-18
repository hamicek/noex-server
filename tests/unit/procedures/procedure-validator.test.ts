import { describe, it, expect } from 'vitest';
import { validateProcedure, ProcedureValidationError } from '../../../src/procedures/procedure-validator.js';

// ── Helpers ──────────────────────────────────────────────────────

function minimal(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'test-proc',
    steps: [
      { action: 'store.get', bucket: 'orders', key: '{{ input.id }}', as: 'order' },
    ],
    ...overrides,
  };
}

function expectIssues(config: unknown, ...fragments: string[]): void {
  try {
    validateProcedure(config);
    expect.fail('Expected ProcedureValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ProcedureValidationError);
    const issues = (error as ProcedureValidationError).issues;
    for (const fragment of fragments) {
      expect(issues.some((i) => i.includes(fragment))).toBe(true);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('procedure-validator', () => {
  // ── Valid configs ───────────────────────────────────────────

  describe('valid configs', () => {
    it('accepts minimal config', () => {
      const result = validateProcedure(minimal());
      expect(result.name).toBe('test-proc');
      expect(result.steps).toHaveLength(1);
    });

    it('accepts full config', () => {
      const result = validateProcedure({
        name: 'full-proc',
        description: 'A full procedure',
        input: {
          orderId: { type: 'string', required: true },
          count: { type: 'number', required: false, default: 1 },
        },
        steps: [
          { action: 'store.get', bucket: 'orders', key: '{{ input.orderId }}', as: 'order' },
          { action: 'store.where', bucket: 'items', filter: { orderId: '{{ input.orderId }}' }, as: 'items' },
          { action: 'aggregate', source: 'items', field: 'price', op: 'sum', as: 'total' },
        ],
        transaction: true,
        timeoutMs: 5000,
      });
      expect(result.name).toBe('full-proc');
      expect(result.steps).toHaveLength(3);
      expect(result.transaction).toBe(true);
    });

    it('accepts all store step types', () => {
      const result = validateProcedure({
        name: 'store-steps',
        steps: [
          { action: 'store.get', bucket: 'b', key: 'k', as: 'r1' },
          { action: 'store.where', bucket: 'b', filter: { x: 1 }, as: 'r2' },
          { action: 'store.findOne', bucket: 'b', filter: { x: 1 }, as: 'r3' },
          { action: 'store.insert', bucket: 'b', data: { x: 1 } },
          { action: 'store.insert', bucket: 'b', data: { x: 1 }, as: 'r4' },
          { action: 'store.update', bucket: 'b', key: 'k', data: { x: 2 } },
          { action: 'store.update', bucket: 'b', key: 'k', data: { x: 2 }, as: 'r5' },
          { action: 'store.delete', bucket: 'b', key: 'k' },
          { action: 'store.count', bucket: 'b', as: 'r6' },
          { action: 'store.count', bucket: 'b', filter: { x: 1 }, as: 'r7' },
        ],
      });
      expect(result.steps).toHaveLength(10);
    });

    it('accepts all aggregate ops', () => {
      for (const op of ['sum', 'avg', 'min', 'max']) {
        const result = validateProcedure({
          name: `agg-${op}`,
          steps: [{ action: 'aggregate', source: 'items', field: 'price', op, as: 'result' }],
        });
        expect(result.steps).toHaveLength(1);
      }
    });

    it('accepts aggregate count without field', () => {
      const result = validateProcedure({
        name: 'agg-count',
        steps: [{ action: 'aggregate', source: 'items', op: 'count', as: 'result' }],
      });
      expect(result.steps).toHaveLength(1);
    });

    it('accepts rules steps', () => {
      const result = validateProcedure({
        name: 'rules-steps',
        steps: [
          { action: 'rules.emit', topic: 'order.created', data: { id: '1' } },
          { action: 'rules.emit', topic: 'order.created' },
          { action: 'rules.setFact', key: 'user:1:active', value: true },
          { action: 'rules.getFact', key: 'user:1:active', as: 'isActive' },
        ],
      });
      expect(result.steps).toHaveLength(4);
    });

    it('accepts condition step', () => {
      const result = validateProcedure({
        name: 'condition',
        steps: [
          {
            action: 'if',
            condition: { ref: 'order.total', operator: 'gte', value: 1000 },
            then: [
              { action: 'rules.emit', topic: 'big.order' },
            ],
            else: [
              { action: 'rules.emit', topic: 'small.order' },
            ],
          },
        ],
      });
      expect(result.steps).toHaveLength(1);
    });

    it('accepts transform steps', () => {
      const result = validateProcedure({
        name: 'transforms',
        steps: [
          { action: 'transform', source: 'items', operation: 'pluck', args: 'price', as: 'prices' },
          { action: 'transform', source: 'order', operation: 'pick', args: ['id', 'total'], as: 'summary' },
          { action: 'transform', source: 'items', operation: 'filter', args: { active: true }, as: 'activeItems' },
          { action: 'transform', source: 'items', operation: 'map', args: { processed: true }, as: 'processed' },
        ],
      });
      expect(result.steps).toHaveLength(4);
    });

    it('accepts return step', () => {
      const result = validateProcedure({
        name: 'return-test',
        steps: [
          { action: 'return', value: { status: 'ok', total: '{{ total }}' } },
        ],
      });
      expect(result.steps).toHaveLength(1);
    });

    it('accepts all input types', () => {
      for (const type of ['string', 'number', 'boolean', 'object', 'array']) {
        const result = validateProcedure({
          name: `input-${type}`,
          input: { field: { type } },
          steps: [{ action: 'store.get', bucket: 'b', key: 'k', as: 'r' }],
        });
        expect(result.input).toBeDefined();
      }
    });
  });

  // ── Invalid configs ─────────────────────────────────────────

  describe('invalid configs', () => {
    it('rejects non-object config', () => {
      expectIssues('not-an-object', 'must be an object');
      expectIssues(null, 'must be an object');
      expectIssues([], 'must be an object');
    });

    it('rejects missing name', () => {
      expectIssues({ steps: [{ action: 'store.get', bucket: 'b', key: 'k', as: 'r' }] }, '"name"');
    });

    it('rejects empty name', () => {
      expectIssues(minimal({ name: '' }), '"name"');
    });

    it('rejects non-string description', () => {
      expectIssues(minimal({ description: 123 }), '"description"');
    });

    it('rejects non-boolean transaction', () => {
      expectIssues(minimal({ transaction: 'yes' }), '"transaction"');
    });

    it('rejects non-positive timeoutMs', () => {
      expectIssues(minimal({ timeoutMs: 0 }), '"timeoutMs"');
      expectIssues(minimal({ timeoutMs: -1 }), '"timeoutMs"');
      expectIssues(minimal({ timeoutMs: 'fast' }), '"timeoutMs"');
    });

    it('rejects missing steps', () => {
      expectIssues({ name: 'test' }, '"steps"');
    });

    it('rejects empty steps array', () => {
      expectIssues(minimal({ steps: [] }), 'at least one step');
    });

    it('rejects non-array steps', () => {
      expectIssues(minimal({ steps: 'bad' }), '"steps"');
    });

    it('rejects invalid input field type', () => {
      expectIssues(minimal({ input: { x: { type: 'invalid' } } }), 'input.x.type');
    });

    it('rejects non-object input', () => {
      expectIssues(minimal({ input: 'bad' }), '"input" must be an object');
    });

    it('rejects non-object input field def', () => {
      expectIssues(minimal({ input: { x: 'string' } }), 'input.x');
    });
  });

  // ── Step validation ─────────────────────────────────────────

  describe('step validation', () => {
    it('rejects non-object step', () => {
      expectIssues(minimal({ steps: ['not-an-object'] }), 'expected step object');
    });

    it('rejects unknown action', () => {
      expectIssues(
        minimal({ steps: [{ action: 'unknown.op' }] }),
        'action',
      );
    });

    it('rejects store.get without bucket', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.get', key: 'k', as: 'r' }] }),
        'bucket',
      );
    });

    it('rejects store.get without key', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.get', bucket: 'b', as: 'r' }] }),
        'key',
      );
    });

    it('rejects store.get without as', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.get', bucket: 'b', key: 'k' }] }),
        'as',
      );
    });

    it('rejects store.where without filter', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.where', bucket: 'b', as: 'r' }] }),
        'filter',
      );
    });

    it('rejects store.insert without data', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.insert', bucket: 'b' }] }),
        'data',
      );
    });

    it('rejects store.update without key', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.update', bucket: 'b', data: {} }] }),
        'key',
      );
    });

    it('rejects store.update without data', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.update', bucket: 'b', key: 'k' }] }),
        'data',
      );
    });

    it('rejects store.delete without key', () => {
      expectIssues(
        minimal({ steps: [{ action: 'store.delete', bucket: 'b' }] }),
        'key',
      );
    });

    it('rejects aggregate with invalid op', () => {
      expectIssues(
        minimal({ steps: [{ action: 'aggregate', source: 's', field: 'f', op: 'invalid', as: 'r' }] }),
        'op',
      );
    });

    it('rejects aggregate sum without field', () => {
      expectIssues(
        minimal({ steps: [{ action: 'aggregate', source: 's', op: 'sum', as: 'r' }] }),
        'field',
      );
    });

    it('rejects rules.emit without topic', () => {
      expectIssues(
        minimal({ steps: [{ action: 'rules.emit' }] }),
        'topic',
      );
    });

    it('rejects rules.setFact without key', () => {
      expectIssues(
        minimal({ steps: [{ action: 'rules.setFact', value: true }] }),
        'key',
      );
    });

    it('rejects rules.setFact without value', () => {
      expectIssues(
        minimal({ steps: [{ action: 'rules.setFact', key: 'k' }] }),
        'value',
      );
    });

    it('rejects rules.getFact without as', () => {
      expectIssues(
        minimal({ steps: [{ action: 'rules.getFact', key: 'k' }] }),
        'as',
      );
    });

    it('rejects transform with invalid operation', () => {
      expectIssues(
        minimal({ steps: [{ action: 'transform', source: 's', operation: 'bad', args: [], as: 'r' }] }),
        'operation',
      );
    });

    it('rejects transform without args', () => {
      expectIssues(
        minimal({ steps: [{ action: 'transform', source: 's', operation: 'pluck', as: 'r' }] }),
        'args',
      );
    });

    it('rejects return without value', () => {
      expectIssues(
        minimal({ steps: [{ action: 'return' }] }),
        'value',
      );
    });
  });

  // ── Condition validation ────────────────────────────────────

  describe('condition step validation', () => {
    it('rejects if without condition', () => {
      expectIssues(
        minimal({
          steps: [{ action: 'if', then: [{ action: 'rules.emit', topic: 't' }] }],
        }),
        'condition',
      );
    });

    it('rejects if with invalid condition operator', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'invalid' },
            then: [{ action: 'rules.emit', topic: 't' }],
          }],
        }),
        'operator',
      );
    });

    it('rejects if without ref', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { operator: 'eq', value: 1 },
            then: [{ action: 'rules.emit', topic: 't' }],
          }],
        }),
        'ref',
      );
    });

    it('rejects if without then', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 1 },
          }],
        }),
        'then',
      );
    });

    it('rejects if with empty then', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 1 },
            then: [],
          }],
        }),
        'then',
      );
    });

    it('rejects if with empty else', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 1 },
            then: [{ action: 'rules.emit', topic: 't' }],
            else: [],
          }],
        }),
        'else',
      );
    });

    it('validates nested steps in then', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 1 },
            then: [{ action: 'store.get' }],
          }],
        }),
        'bucket',
      );
    });

    it('validates nested steps in else', () => {
      expectIssues(
        minimal({
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 1 },
            then: [{ action: 'rules.emit', topic: 't' }],
            else: [{ action: 'store.get' }],
          }],
        }),
        'bucket',
      );
    });
  });

  // ── Limits ──────────────────────────────────────────────────

  describe('limits', () => {
    it('rejects when total steps exceed maxSteps', () => {
      const manySteps = Array.from({ length: 11 }, (_, i) => ({
        action: 'store.get', bucket: 'b', key: `k${i}`, as: `r${i}`,
      }));
      try {
        validateProcedure({ name: 'test', steps: manySteps }, { maxSteps: 10 });
        expect.fail('Expected ProcedureValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcedureValidationError);
        expect((error as ProcedureValidationError).issues.some(
          (i) => i.includes('exceeds maximum'),
        )).toBe(true);
      }
    });

    it('respects custom maxSteps limit', () => {
      const steps = Array.from({ length: 5 }, (_, i) => ({
        action: 'store.get', bucket: 'b', key: `k${i}`, as: `r${i}`,
      }));
      // Should succeed with higher limit
      const result = validateProcedure({ name: 'test', steps }, { maxSteps: 10 });
      expect(result.steps).toHaveLength(5);

      // Should fail with lower limit
      try {
        validateProcedure({ name: 'test', steps }, { maxSteps: 3 });
        expect.fail('Expected ProcedureValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcedureValidationError);
        expect((error as ProcedureValidationError).issues.some(
          (i) => i.includes('exceeds maximum'),
        )).toBe(true);
      }
    });

    it('counts nested if steps toward total', () => {
      const steps = [
        { action: 'store.get', bucket: 'b', key: 'k1', as: 'r1' },
        {
          action: 'if',
          condition: { ref: 'x', operator: 'eq', value: 1 },
          then: Array.from({ length: 5 }, (_, i) => ({
            action: 'store.get', bucket: 'b', key: `tk${i}`, as: `tr${i}`,
          })),
          else: Array.from({ length: 5 }, (_, i) => ({
            action: 'store.get', bucket: 'b', key: `ek${i}`, as: `er${i}`,
          })),
        },
      ];
      // Total: 1 (get) + 1 (if) + 5 (then) + 5 (else) = 12
      try {
        validateProcedure({ name: 'test', steps }, { maxSteps: 10 });
        expect.fail('Expected ProcedureValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcedureValidationError);
        expect((error as ProcedureValidationError).issues.some(
          (i) => i.includes('exceeds maximum'),
        )).toBe(true);
      }
    });

    it('rejects condition depth exceeding maxConditionDepth', () => {
      // Build nested if chain 3 levels deep
      const deepIf: Record<string, unknown> = {
        action: 'if',
        condition: { ref: 'x', operator: 'eq', value: 1 },
        then: [{
          action: 'if',
          condition: { ref: 'x', operator: 'eq', value: 2 },
          then: [{
            action: 'if',
            condition: { ref: 'x', operator: 'eq', value: 3 },
            then: [{ action: 'rules.emit', topic: 't' }],
          }],
        }],
      };

      // Should succeed with default depth (5)
      const result = validateProcedure({ name: 'test', steps: [deepIf] });
      expect(result.steps).toHaveLength(1);

      // Should fail with low depth limit
      try {
        validateProcedure({ name: 'test', steps: [deepIf] }, { maxConditionDepth: 2 });
        expect.fail('Expected error');
      } catch (error) {
        expect(error).toBeInstanceOf(ProcedureValidationError);
        expect((error as ProcedureValidationError).issues.some(
          (i) => i.includes('nesting depth'),
        )).toBe(true);
      }
    });
  });

  // ── All condition operators ─────────────────────────────────

  describe('accepts all condition operators', () => {
    const ops = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'];
    for (const op of ops) {
      it(`accepts operator "${op}"`, () => {
        const result = validateProcedure({
          name: 'test',
          steps: [{
            action: 'if',
            condition: { ref: 'x', operator: op, value: 1 },
            then: [{ action: 'rules.emit', topic: 't' }],
          }],
        });
        expect(result.steps).toHaveLength(1);
      });
    }
  });
});
