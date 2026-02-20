import { describe, it, expect } from 'vitest';
import { MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';
import {
  mergeConfig,
  validateConfig,
  createAdapter,
  type CliValues,
  type FileConfig,
} from '../../../src/bin/noex-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_CLI: CliValues = {
  port: undefined,
  host: undefined,
  name: undefined,
  persistence: undefined,
  dataDir: undefined,
  db: undefined,
  auth: undefined,
  adminSecret: undefined,
  noRules: undefined,
  audit: undefined,
  noErrorDetails: undefined,
  allowedOrigins: undefined,
  maxConnectionsPerIp: undefined,
};

const EMPTY_FILE: FileConfig = {};

// ---------------------------------------------------------------------------
// mergeConfig
// ---------------------------------------------------------------------------

describe('mergeConfig', () => {
  it('returns all defaults when both CLI and file are empty', () => {
    const result = mergeConfig(EMPTY_CLI, EMPTY_FILE);

    expect(result).toEqual({
      port: 8080,
      host: '0.0.0.0',
      name: 'noex-server',
      persistence: 'memory',
      dataDir: './data',
      db: './noex.db',
      auth: false,
      adminSecret: undefined,
      rules: true,
      audit: false,
      rateLimit: undefined,
      heartbeat: undefined,
      backpressure: undefined,
      connectionLimits: undefined,
      exposeErrorDetails: true,
      allowedOrigins: null,
      maxConnectionsPerIp: null,
    });
  });

  // ── CLI overrides defaults ────────────────────────────────────

  it('CLI port overrides default', () => {
    const result = mergeConfig({ ...EMPTY_CLI, port: 3000 }, EMPTY_FILE);
    expect(result.port).toBe(3000);
  });

  it('CLI host overrides default', () => {
    const result = mergeConfig({ ...EMPTY_CLI, host: '127.0.0.1' }, EMPTY_FILE);
    expect(result.host).toBe('127.0.0.1');
  });

  it('CLI name overrides default', () => {
    const result = mergeConfig({ ...EMPTY_CLI, name: 'my-app' }, EMPTY_FILE);
    expect(result.name).toBe('my-app');
  });

  it('CLI persistence overrides default', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, persistence: 'sqlite' },
      EMPTY_FILE,
    );
    expect(result.persistence).toBe('sqlite');
  });

  it('CLI dataDir overrides default', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, dataDir: '/tmp/storage' },
      EMPTY_FILE,
    );
    expect(result.dataDir).toBe('/tmp/storage');
  });

  it('CLI db overrides default', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, db: '/tmp/my.db' },
      EMPTY_FILE,
    );
    expect(result.db).toBe('/tmp/my.db');
  });

  it('CLI auth overrides default', () => {
    const result = mergeConfig({ ...EMPTY_CLI, auth: true }, EMPTY_FILE);
    expect(result.auth).toBe(true);
  });

  it('CLI adminSecret overrides default', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, adminSecret: 's3cret' },
      EMPTY_FILE,
    );
    expect(result.adminSecret).toBe('s3cret');
  });

  it('CLI audit overrides default', () => {
    const result = mergeConfig({ ...EMPTY_CLI, audit: true }, EMPTY_FILE);
    expect(result.audit).toBe(true);
  });

  // ── File config overrides defaults ────────────────────────────

  it('file port overrides default', () => {
    const result = mergeConfig(EMPTY_CLI, { port: 4000 });
    expect(result.port).toBe(4000);
  });

  it('file host overrides default', () => {
    const result = mergeConfig(EMPTY_CLI, { host: '10.0.0.1' });
    expect(result.host).toBe('10.0.0.1');
  });

  it('file auth=true enables auth', () => {
    const result = mergeConfig(EMPTY_CLI, { auth: true, adminSecret: 'abc' });
    expect(result.auth).toBe(true);
    expect(result.adminSecret).toBe('abc');
  });

  it('file rules=false disables rules', () => {
    const result = mergeConfig(EMPTY_CLI, { rules: false });
    expect(result.rules).toBe(false);
  });

  it('file passes through rateLimit', () => {
    const rateLimit = { maxRequests: 100, windowMs: 60000 };
    const result = mergeConfig(EMPTY_CLI, { rateLimit });
    expect(result.rateLimit).toEqual(rateLimit);
  });

  it('file passes through heartbeat', () => {
    const heartbeat = { intervalMs: 15000, timeoutMs: 5000 };
    const result = mergeConfig(EMPTY_CLI, { heartbeat });
    expect(result.heartbeat).toEqual(heartbeat);
  });

  it('file passes through backpressure', () => {
    const backpressure = { maxBufferedBytes: 2097152, highWaterMark: 0.9 };
    const result = mergeConfig(EMPTY_CLI, { backpressure });
    expect(result.backpressure).toEqual(backpressure);
  });

  it('file passes through connectionLimits', () => {
    const connectionLimits = { maxSubscriptionsPerConnection: 50 };
    const result = mergeConfig(EMPTY_CLI, { connectionLimits });
    expect(result.connectionLimits).toEqual(connectionLimits);
  });

  // ── CLI overrides file config ─────────────────────────────────

  it('CLI port overrides file port', () => {
    const result = mergeConfig({ ...EMPTY_CLI, port: 9090 }, { port: 4000 });
    expect(result.port).toBe(9090);
  });

  it('CLI host overrides file host', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, host: '127.0.0.1' },
      { host: '10.0.0.1' },
    );
    expect(result.host).toBe('127.0.0.1');
  });

  it('CLI persistence overrides file persistence', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, persistence: 'sqlite' },
      { persistence: 'file' },
    );
    expect(result.persistence).toBe('sqlite');
  });

  it('CLI adminSecret overrides file adminSecret', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, adminSecret: 'cli-secret' },
      { adminSecret: 'file-secret' },
    );
    expect(result.adminSecret).toBe('cli-secret');
  });

  // ── --no-rules handling ───────────────────────────────────────

  it('--no-rules disables rules (default enabled)', () => {
    const result = mergeConfig({ ...EMPTY_CLI, noRules: true }, EMPTY_FILE);
    expect(result.rules).toBe(false);
  });

  it('--no-rules overrides file rules=true', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, noRules: true },
      { rules: true },
    );
    expect(result.rules).toBe(false);
  });

  it('rules stays true when --no-rules is not set and file has no rules field', () => {
    const result = mergeConfig(EMPTY_CLI, EMPTY_FILE);
    expect(result.rules).toBe(true);
  });

  // ── Full override scenario ────────────────────────────────────

  it('CLI overrides all scalar fields from file', () => {
    const cli: CliValues = {
      port: 9090,
      host: '127.0.0.1',
      name: 'cli-app',
      persistence: 'sqlite',
      dataDir: '/cli/data',
      db: '/cli/app.db',
      auth: true,
      adminSecret: 'cli-secret',
      noRules: true,
      audit: true,
      noErrorDetails: true,
      allowedOrigins: 'https://a.com,https://b.com',
      maxConnectionsPerIp: 5,
    };

    const file: FileConfig = {
      port: 4000,
      host: '10.0.0.1',
      name: 'file-app',
      persistence: 'file',
      dataDir: '/file/data',
      db: '/file/app.db',
      auth: false,
      adminSecret: 'file-secret',
      rules: true,
      audit: false,
      rateLimit: { maxRequests: 100, windowMs: 60000 },
      heartbeat: { intervalMs: 15000, timeoutMs: 5000 },
      exposeErrorDetails: true,
      allowedOrigins: ['https://file.com'],
      maxConnectionsPerIp: 100,
    };

    const result = mergeConfig(cli, file);

    expect(result.port).toBe(9090);
    expect(result.host).toBe('127.0.0.1');
    expect(result.name).toBe('cli-app');
    expect(result.persistence).toBe('sqlite');
    expect(result.dataDir).toBe('/cli/data');
    expect(result.db).toBe('/cli/app.db');
    expect(result.auth).toBe(true);
    expect(result.adminSecret).toBe('cli-secret');
    expect(result.rules).toBe(false);
    expect(result.audit).toBe(true);
    // Sub-configs come from file only
    expect(result.rateLimit).toEqual({ maxRequests: 100, windowMs: 60000 });
    expect(result.heartbeat).toEqual({ intervalMs: 15000, timeoutMs: 5000 });
    // Security — CLI overrides file
    expect(result.exposeErrorDetails).toBe(false);
    expect(result.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
    expect(result.maxConnectionsPerIp).toBe(5);
  });

  // ── Security options ──────────────────────────────────────────

  it('--no-error-details sets exposeErrorDetails to false', () => {
    const result = mergeConfig({ ...EMPTY_CLI, noErrorDetails: true }, EMPTY_FILE);
    expect(result.exposeErrorDetails).toBe(false);
  });

  it('--no-error-details overrides file exposeErrorDetails=true', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, noErrorDetails: true },
      { exposeErrorDetails: true },
    );
    expect(result.exposeErrorDetails).toBe(false);
  });

  it('file exposeErrorDetails=false is respected when CLI does not override', () => {
    const result = mergeConfig(EMPTY_CLI, { exposeErrorDetails: false });
    expect(result.exposeErrorDetails).toBe(false);
  });

  it('CLI --allowed-origins parses comma-separated list', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, allowedOrigins: 'https://a.com, https://b.com' },
      EMPTY_FILE,
    );
    expect(result.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('CLI --allowed-origins overrides file allowedOrigins', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, allowedOrigins: 'https://cli.com' },
      { allowedOrigins: ['https://file.com'] },
    );
    expect(result.allowedOrigins).toEqual(['https://cli.com']);
  });

  it('file allowedOrigins is used when CLI does not set it', () => {
    const result = mergeConfig(EMPTY_CLI, { allowedOrigins: ['https://file.com'] });
    expect(result.allowedOrigins).toEqual(['https://file.com']);
  });

  it('CLI --max-connections-per-ip overrides file', () => {
    const result = mergeConfig(
      { ...EMPTY_CLI, maxConnectionsPerIp: 10 },
      { maxConnectionsPerIp: 50 },
    );
    expect(result.maxConnectionsPerIp).toBe(10);
  });

  it('file maxConnectionsPerIp is used when CLI does not set it', () => {
    const result = mergeConfig(EMPTY_CLI, { maxConnectionsPerIp: 25 });
    expect(result.maxConnectionsPerIp).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  const validConfig = mergeConfig(EMPTY_CLI, EMPTY_FILE);

  it('returns no errors for valid default config', () => {
    expect(validateConfig(validConfig)).toEqual([]);
  });

  // ── Port validation ───────────────────────────────────────────

  it('accepts port 0 (OS picks random port)', () => {
    const errors = validateConfig({ ...validConfig, port: 0 });
    expect(errors).toEqual([]);
  });

  it('rejects negative port', () => {
    const errors = validateConfig({ ...validConfig, port: -1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid port');
  });

  it('rejects port above 65535', () => {
    const errors = validateConfig({ ...validConfig, port: 65536 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid port');
  });

  it('rejects non-integer port', () => {
    const errors = validateConfig({ ...validConfig, port: 80.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid port');
  });

  it('rejects NaN port', () => {
    const errors = validateConfig({ ...validConfig, port: NaN });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid port');
  });

  it('accepts port 1', () => {
    const errors = validateConfig({ ...validConfig, port: 1 });
    expect(errors).toEqual([]);
  });

  it('accepts port 65535', () => {
    const errors = validateConfig({ ...validConfig, port: 65535 });
    expect(errors).toEqual([]);
  });

  // ── Auth validation ───────────────────────────────────────────

  it('rejects auth=true without adminSecret', () => {
    const errors = validateConfig({
      ...validConfig,
      auth: true,
      adminSecret: undefined,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--admin-secret');
  });

  it('rejects auth=true with empty adminSecret', () => {
    const errors = validateConfig({
      ...validConfig,
      auth: true,
      adminSecret: '',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--admin-secret');
  });

  it('accepts auth=true with valid adminSecret', () => {
    const errors = validateConfig({
      ...validConfig,
      auth: true,
      adminSecret: 's3cret',
    });
    expect(errors).toEqual([]);
  });

  it('accepts auth=false without adminSecret', () => {
    const errors = validateConfig({
      ...validConfig,
      auth: false,
      adminSecret: undefined,
    });
    expect(errors).toEqual([]);
  });

  // ── Persistence type validation ───────────────────────────────

  it('accepts memory persistence', () => {
    const errors = validateConfig({ ...validConfig, persistence: 'memory' });
    expect(errors).toEqual([]);
  });

  it('accepts file persistence', () => {
    const errors = validateConfig({ ...validConfig, persistence: 'file' });
    expect(errors).toEqual([]);
  });

  it('accepts sqlite persistence', () => {
    const errors = validateConfig({ ...validConfig, persistence: 'sqlite' });
    expect(errors).toEqual([]);
  });

  it('rejects unknown persistence type', () => {
    const errors = validateConfig({ ...validConfig, persistence: 'redis' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown persistence type');
    expect(errors[0]).toContain('redis');
  });

  // ── Multiple errors ───────────────────────────────────────────

  it('collects multiple errors', () => {
    const errors = validateConfig({
      ...validConfig,
      port: -1,
      auth: true,
      adminSecret: undefined,
      persistence: 'redis',
    });
    expect(errors).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// createAdapter
// ---------------------------------------------------------------------------

describe('createAdapter', () => {
  const options = { dataDir: '/tmp/data', db: '/tmp/test.db' };

  it('creates MemoryAdapter for "memory"', () => {
    const adapter = createAdapter('memory', options);
    expect(adapter).toBeInstanceOf(MemoryAdapter);
  });

  it('creates FileAdapter for "file"', () => {
    const adapter = createAdapter('file', options);
    expect(adapter).toBeInstanceOf(FileAdapter);
  });

  it('creates SQLiteAdapter for "sqlite"', () => {
    const adapter = createAdapter('sqlite', options);
    expect(adapter).toBeInstanceOf(SQLiteAdapter);
  });

  it('throws for unknown type', () => {
    expect(() => createAdapter('redis', options)).toThrow(
      'Unknown persistence type: redis',
    );
  });
});
