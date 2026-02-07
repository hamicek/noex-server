import { describe, it, expect } from 'vitest';
import { parseMessage } from '../../../src/protocol/parser.js';

describe('parseMessage', () => {
  // -------------------------------------------------------------------------
  // Valid requests
  // -------------------------------------------------------------------------

  describe('valid requests', () => {
    it('parses a minimal valid request', () => {
      const result = parseMessage('{"id":1,"type":"store.get"}');

      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        kind: 'request',
        request: { id: 1, type: 'store.get' },
      });
    });

    it('parses a request with additional payload fields', () => {
      const raw = JSON.stringify({
        id: 42,
        type: 'store.insert',
        bucket: 'users',
        data: { name: 'Alice', role: 'admin' },
      });
      const result = parseMessage(raw);

      expect(result.ok).toBe(true);
      if (result.ok && result.kind === 'request') {
        expect(result.request.id).toBe(42);
        expect(result.request.type).toBe('store.insert');
        expect(result.request['bucket']).toBe('users');
        expect(result.request['data']).toEqual({ name: 'Alice', role: 'admin' });
      }
    });

    it('accepts zero as id', () => {
      const result = parseMessage('{"id":0,"type":"ping"}');

      expect(result.ok).toBe(true);
      if (result.ok && result.kind === 'request') {
        expect(result.request.id).toBe(0);
      }
    });

    it('accepts negative id', () => {
      const result = parseMessage('{"id":-5,"type":"store.get"}');

      expect(result.ok).toBe(true);
      if (result.ok && result.kind === 'request') {
        expect(result.request.id).toBe(-5);
      }
    });

    it('accepts fractional id', () => {
      const result = parseMessage('{"id":1.5,"type":"store.get"}');

      expect(result.ok).toBe(true);
      if (result.ok && result.kind === 'request') {
        expect(result.request.id).toBe(1.5);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pong messages
  // -------------------------------------------------------------------------

  describe('pong messages', () => {
    it('parses a valid pong', () => {
      const result = parseMessage('{"type":"pong","timestamp":1700000000000}');

      expect(result).toEqual({
        ok: true,
        kind: 'pong',
        timestamp: 1700000000000,
      });
    });

    it('rejects pong without timestamp', () => {
      const result = parseMessage('{"type":"pong"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
        expect(result.message).toContain('timestamp');
      }
    });

    it('rejects pong with non-numeric timestamp', () => {
      const result = parseMessage('{"type":"pong","timestamp":"abc"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects pong with null timestamp', () => {
      const result = parseMessage('{"type":"pong","timestamp":null}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });
  });

  // -------------------------------------------------------------------------
  // JSON parse errors
  // -------------------------------------------------------------------------

  describe('JSON parse errors', () => {
    it('rejects non-JSON string', () => {
      const result = parseMessage('not json at all');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
        expect(result.message).toBe('Invalid JSON');
      }
    });

    it('rejects empty string', () => {
      const result = parseMessage('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });

    it('rejects truncated JSON', () => {
      const result = parseMessage('{"id":1,"type":');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-object JSON values
  // -------------------------------------------------------------------------

  describe('non-object JSON values', () => {
    it('rejects JSON array', () => {
      const result = parseMessage('[1,2,3]');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
        expect(result.message).toBe('Message must be a JSON object');
      }
    });

    it('rejects JSON null', () => {
      const result = parseMessage('null');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });

    it('rejects JSON number', () => {
      const result = parseMessage('42');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });

    it('rejects JSON string literal', () => {
      const result = parseMessage('"hello"');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });

    it('rejects JSON boolean', () => {
      const result = parseMessage('true');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PARSE_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Invalid id
  // -------------------------------------------------------------------------

  describe('invalid id', () => {
    it('rejects missing id', () => {
      const result = parseMessage('{"type":"store.get"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
        expect(result.message).toContain('"id"');
      }
    });

    it('rejects string id', () => {
      const result = parseMessage('{"id":"abc","type":"store.get"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects null id', () => {
      const result = parseMessage('{"id":null,"type":"store.get"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects boolean id', () => {
      const result = parseMessage('{"id":true,"type":"store.get"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects object id', () => {
      const result = parseMessage('{"id":{},"type":"store.get"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Invalid type
  // -------------------------------------------------------------------------

  describe('invalid type', () => {
    it('rejects missing type', () => {
      const result = parseMessage('{"id":1}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
        expect(result.message).toContain('"type"');
      }
    });

    it('rejects numeric type', () => {
      const result = parseMessage('{"id":1,"type":42}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects empty string type', () => {
      const result = parseMessage('{"id":1,"type":""}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
        expect(result.message).toContain('non-empty');
      }
    });

    it('rejects null type', () => {
      const result = parseMessage('{"id":1,"type":null}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
      }
    });

    it('checks type before id (type validation first)', () => {
      const result = parseMessage('{"id":"bad"}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_REQUEST');
        expect(result.message).toContain('"type"');
      }
    });
  });
});
