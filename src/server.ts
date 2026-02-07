import { WebSocketServer } from 'ws';
import type { SupervisorRef } from '@hamicek/noex';
import { RateLimiter, type RateLimiterRef } from '@hamicek/noex';
import type { ServerConfig } from './config.js';
import { resolveConfig, type ResolvedServerConfig } from './config.js';
import {
  startConnectionSupervisor,
  addConnection,
  getConnectionCount,
  stopConnectionSupervisor,
} from './connection/connection-supervisor.js';

// ── Stats ─────────────────────────────────────────────────────────

export interface ServerStats {
  readonly name: string;
  readonly port: number;
  readonly host: string;
  readonly connectionCount: number;
  readonly uptimeMs: number;
  readonly authEnabled: boolean;
  readonly rateLimitEnabled: boolean;
  readonly rulesEnabled: boolean;
}

// ── NoexServer ────────────────────────────────────────────────────

export class NoexServer {
  readonly #config: ResolvedServerConfig;
  readonly #wss: InstanceType<typeof WebSocketServer>;
  readonly #supervisorRef: SupervisorRef;
  readonly #rateLimiterRef: RateLimiterRef | null;
  readonly #startedAt: number;
  #running: boolean;

  private constructor(
    config: ResolvedServerConfig,
    wss: InstanceType<typeof WebSocketServer>,
    supervisorRef: SupervisorRef,
    rateLimiterRef: RateLimiterRef | null,
  ) {
    this.#config = config;
    this.#wss = wss;
    this.#supervisorRef = supervisorRef;
    this.#rateLimiterRef = rateLimiterRef;
    this.#startedAt = Date.now();
    this.#running = true;
  }

  /**
   * Starts a new NoexServer instance.
   *
   * Creates a WebSocket server and a connection supervisor that manages
   * individual connection GenServers via a simple_one_for_one strategy.
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

    const resolvedWithRateLimiter = { ...resolved, rateLimiterRef };
    const supervisorRef = await startConnectionSupervisor(resolvedWithRateLimiter);

    let wss: InstanceType<typeof WebSocketServer>;
    try {
      wss = new WebSocketServer({
        port: resolvedWithRateLimiter.port,
        host: resolvedWithRateLimiter.host,
        path: resolvedWithRateLimiter.path,
        maxPayload: resolvedWithRateLimiter.maxPayloadBytes,
      });

      await new Promise<void>((resolve, reject) => {
        wss.once('listening', resolve);
        wss.once('error', reject);
      });
    } catch (error) {
      await stopConnectionSupervisor(supervisorRef);
      if (rateLimiterRef !== null) {
        await RateLimiter.stop(rateLimiterRef);
      }
      throw error;
    }

    const server = new NoexServer(resolvedWithRateLimiter, wss, supervisorRef, rateLimiterRef);

    wss.on('connection', (ws, request) => {
      const remoteAddress = request.socket.remoteAddress ?? 'unknown';
      void addConnection(
        supervisorRef,
        ws,
        remoteAddress,
        resolvedWithRateLimiter.heartbeat.intervalMs,
      );
    });

    return server;
  }

  /**
   * Gracefully stops the server.
   *
   * 1. Stops accepting new connections.
   * 2. Terminates all existing connections via the supervisor.
   */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;

    // Initiate WSS close — stops accepting new connections.
    // The callback fires when the underlying HTTP server is fully closed,
    // which happens after all TCP sockets (including upgraded WS) are closed.
    const wssClosed = new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Stop all existing connections via the supervisor.
    // Each connection's terminate() sends a WS close frame.
    await stopConnectionSupervisor(this.#supervisorRef);

    // Stop the rate limiter if it was started.
    if (this.#rateLimiterRef !== null) {
      await RateLimiter.stop(this.#rateLimiterRef);
    }

    // Wait for WSS to finish closing.
    await wssClosed;
  }

  /** The port the server is listening on. */
  get port(): number {
    const addr = this.#wss.address();
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

  /** Returns server statistics. */
  async getStats(): Promise<ServerStats> {
    return {
      name: this.#config.name,
      port: this.port,
      host: this.#config.host,
      connectionCount: this.connectionCount,
      uptimeMs: Date.now() - this.#startedAt,
      authEnabled: this.#config.auth !== null,
      rateLimitEnabled: this.#config.rateLimit !== null,
      rulesEnabled: this.#config.rules !== null,
    };
  }
}
