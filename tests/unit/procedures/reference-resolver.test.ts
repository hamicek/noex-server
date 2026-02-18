import { describe, it, expect } from 'vitest';
import { resolveRef, resolveValue } from '../../../src/procedures/reference-resolver.js';
import type { ExecutionContext } from '../../../src/procedures/procedure-types.js';

// ── Helpers ──────────────────────────────────────────────────────

function ctx(
  input: Record<string, unknown> = {},
  results: Record<string, unknown> = {},
): ExecutionContext {
  return {
    input,
    results: new Map(Object.entries(results)),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('reference-resolver', () => {
  // ── resolveRef ──────────────────────────────────────────────

  describe('resolveRef', () => {
    it('resolves input parameter', () => {
      const c = ctx({ orderId: 'ord-123' });
      expect(resolveRef('input.orderId', c)).toBe('ord-123');
    });

    it('resolves nested input parameter', () => {
      const c = ctx({ customer: { name: 'Alice', address: { city: 'Prague' } } });
      expect(resolveRef('input.customer.name', c)).toBe('Alice');
      expect(resolveRef('input.customer.address.city', c)).toBe('Prague');
    });

    it('resolves step result by name', () => {
      const c = ctx({}, { order: { id: 'ord-1', total: 500 } });
      expect(resolveRef('order', c)).toEqual({ id: 'ord-1', total: 500 });
    });

    it('resolves nested step result property', () => {
      const c = ctx({}, { order: { id: 'ord-1', total: 500 } });
      expect(resolveRef('order.total', c)).toBe(500);
    });

    it('resolves array length', () => {
      const c = ctx({}, { items: [{ price: 10 }, { price: 20 }, { price: 30 }] });
      expect(resolveRef('items.length', c)).toBe(3);
    });

    it('resolves scalar step result', () => {
      const c = ctx({}, { total: 150 });
      expect(resolveRef('total', c)).toBe(150);
    });

    it('returns undefined for non-existent input', () => {
      const c = ctx({ orderId: 'ord-123' });
      expect(resolveRef('input.missing', c)).toBeUndefined();
    });

    it('returns undefined for non-existent result', () => {
      const c = ctx();
      expect(resolveRef('missing', c)).toBeUndefined();
    });

    it('returns undefined for deep path on null', () => {
      const c = ctx({}, { order: null });
      expect(resolveRef('order.total', c)).toBeUndefined();
    });

    it('returns undefined for deep path on primitive', () => {
      const c = ctx({}, { count: 42 });
      expect(resolveRef('count.something', c)).toBeUndefined();
    });
  });

  // ── resolveValue ────────────────────────────────────────────

  describe('resolveValue', () => {
    it('returns non-string primitives unchanged', () => {
      const c = ctx();
      expect(resolveValue(42, c)).toBe(42);
      expect(resolveValue(true, c)).toBe(true);
      expect(resolveValue(null, c)).toBeNull();
    });

    it('returns plain string unchanged', () => {
      const c = ctx();
      expect(resolveValue('hello', c)).toBe('hello');
    });

    it('resolves exact template to raw JS value', () => {
      const c = ctx({ orderId: 'ord-123' });
      expect(resolveValue('{{ input.orderId }}', c)).toBe('ord-123');
    });

    it('resolves exact template to number (not string)', () => {
      const c = ctx({}, { total: 150 });
      expect(resolveValue('{{ total }}', c)).toBe(150);
    });

    it('resolves exact template to object', () => {
      const c = ctx({}, { order: { id: 'ord-1', total: 500 } });
      expect(resolveValue('{{ order }}', c)).toEqual({ id: 'ord-1', total: 500 });
    });

    it('resolves exact template to array', () => {
      const c = ctx({}, { items: [1, 2, 3] });
      expect(resolveValue('{{ items }}', c)).toEqual([1, 2, 3]);
    });

    it('resolves mixed template with string interpolation', () => {
      const c = ctx({ orderId: 'ord-123' });
      expect(resolveValue('Order: {{ input.orderId }}', c)).toBe('Order: ord-123');
    });

    it('resolves multiple templates in one string', () => {
      const c = ctx({ first: 'Alice', last: 'Smith' });
      expect(resolveValue('{{ input.first }} {{ input.last }}', c)).toBe('Alice Smith');
    });

    it('stringifies object in mixed template', () => {
      const c = ctx({}, { data: { a: 1 } });
      expect(resolveValue('Info: {{ data }}', c)).toBe('Info: {"a":1}');
    });

    it('replaces undefined reference with empty string in mixed template', () => {
      const c = ctx();
      expect(resolveValue('Value: {{ missing }}', c)).toBe('Value: ');
    });

    it('replaces null reference with empty string in mixed template', () => {
      const c = ctx({}, { value: null });
      expect(resolveValue('Value: {{ value }}', c)).toBe('Value: ');
    });

    it('resolves templates in object values recursively', () => {
      const c = ctx({ orderId: 'ord-123' }, { total: 150 });
      const result = resolveValue(
        { orderId: '{{ input.orderId }}', total: '{{ total }}' },
        c,
      );
      expect(result).toEqual({ orderId: 'ord-123', total: 150 });
    });

    it('resolves templates in arrays recursively', () => {
      const c = ctx({ a: 1, b: 2 });
      const result = resolveValue(['{{ input.a }}', '{{ input.b }}', 'static'], c);
      expect(result).toEqual([1, 2, 'static']);
    });

    it('resolves nested objects with templates', () => {
      const c = ctx({ id: 'x' }, { total: 100 });
      const result = resolveValue(
        { outer: { orderId: '{{ input.id }}', amount: '{{ total }}' } },
        c,
      );
      expect(result).toEqual({ outer: { orderId: 'x', amount: 100 } });
    });

    it('handles whitespace in templates', () => {
      const c = ctx({ val: 42 });
      expect(resolveValue('{{  input.val  }}', c)).toBe(42);
      expect(resolveValue('{{ input.val}}', c)).toBe(42);
      expect(resolveValue('{{input.val }}', c)).toBe(42);
    });
  });
});
