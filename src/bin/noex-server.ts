#!/usr/bin/env node

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';
import type { StorageAdapter } from '@hamicek/noex';
import { Store } from '@hamicek/noex-store';
import type { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '../server.js';
import type { ServerConfig } from '../config.js';

// =============================================================================
// Constants
// =============================================================================

const VERSION = '0.1.0';

const PERSISTENCE_TYPES = ['memory', 'file', 'sqlite'] as const;
type PersistenceType = (typeof PERSISTENCE_TYPES)[number];

// =============================================================================
// Types (exported for testing)
// =============================================================================

export interface CliValues {
  port: number | undefined;
  host: string | undefined;
  name: string | undefined;
  persistence: string | undefined;
  dataDir: string | undefined;
  db: string | undefined;
  auth: boolean | undefined;
  adminSecret: string | undefined;
  noRules: boolean | undefined;
  audit: boolean | undefined;
  noErrorDetails: boolean | undefined;
  allowedOrigins: string | undefined;
  maxConnectionsPerIp: number | undefined;
}

export interface FileConfig {
  port?: number;
  host?: string;
  name?: string;
  persistence?: string;
  dataDir?: string;
  db?: string;
  auth?: boolean;
  adminSecret?: string;
  rules?: boolean;
  audit?: boolean;
  rateLimit?: { maxRequests: number; windowMs: number };
  heartbeat?: { intervalMs: number; timeoutMs: number };
  backpressure?: { maxBufferedBytes: number; highWaterMark: number };
  connectionLimits?: { maxSubscriptionsPerConnection: number; maxTotalSubscriptions?: number };
  exposeErrorDetails?: boolean;
  allowedOrigins?: string[];
  maxConnectionsPerIp?: number;
}

export interface ResolvedCliConfig {
  readonly port: number;
  readonly host: string;
  readonly name: string;
  readonly persistence: string;
  readonly dataDir: string;
  readonly db: string;
  readonly auth: boolean;
  readonly adminSecret: string | undefined;
  readonly rules: boolean;
  readonly audit: boolean;
  readonly rateLimit: { maxRequests: number; windowMs: number } | undefined;
  readonly heartbeat: { intervalMs: number; timeoutMs: number } | undefined;
  readonly backpressure: {
    maxBufferedBytes: number;
    highWaterMark: number;
  } | undefined;
  readonly connectionLimits: {
    maxSubscriptionsPerConnection: number;
    maxTotalSubscriptions?: number;
  } | undefined;
  readonly exposeErrorDetails: boolean;
  readonly allowedOrigins: readonly string[] | null;
  readonly maxConnectionsPerIp: number | null;
}

// =============================================================================
// CLI Argument Definition
// =============================================================================

const argsConfig: ParseArgsConfig = {
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string', short: 'H' },
    config: { type: 'string', short: 'c' },
    name: { type: 'string' },
    persistence: { type: 'string' },
    'data-dir': { type: 'string' },
    db: { type: 'string' },
    auth: { type: 'boolean' },
    'admin-secret': { type: 'string' },
    'no-rules': { type: 'boolean' },
    audit: { type: 'boolean' },
    'no-error-details': { type: 'boolean' },
    'allowed-origins': { type: 'string' },
    'max-connections-per-ip': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  strict: true,
  allowPositionals: false,
};

// =============================================================================
// Help & Version
// =============================================================================

function printHelp(): void {
  const help = `
noex-server - WebSocket server for @hamicek/noex-store and @hamicek/noex-rules

USAGE:
  noex-server [OPTIONS]

OPTIONS:
  -p, --port <number>         Port (default: 8080)
  -H, --host <address>        Host (default: 0.0.0.0)
  -c, --config <path>         JSON config file
      --name <string>         Instance name (default: noex-server)

  PERSISTENCE:
      --persistence <type>    memory | file | sqlite (default: memory)
      --data-dir <path>       Directory for FileAdapter (default: ./data)
      --db <path>             Path to SQLite DB (default: ./noex.db)

  AUTH:
      --auth                  Enable built-in authentication
      --admin-secret <secret> Admin secret (required with --auth)

  FEATURES:
      --no-rules              Disable rules engine
      --audit                 Enable audit log

  SECURITY:
      --no-error-details      Hide error details in responses (production)
      --allowed-origins <list> Comma-separated allowed Origin headers
      --max-connections-per-ip <n> Max WebSocket connections per IP

  -h, --help                  Show this help message
  -v, --version               Show version number

CLI flags override values from the config file.

EXAMPLES:
  # Default (memory, port 8080)
  noex-server

  # File persistence + auth
  noex-server --persistence file --data-dir ./data --auth --admin-secret s3cret

  # SQLite + custom port
  noex-server --persistence sqlite --db ./myapp.db --port 3000

  # From config file
  noex-server --config server.json

  # Config file + port override
  noex-server --config server.json --port 9090
`.trim();

  console.log(help);
}

function printVersion(): void {
  console.log(`noex-server v${VERSION}`);
}

// =============================================================================
// Pure Functions (exported for testing)
// =============================================================================

const DEFAULTS: ResolvedCliConfig = {
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
};

export function mergeConfig(
  cli: CliValues,
  file: FileConfig,
): ResolvedCliConfig {
  return {
    port: cli.port ?? file.port ?? DEFAULTS.port,
    host: cli.host ?? file.host ?? DEFAULTS.host,
    name: cli.name ?? file.name ?? DEFAULTS.name,
    persistence: cli.persistence ?? file.persistence ?? DEFAULTS.persistence,
    dataDir: cli.dataDir ?? file.dataDir ?? DEFAULTS.dataDir,
    db: cli.db ?? file.db ?? DEFAULTS.db,
    auth: cli.auth ?? file.auth ?? DEFAULTS.auth,
    adminSecret: cli.adminSecret ?? file.adminSecret ?? DEFAULTS.adminSecret,
    rules: cli.noRules === true ? false : (file.rules ?? DEFAULTS.rules),
    audit: cli.audit ?? file.audit ?? DEFAULTS.audit,
    rateLimit: file.rateLimit,
    heartbeat: file.heartbeat,
    backpressure: file.backpressure,
    connectionLimits: file.connectionLimits,
    exposeErrorDetails: cli.noErrorDetails === true
      ? false
      : (file.exposeErrorDetails ?? DEFAULTS.exposeErrorDetails),
    allowedOrigins: cli.allowedOrigins !== undefined
      ? cli.allowedOrigins.split(',').map(o => o.trim())
      : (file.allowedOrigins ?? DEFAULTS.allowedOrigins),
    maxConnectionsPerIp: cli.maxConnectionsPerIp ?? file.maxConnectionsPerIp ?? DEFAULTS.maxConnectionsPerIp,
  };
}

export function validateConfig(config: ResolvedCliConfig): string[] {
  const errors: string[] = [];

  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  ) {
    errors.push(`Invalid port: ${config.port} (must be integer 0-65535)`);
  }

  if (
    config.auth &&
    (config.adminSecret === undefined || config.adminSecret === '')
  ) {
    errors.push('--admin-secret is required when --auth is enabled');
  }

  if (!PERSISTENCE_TYPES.includes(config.persistence as PersistenceType)) {
    errors.push(
      `Unknown persistence type: ${config.persistence} (must be memory, file, or sqlite)`,
    );
  }

  return errors;
}

export function createAdapter(
  type: string,
  options: { dataDir: string; db: string },
): StorageAdapter {
  switch (type) {
    case 'memory':
      return new MemoryAdapter();
    case 'file':
      return new FileAdapter({ directory: options.dataDir });
    case 'sqlite':
      return new SQLiteAdapter({ filename: options.db });
    default:
      throw new Error(`Unknown persistence type: ${type}`);
  }
}

// =============================================================================
// Banner
// =============================================================================

function printBanner(config: ResolvedCliConfig, actualPort: number): void {
  const persistenceDetail =
    config.persistence === 'file'
      ? ` (${config.dataDir})`
      : config.persistence === 'sqlite'
        ? ` (${config.db})`
        : '';

  const banner = `
noex-server v${VERSION}
  URL:          ws://${config.host}:${actualPort}
  Persistence:  ${config.persistence}${persistenceDetail}
  Auth:         ${config.auth ? 'built-in' : 'disabled'}
  Rules:        ${config.rules ? 'enabled' : 'disabled'}
  Audit:        ${config.audit ? 'enabled' : 'disabled'}
  Error details: ${config.exposeErrorDetails ? 'exposed' : 'hidden'}
  Origins:      ${config.allowedOrigins !== null ? config.allowedOrigins.join(', ') : 'any'}
  Max conn/IP:  ${config.maxConnectionsPerIp !== null ? config.maxConnectionsPerIp : 'unlimited'}
`.trim();

  console.log(banner);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;

  try {
    args = parseArgs(argsConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error('Run "noex-server --help" for usage information.');
    process.exit(1);
  }

  if (args.values['help']) {
    printHelp();
    return;
  }

  if (args.values['version']) {
    printVersion();
    return;
  }

  // Load config file
  let fileConfig: FileConfig = {};
  if (args.values['config'] !== undefined) {
    const configPath = resolve(args.values['config'] as string);
    try {
      const raw = await readFile(configPath, 'utf-8');
      fileConfig = JSON.parse(raw) as FileConfig;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error loading config file: ${message}`);
      process.exit(1);
    }
  }

  // Extract CLI values
  const portRaw = args.values['port'] as string | undefined;
  const cliValues: CliValues = {
    port: portRaw !== undefined ? Number(portRaw) : undefined,
    host: args.values['host'] as string | undefined,
    name: args.values['name'] as string | undefined,
    persistence: args.values['persistence'] as string | undefined,
    dataDir: args.values['data-dir'] as string | undefined,
    db: args.values['db'] as string | undefined,
    auth: args.values['auth'] as boolean | undefined,
    adminSecret: args.values['admin-secret'] as string | undefined,
    noRules: args.values['no-rules'] as boolean | undefined,
    audit: args.values['audit'] as boolean | undefined,
    noErrorDetails: args.values['no-error-details'] as boolean | undefined,
    allowedOrigins: args.values['allowed-origins'] as string | undefined,
    maxConnectionsPerIp: args.values['max-connections-per-ip'] !== undefined
      ? Number(args.values['max-connections-per-ip'])
      : undefined,
  };

  // Merge & validate
  const config = mergeConfig(cliValues, fileConfig);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(`Error: ${e}`);
    process.exit(1);
  }

  // Create persistence adapter
  const adapter = createAdapter(config.persistence, {
    dataDir: resolve(config.dataDir),
    db: resolve(config.db),
  });

  // Eagerly validate adapter — fail fast if dependencies are missing
  if (config.persistence !== 'memory') {
    try {
      await adapter.listKeys();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: Failed to initialize ${config.persistence} persistence: ${message}`);
      process.exit(1);
    }
  }

  // Start store
  const store = await Store.start({
    persistence: {
      adapter,
      onError: (error) => {
        console.error(`[persistence] ${error.message}`);
      },
    },
  });

  // Start rules engine (dynamic import — optional peer dep)
  let rules: RuleEngine | null = null;

  if (config.rules) {
    try {
      const mod = await import('@hamicek/noex-rules');
      rules = await mod.RuleEngine.start();
    } catch {
      console.error(
        'Error: @hamicek/noex-rules is not installed.\n' +
          'Install it with: npm install @hamicek/noex-rules\n' +
          'Or disable rules with: --no-rules',
      );
      await store.stop();
      process.exit(1);
    }
  }

  // Build server config
  const serverConfig: ServerConfig = {
    store,
    ...(rules !== null ? { rules } : {}),
    port: config.port,
    host: config.host,
    name: config.name,
    ...(config.auth
      ? { auth: { builtIn: true as const, adminSecret: config.adminSecret! } }
      : {}),
    ...(config.rateLimit !== undefined ? { rateLimit: config.rateLimit } : {}),
    ...(config.heartbeat !== undefined
      ? { heartbeat: config.heartbeat }
      : {}),
    ...(config.backpressure !== undefined
      ? { backpressure: config.backpressure }
      : {}),
    ...(config.connectionLimits !== undefined
      ? { connectionLimits: config.connectionLimits }
      : {}),
    ...(config.audit ? { audit: {} } : {}),
    exposeErrorDetails: config.exposeErrorDetails,
    ...(config.allowedOrigins !== null
      ? { allowedOrigins: config.allowedOrigins }
      : {}),
    ...(config.maxConnectionsPerIp !== null
      ? { maxConnectionsPerIp: config.maxConnectionsPerIp }
      : {}),
  };

  // Start server
  const server = await NoexServer.start(serverConfig);

  printBanner(config, server.port);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    await server.stop();
    if (rules !== null) await rules.stop();
    await store.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// =============================================================================
// Execute (only when run directly, not when imported for testing)
// =============================================================================

async function isMainModule(): Promise<boolean> {
  if (process.argv[1] === undefined) return false;
  const thisFile = fileURLToPath(import.meta.url);
  if (process.argv[1] === thisFile) return true;
  try {
    return (await realpath(process.argv[1])) === thisFile;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  main().catch((error: unknown) => {
    console.error(
      'Fatal:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
