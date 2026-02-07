import { describe, it, expect } from 'vitest';

describe('public API exports', () => {
  it('exports NoexServer class', async () => {
    const { NoexServer } = await import('../../src/index.js');
    expect(NoexServer).toBeDefined();
    expect(typeof NoexServer.start).toBe('function');
  });

  it('exports NoexServerError class', async () => {
    const { NoexServerError } = await import('../../src/index.js');
    expect(NoexServerError).toBeDefined();

    const err = new NoexServerError('PARSE_ERROR', 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NoexServerError);
    expect(err.code).toBe('PARSE_ERROR');
    expect(err.message).toBe('test');
    expect(err.name).toBe('NoexServerError');
  });

  it('exports ErrorCode constant with all codes', async () => {
    const { ErrorCode } = await import('../../src/index.js');
    expect(ErrorCode).toBeDefined();
    expect(typeof ErrorCode).toBe('object');

    const expectedCodes = [
      'PARSE_ERROR',
      'INVALID_REQUEST',
      'UNKNOWN_OPERATION',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'ALREADY_EXISTS',
      'CONFLICT',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'RATE_LIMITED',
      'BACKPRESSURE',
      'INTERNAL_ERROR',
      'BUCKET_NOT_DEFINED',
      'QUERY_NOT_DEFINED',
      'RULES_NOT_AVAILABLE',
    ];

    for (const code of expectedCodes) {
      expect(ErrorCode).toHaveProperty(code, code);
    }
  });

  it('exports PROTOCOL_VERSION', async () => {
    const { PROTOCOL_VERSION } = await import('../../src/index.js');
    expect(PROTOCOL_VERSION).toBe('1.0.0');
  });

  it('does not export internal modules', async () => {
    const publicApi = await import('../../src/index.js');

    // Internal functions/types should NOT be part of the public API
    expect(publicApi).not.toHaveProperty('resolveConfig');
    expect(publicApi).not.toHaveProperty('parseMessage');
    expect(publicApi).not.toHaveProperty('serializeResult');
    expect(publicApi).not.toHaveProperty('serializeError');
    expect(publicApi).not.toHaveProperty('handleStoreRequest');
    expect(publicApi).not.toHaveProperty('mapStoreError');
    expect(publicApi).not.toHaveProperty('startConnectionSupervisor');
    expect(publicApi).not.toHaveProperty('addConnection');
    expect(publicApi).not.toHaveProperty('createConnectionBehavior');
  });
});
