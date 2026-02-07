import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { SupervisorRef } from '@hamicek/noex';
import { RateLimiter, type RateLimiterRef } from '@hamicek/noex';
import type { ServerConfig } from './config.js';
import { resolveConfig, type ResolvedServerConfig } from './config.js';
import { serializeSystem } from './protocol/serializer.js';
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

// ── WebSocket readyState constants ────────────────────────────────

const WS_OPEN = 1;

// ── NoexServer ────────────────────────────────────────────────────

export class NoexServer {
  readonly #config: ResolvedServerConfig;
  readonly #httpServer: HttpServer;
  readonly #wss: InstanceType<typeof WebSocketServer>;
  readonly #supervisorRef: SupervisorRef;
  readonly #rateLimiterRef: RateLimiterRef | null;
  readonly #startedAt: number;
  #running: boolean;

  private constructor(
    config: ResolvedServerConfig,
    httpServer: HttpServer,
    wss: InstanceType<typeof WebSocketServer>,
    supervisorRef: SupervisorRef,
    rateLimiterRef: RateLimiterRef | null,
  ) {
    this.#config = config;
    this.#httpServer = httpServer;
    this.#wss = wss;
    this.#supervisorRef = supervisorRef;
    this.#rateLimiterRef = rateLimiterRef;
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

    const resolvedWithRateLimiter = { ...resolved, rateLimiterRef };
    const supervisorRef = await startConnectionSupervisor(resolvedWithRateLimiter);

    let httpServer: HttpServer;
    let wss: InstanceType<typeof WebSocketServer>;
    try {
      httpServer = createServer();
      wss = new WebSocketServer({
        noServer: true,
        maxPayload: resolvedWithRateLimiter.maxPayloadBytes,
      });

      httpServer.on('upgrade', (request, socket, head) => {
        const pathname = new URL(
          request.url ?? '/',
          `http://${request.headers['host'] ?? 'localhost'}`,
        ).pathname;

        if (pathname !== resolvedWithRateLimiter.path) {
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
        httpServer.listen(resolvedWithRateLimiter.port, resolvedWithRateLimiter.host);
      });
    } catch (error) {
      await stopConnectionSupervisor(supervisorRef);
      if (rateLimiterRef !== null) {
        await RateLimiter.stop(rateLimiterRef);
      }
      throw error;
    }

    const server = new NoexServer(
      resolvedWithRateLimiter,
      httpServer,
      wss,
      supervisorRef,
      rateLimiterRef,
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
        resolvedWithRateLimiter.heartbeat.intervalMs,
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

    // 5. Wait for the HTTP server to finish closing.
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
