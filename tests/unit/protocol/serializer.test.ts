import { describe, it, expect } from 'vitest';
import {
  serializeResult,
  serializeError,
  serializePush,
  serializeWelcome,
  serializePing,
} from '../../../src/protocol/serializer.js';

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

describe('serializeResult', () => {
  it('serializes a result with object data', () => {
    const json = serializeResult(1, { name: 'Alice' });
    const msg = parse(json);

    expect(msg).toEqual({
      id: 1,
      type: 'result',
      data: { name: 'Alice' },
    });
  });

  it('serializes a result with null data', () => {
    const msg = parse(serializeResult(5, null));

    expect(msg['id']).toBe(5);
    expect(msg['type']).toBe('result');
    expect(msg['data']).toBeNull();
  });

  it('serializes a result with array data', () => {
    const data = [{ id: 'a' }, { id: 'b' }];
    const msg = parse(serializeResult(10, data));

    expect(msg['data']).toEqual(data);
  });

  it('serializes a result with primitive data', () => {
    const msg = parse(serializeResult(3, 42));

    expect(msg['data']).toBe(42);
  });
});

describe('serializeError', () => {
  it('serializes an error without details', () => {
    const json = serializeError(1, 'PARSE_ERROR', 'Invalid JSON');
    const msg = parse(json);

    expect(msg).toMatchObject({
      id: 1,
      type: 'error',
      code: 'PARSE_ERROR',
      message: 'Invalid JSON',
    });
  });

  it('serializes an error with string details', () => {
    const msg = parse(serializeError(2, 'INTERNAL_ERROR', 'Something broke', 'stack trace'));

    expect(msg['details']).toBe('stack trace');
  });

  it('serializes an error with object details', () => {
    const details = {
      issues: [
        { field: 'name', message: 'required' },
        { field: 'email', message: 'invalid format' },
      ],
    };
    const msg = parse(serializeError(3, 'VALIDATION_ERROR', 'Validation failed', details));

    expect(msg['details']).toEqual(details);
  });

  it('omits details when undefined', () => {
    const json = serializeError(4, 'NOT_FOUND', 'Not found');
    const msg = parse(json);

    expect(msg).not.toHaveProperty('details');
  });

  it('serializes error with id 0 (unassociated)', () => {
    const msg = parse(serializeError(0, 'PARSE_ERROR', 'Bad input'));

    expect(msg['id']).toBe(0);
    expect(msg['type']).toBe('error');
  });
});

describe('serializePush', () => {
  it('serializes a subscription push', () => {
    const data = [{ id: 'u1', name: 'Alice' }];
    const json = serializePush('sub-1', 'subscription', data);
    const msg = parse(json);

    expect(msg).toEqual({
      type: 'push',
      channel: 'subscription',
      subscriptionId: 'sub-1',
      data,
    });
  });

  it('serializes an event push', () => {
    const data = { topic: 'order.created', event: { orderId: '123' } };
    const msg = parse(serializePush('sub-2', 'event', data));

    expect(msg['channel']).toBe('event');
    expect(msg['subscriptionId']).toBe('sub-2');
    expect(msg['data']).toEqual(data);
  });
});

describe('serializeWelcome', () => {
  it('serializes welcome with auth required', () => {
    const msg = parse(serializeWelcome({ requiresAuth: true, serverTime: 1700000000000 }));

    expect(msg).toEqual({
      type: 'welcome',
      version: '1.0.0',
      serverTime: 1700000000000,
      requiresAuth: true,
    });
  });

  it('serializes welcome without auth', () => {
    const msg = parse(serializeWelcome({ requiresAuth: false, serverTime: 1700000000000 }));

    expect(msg['requiresAuth']).toBe(false);
  });

  it('uses Date.now() when serverTime is omitted', () => {
    const before = Date.now();
    const msg = parse(serializeWelcome({ requiresAuth: false }));
    const after = Date.now();

    const serverTime = msg['serverTime'] as number;
    expect(serverTime).toBeGreaterThanOrEqual(before);
    expect(serverTime).toBeLessThanOrEqual(after);
  });

  it('always includes protocol version', () => {
    const msg = parse(serializeWelcome({ requiresAuth: false, serverTime: 0 }));

    expect(msg['version']).toBe('1.0.0');
  });
});

describe('serializePing', () => {
  it('serializes a ping with timestamp', () => {
    const msg = parse(serializePing(1700000000000));

    expect(msg).toEqual({
      type: 'ping',
      timestamp: 1700000000000,
    });
  });
});
