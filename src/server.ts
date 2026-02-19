import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { SupervisorRef } from '@hamicek/noex';
import { GenServer, RateLimiter, type RateLimiterRef } from '@hamicek/noex';
import type { ServerConfig } from './config.js';
import { resolveConfig, isBuiltInAuth, type ResolvedServerConfig } from './config.js';
import { IdentityManager } from './identity/identity-manager.js';
import { serializeSystem } from './protocol/serializer.js';
import {
  startConnectionSupervisor,
  addConnection,
  getConnectionCount,
  stopConnectionSupervisor,
} from './connection/connection-supervisor.js';
import {
  createConnectionRegistry,
  closeConnectionRegistry,
  getConnections as getRegistryConnections,
  type ConnectionInfo,
  type ConnectionRegistry,
} from './connection/connection-registry.js';
import { AuditLog } from './audit/audit-log.js';
import { SessionBlacklist } from './auth/session-revocation.js';
import { ProcedureEngine } from './procedures/procedure-engine.js';
import type { ConnectionRef } from './connection/connection-supervisor.js';

// ── Stats ─────────────────────────────────────────────────────────

export interface ConnectionsStats {
  readonly active: number;
  readonly authenticated: number;
  readonly totalStoreSubscriptions: number;
  readonly totalRulesSubscriptions: number;
}

export interface ServerStats {
  readonly name: string;
  readonly port: number;
  readonly host: string;
  readonly connectionCount: number;
  readonly uptimeMs: number;
  readonly authEnabled: boolean;
  readonly rateLimitEnabled: boolean;
  readonly rulesEnabled: boolean;
  readonly connections: ConnectionsStats;
  readonly store: unknown;
  readonly rules: unknown;
}

// ── WebSocket readyState constants ────────────────────────────────

const WS_OPEN = 1;

// ── NoexServer ────────────────────────────────────────────────────

export class NoexServer {
  readonly #config: ResolvedServerConfig;
  readonly #httpServer: HttpServer;
  readonly #wss: InstanceType<typeof WebSocketServer>;
  readonly #supervisorRef: SupervisorRef;
  readonly #rateLimiterRef: RateLimiterRef | null;
  readonly #connectionRegistry: ConnectionRegistry;
  readonly #blacklist: SessionBlacklist;
  readonly #startedAt: number;
  #running: boolean;

  private constructor(
    config: ResolvedServerConfig,
    httpServer: HttpServer,
    wss: InstanceType<typeof WebSocketServer>,
    supervisorRef: SupervisorRef,
    rateLimiterRef: RateLimiterRef | null,
    connectionRegistry: ConnectionRegistry,
  ) {
    this.#config = config;
    this.#httpServer = httpServer;
    this.#wss = wss;
    this.#supervisorRef = supervisorRef;
    this.#rateLimiterRef = rateLimiterRef;
    this.#connectionRegistry = connectionRegistry;
    this.#blacklist = config.blacklist ?? new SessionBlacklist();
    this.#startedAt = Date.now();
    this.#running = true;
  }

  /**
   * Starts a new NoexServer instance.
   *
   * Creates an HTTP server with a WebSocket upgrade handler and a connection
   * supervisor that manages individual connection GenServers via a
   * simple_one_for_one strategy.
   */
  static async start(config: ServerConfig): Promise<NoexServer> {
    const resolved = resolveConfig(config);

    let rateLimiterRef: RateLimiterRef | null = null;
    if (resolved.rateLimit !== null) {
      rateLimiterRef = await RateLimiter.start({
        maxRequests: resolved.rateLimit.maxRequests,
        windowMs: resolved.rateLimit.windowMs,
        name: `${resolved.name}:rate-limiter`,
      });
    }

    const connectionRegistry = await createConnectionRegistry(resolved.name);

    const auditLog = config.audit !== undefined ? new AuditLog(config.audit) : null;
    const blacklist =
      config.auth !== undefined
        ? new SessionBlacklist(config.revocation)
        : null;

    const procedureEngine = new ProcedureEngine(
      config.store,
      config.rules ?? null,
      config.procedures,
    );

    // Built-in identity: start IdentityManager and synthesize auth config
    // so that auth.login can validate session tokens for reconnect.
    let identityManager: IdentityManager | null = null;
    let authOverride = resolved.auth;

    if (config.auth !== undefined && isBuiltInAuth(config.auth)) {
      identityManager = await IdentityManager.start(config.store, {
        adminSecret: config.auth.adminSecret,
        ...(config.auth.sessionTtl !== undefined ? { sessionTtlMs: config.auth.sessionTtl } : {}),
      });

      // Synthesize an AuthConfig so auth.login works for token-based reconnect.
      authOverride = {
        validate: (token) => identityManager!.validateSession(token),
        required: true,
      };
    }

    const resolvedFull = {
      ...resolved,
      auth: authOverride,
      rateLimiterRef,
      connectionRegistry,
      auditLog,
      blacklist,
      procedureEngine,
      identityManager,
    };
    const supervisorRef = await startConnectionSupervisor(resolvedFull);

    let httpServer: HttpServer;
    let wss: InstanceType<typeof WebSocketServer>;
    try {
      httpServer = createServer();
      wss = new WebSocketServer({
        noServer: true,
        maxPayload: resolvedFull.maxPayloadBytes,
      });

      httpServer.on('upgrade', (request, socket, head) => {
        const pathname = new URL(
          request.url ?? '/',
          `http://${request.headers['host'] ?? 'localhost'}`,
        ).pathname;

        if (pathname !== resolvedFull.path) {
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.once('listening', resolve);
        httpServer.once('error', reject);
        httpServer.listen(resolvedFull.port, resolvedFull.host);
      });
    } catch (error) {
      await stopConnectionSupervisor(supervisorRef);
      if (rateLimiterRef !== null) {
        await RateLimiter.stop(rateLimiterRef);
      }
      await closeConnectionRegistry(connectionRegistry);
      throw error;
    }

    const server = new NoexServer(
      resolvedFull,
      httpServer,
      wss,
      supervisorRef,
      rateLimiterRef,
      connectionRegistry,
    );

    wss.on('connection', (ws, request) => {
      if (!server.#running) {
        ws.close(1001, 'server_shutting_down');
        return;
      }
      const remoteAddress = request.socket.remoteAddress ?? 'unknown';
      void addConnection(
        supervisorRef,
        ws,
        remoteAddress,
        resolvedFull.heartbeat.intervalMs,
        resolvedFull,
      );
    });

    return server;
  }

  /**
   * Gracefully stops the server.
   *
   * 1. Stops accepting new connections (closes the HTTP server).
   * 2. If a grace period is specified, broadcasts a shutdown notification
   *    to all connected clients and waits for them to disconnect (or for
   *    the grace period to expire).
   * 3. Force-stops all remaining connections via the supervisor.
   * 4. Stops the rate limiter.
   */
  async stop(options?: { gracePeriodMs?: number }): Promise<void> {
    if (!this.#running) return;
    this.#running = false;

    const gracePeriodMs = options?.gracePeriodMs ?? 0;

    // 1. Stop accepting new connections.
    const httpClosed = new Promise<void>((resolve, reject) => {
      this.#httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 2. If a grace period is requested, notify clients and wait.
    if (gracePeriodMs > 0 && this.#wss.clients.size > 0) {
      const msg = serializeSystem('shutdown', { gracePeriodMs });
      for (const client of this.#wss.clients) {
        if (client.readyState === WS_OPEN) {
          client.send(msg);
        }
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, gracePeriodMs);

        const check = () => {
          if (this.#wss.clients.size === 0) {
            clearTimeout(timer);
            resolve();
          }
        };

        for (const client of this.#wss.clients) {
          client.once('close', check);
        }
      });
    }

    // 3. Stop all remaining connections via the supervisor.
    //    Each connection's terminate() sends a WS close frame.
    await stopConnectionSupervisor(this.#supervisorRef);

    // 4. Stop the rate limiter if it was started.
    if (this.#rateLimiterRef !== null) {
      await RateLimiter.stop(this.#rateLimiterRef);
    }

    // 5. Stop the identity manager if it was started.
    if (this.#config.identityManager !== null) {
      await this.#config.identityManager.stop();
    }

    // 6. Close the connection registry.
    await closeConnectionRegistry(this.#connectionRegistry);

    // 7. Wait for the HTTP server to finish closing.
    await httpClosed;
  }

  /** The port the server is listening on. */
  get port(): number {
    const addr = this.#httpServer.address();
    if (addr !== null && typeof addr === 'object') {
      return addr.port;
    }
    return this.#config.port;
  }

  /** The number of active WebSocket connections. */
  get connectionCount(): number {
    return getConnectionCount(this.#supervisorRef);
  }

  /** Whether the server is currently running. */
  get isRunning(): boolean {
    return this.#running;
  }

  /** Returns information about all active connections. */
  getConnections(): ConnectionInfo[] {
    return getRegistryConnections(this.#connectionRegistry);
  }

  /**
   * Revokes all connections belonging to a specific user.
   * The user is added to the blacklist and cannot re-authenticate
   * until the blacklist TTL expires.
   *
   * Returns the number of disconnected connections.
   */
  revokeSession(userId: string): number {
    this.#blacklist.revoke(userId);

    const matches = this.#connectionRegistry.select(
      (_key, entry) => entry.metadata.userId === userId,
    );

    for (const m of matches) {
      GenServer.cast(m.ref as ConnectionRef, { type: 'session_revoked' });
    }

    return matches.length;
  }

  /**
   * Revokes connections matching a filter.
   * Each matched user is added to the blacklist.
   *
   * Returns the number of disconnected connections.
   */
  revokeSessions(filter: {
    userId?: string;
    role?: string;
  }): number {
    const matches = this.#connectionRegistry.select((_key, entry) => {
      if (!entry.metadata.authenticated) return false;
      if (
        filter.userId !== undefined &&
        entry.metadata.userId !== filter.userId
      )
        return false;
      if (
        filter.role !== undefined &&
        !entry.metadata.roles.includes(filter.role)
      )
        return false;
      return true;
    });

    for (const m of matches) {
      if (m.metadata.userId !== null) {
        this.#blacklist.revoke(m.metadata.userId);
      }
      GenServer.cast(m.ref as ConnectionRef, { type: 'session_revoked' });
    }

    return matches.length;
  }

  /** Returns server statistics. */
  async getStats(): Promise<ServerStats> {
    const conns = this.getConnections();
    const storeStats = await this.#config.store.getStats();
    const rulesStats =
      this.#config.rules !== null ? this.#config.rules.getStats() : null;

    return {
      name: this.#config.name,
      port: this.port,
      host: this.#config.host,
      connectionCount: this.connectionCount,
      uptimeMs: Date.now() - this.#startedAt,
      authEnabled: this.#config.auth !== null || this.#config.identityManager !== null,
      rateLimitEnabled: this.#config.rateLimit !== null,
      rulesEnabled: this.#config.rules !== null,
      connections: aggregateConnections(conns),
      store: storeStats,
      rules: rulesStats,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function aggregateConnections(conns: ConnectionInfo[]): ConnectionsStats {
  let authenticated = 0;
  let totalStoreSubscriptions = 0;
  let totalRulesSubscriptions = 0;

  for (const c of conns) {
    if (c.authenticated) authenticated++;
    totalStoreSubscriptions += c.storeSubscriptionCount;
    totalRulesSubscriptions += c.rulesSubscriptionCount;
  }

  return {
    active: conns.length,
    authenticated,
    totalStoreSubscriptions,
    totalRulesSubscriptions,
  };
}
