import { describe, it, expect } from 'vitest';
import type { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';
import {
  resolveConfig,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_PATH,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_NAME,
  DEFAULT_HEARTBEAT,
  DEFAULT_BACKPRESSURE,
  DEFAULT_CONNECTION_LIMITS,
} from '../../src/config.js';
import type {
  AuthConfig,
  RateLimitConfig,
  HeartbeatConfig,
  BackpressureConfig,
} from '../../src/config.js';

const mockStore = {} as Store;
const mockRuleEngine = {} as RuleEngine;

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

describe('config defaults', () => {
  it('has correct default port', () => {
    expect(DEFAULT_PORT).toBe(8080);
  });

  it('has correct default host', () => {
    expect(DEFAULT_HOST).toBe('0.0.0.0');
  });

  it('has correct default path', () => {
    expect(DEFAULT_PATH).toBe('/');
  });

  it('has correct default max payload size (1 MB)', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(1_048_576);
  });

  it('has correct default name', () => {
    expect(DEFAULT_NAME).toBe('noex-server');
  });

  it('has correct default heartbeat config', () => {
    expect(DEFAULT_HEARTBEAT).toEqual({
      intervalMs: 30_000,
      timeoutMs: 10_000,
    });
  });

  it('has correct default backpressure config', () => {
    expect(DEFAULT_BACKPRESSURE).toEqual({
      maxBufferedBytes: 1_048_576,
      highWaterMark: 0.8,
    });
  });

  it('has correct default connection limits', () => {
    expect(DEFAULT_CONNECTION_LIMITS).toEqual({
      maxSubscriptionsPerConnection: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  // ── Minimal config (all defaults) ─────────────────────────────

  it('applies all defaults for minimal config', () => {
    const resolved = resolveConfig({ store: mockStore });

    expect(resolved).toEqual({
      store: mockStore,
      rules: null,
      port: 8080,
      host: '0.0.0.0',
      path: '/',
      maxPayloadBytes: 1_048_576,
      auth: null,
      rateLimit: null,
      rateLimiterRef: null,
      connectionRegistry: null,
      heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
      backpressure: { maxBufferedBytes: 1_048_576, highWaterMark: 0.8 },
      connectionLimits: { maxSubscriptionsPerConnection: 100 },
      auditLog: null,
      blacklist: null,
      procedureEngine: null,
      identityManager: null,
      name: 'noex-server',
      allowedOrigins: null,
      maxConnectionsPerIp: null,
    });
  });

  // ── Store (required) ──────────────────────────────────────────

  it('preserves user-provided store reference', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.store).toBe(mockStore);
  });

  // ── Rules (optional) ──────────────────────────────────────────

  it('preserves user-provided rules engine', () => {
    const resolved = resolveConfig({ store: mockStore, rules: mockRuleEngine });
    expect(resolved.rules).toBe(mockRuleEngine);
  });

  it('sets rules to null when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.rules).toBeNull();
  });

  // ── Transport ─────────────────────────────────────────────────

  it('preserves custom port', () => {
    const resolved = resolveConfig({ store: mockStore, port: 3000 });
    expect(resolved.port).toBe(3000);
  });

  it('preserves custom host', () => {
    const resolved = resolveConfig({ store: mockStore, host: '127.0.0.1' });
    expect(resolved.host).toBe('127.0.0.1');
  });

  it('preserves custom path', () => {
    const resolved = resolveConfig({ store: mockStore, path: '/ws' });
    expect(resolved.path).toBe('/ws');
  });

  it('preserves custom max payload', () => {
    const resolved = resolveConfig({ store: mockStore, maxPayloadBytes: 512 });
    expect(resolved.maxPayloadBytes).toBe(512);
  });

  // ── Auth ──────────────────────────────────────────────────────

  it('preserves auth config', () => {
    const auth: AuthConfig = {
      validate: async () => null,
      required: true,
    };
    const resolved = resolveConfig({ store: mockStore, auth });
    expect(resolved.auth).toBe(auth);
  });

  it('preserves auth config with permissions', () => {
    const auth: AuthConfig = {
      validate: async () => ({ userId: 'u1', roles: ['admin'] }),
      permissions: {
        check: (_session, _op, _resource) => true,
      },
    };
    const resolved = resolveConfig({ store: mockStore, auth });
    expect(resolved.auth).toBe(auth);
  });

  it('sets auth to null when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.auth).toBeNull();
  });

  // ── Rate limiting ─────────────────────────────────────────────

  it('preserves rate limit config', () => {
    const rateLimit: RateLimitConfig = { maxRequests: 200, windowMs: 120_000 };
    const resolved = resolveConfig({ store: mockStore, rateLimit });
    expect(resolved.rateLimit).toBe(rateLimit);
  });

  it('sets rate limit to null when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.rateLimit).toBeNull();
  });

  // ── Heartbeat ─────────────────────────────────────────────────

  it('uses default heartbeat when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.heartbeat).toEqual({
      intervalMs: 30_000,
      timeoutMs: 10_000,
    });
  });

  it('preserves custom heartbeat config', () => {
    const heartbeat: HeartbeatConfig = { intervalMs: 15_000, timeoutMs: 5_000 };
    const resolved = resolveConfig({ store: mockStore, heartbeat });
    expect(resolved.heartbeat).toBe(heartbeat);
  });

  // ── Backpressure ──────────────────────────────────────────────

  it('uses default backpressure when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.backpressure).toEqual({
      maxBufferedBytes: 1_048_576,
      highWaterMark: 0.8,
    });
  });

  it('preserves custom backpressure config', () => {
    const backpressure: BackpressureConfig = {
      maxBufferedBytes: 2_097_152,
      highWaterMark: 0.9,
    };
    const resolved = resolveConfig({ store: mockStore, backpressure });
    expect(resolved.backpressure).toBe(backpressure);
  });

  // ── Connection Limits ───────────────────────────────────────

  it('uses default connection limits when not provided', () => {
    const resolved = resolveConfig({ store: mockStore });
    expect(resolved.connectionLimits).toEqual({
      maxSubscriptionsPerConnection: 100,
    });
  });

  it('preserves custom maxSubscriptionsPerConnection', () => {
    const resolved = resolveConfig({
      store: mockStore,
      connectionLimits: { maxSubscriptionsPerConnection: 50 },
    });
    expect(resolved.connectionLimits.maxSubscriptionsPerConnection).toBe(50);
  });

  // ── Name ──────────────────────────────────────────────────────

  it('preserves custom name', () => {
    const resolved = resolveConfig({ store: mockStore, name: 'my-server' });
    expect(resolved.name).toBe('my-server');
  });

  // ── Full override ─────────────────────────────────────────────

  it('preserves all user-provided values simultaneously', () => {
    const auth: AuthConfig = {
      validate: async () => ({ userId: 'u1', roles: ['admin'] }),
      required: true,
      permissions: { check: () => true },
    };
    const rateLimit: RateLimitConfig = { maxRequests: 50, windowMs: 30_000 };
    const heartbeat: HeartbeatConfig = { intervalMs: 10_000, timeoutMs: 3_000 };
    const backpressure: BackpressureConfig = {
      maxBufferedBytes: 512_000,
      highWaterMark: 0.5,
    };

    const resolved = resolveConfig({
      store: mockStore,
      rules: mockRuleEngine,
      port: 9090,
      host: 'localhost',
      path: '/api/ws',
      maxPayloadBytes: 2_000_000,
      auth,
      rateLimit,
      heartbeat,
      backpressure,
      name: 'custom-server',
    });

    expect(resolved.store).toBe(mockStore);
    expect(resolved.rules).toBe(mockRuleEngine);
    expect(resolved.port).toBe(9090);
    expect(resolved.host).toBe('localhost');
    expect(resolved.path).toBe('/api/ws');
    expect(resolved.maxPayloadBytes).toBe(2_000_000);
    expect(resolved.auth).toBe(auth);
    expect(resolved.rateLimit).toBe(rateLimit);
    expect(resolved.heartbeat).toBe(heartbeat);
    expect(resolved.backpressure).toBe(backpressure);
    expect(resolved.name).toBe('custom-server');
  });
});
