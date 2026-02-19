import { describe, it, expect, afterEach } from 'vitest';
import { GenServer, Supervisor, RegistryInstance } from '@hamicek/noex';
import type { SupervisorRef } from '@hamicek/noex';
import {
  startConnectionSupervisor,
  addConnection,
  getConnectionCount,
  stopConnectionSupervisor,
  type ConnectionRef,
} from '../../../src/connection/connection-supervisor.js';
import type { ResolvedServerConfig } from '../../../src/config.js';
import type { ConnectionMetadata } from '../../../src/connection/connection-registry.js';
import type { WebSocket } from 'ws';

// ── Mock WebSocket ────────────────────────────────────────────────

class MockWebSocket {
  readyState = 1; // WebSocket.OPEN
  readonly sent: string[] = [];
  private readonly events = new Map<string, ((...args: unknown[]) => void)[]>();

  send(data: string): void {
    if (this.readyState === 1) {
      this.sent.push(data);
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.events.get(event) ?? [];
    handlers.push(handler);
    this.events.set(event, handlers);
    return this;
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3; // WebSocket.CLOSED
  }

  simulateEvent(event: string, ...args: unknown[]): void {
    const handlers = this.events.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  clearSent(): void {
    this.sent.length = 0;
  }
}

// ── Test Helpers ──────────────────────────────────────────────────

function createMockConfig(
  overrides?: Partial<ResolvedServerConfig>,
): ResolvedServerConfig {
  return {
    store: {} as ResolvedServerConfig['store'],
    rules: null,
    port: 8080,
    host: '0.0.0.0',
    path: '/',
    maxPayloadBytes: 1_048_576,
    auth: null,
    rateLimit: null,
    rateLimiterRef: null,
    connectionRegistry: new RegistryInstance<ConnectionMetadata>({
      name: 'test-registry',
      keys: 'unique',
    }),
    heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
    backpressure: { maxBufferedBytes: 1_048_576, highWaterMark: 0.8 },
    connectionLimits: { maxSubscriptionsPerConnection: 100 },
    auditLog: null,
    blacklist: null,
    procedureEngine: null,
    identityManager: null,
    name: 'test-server',
    ...overrides,
  };
}

function asWs(mock: MockWebSocket): WebSocket {
  return mock as unknown as WebSocket;
}

function flush(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResponse(ws: MockWebSocket, index = 0): Record<string, unknown> {
  return JSON.parse(ws.sent[index]!) as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ConnectionSupervisor', () => {
  let supervisorRef: SupervisorRef | undefined;

  afterEach(async () => {
    if (supervisorRef && Supervisor.isRunning(supervisorRef)) {
      await stopConnectionSupervisor(supervisorRef);
    }
    supervisorRef = undefined;
  });

  // ── startConnectionSupervisor ──────────────────────────────────

  describe('startConnectionSupervisor', () => {
    it('starts a running supervisor', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      expect(Supervisor.isRunning(supervisorRef)).toBe(true);
    });

    it('starts with zero children', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      expect(getConnectionCount(supervisorRef)).toBe(0);
    });
  });

  // ── addConnection ──────────────────────────────────────────────

  describe('addConnection', () => {
    it('adds a connection child to the supervisor', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws = new MockWebSocket();
      const ref = await addConnection(supervisorRef, asWs(ws), '127.0.0.1', 30_000, config);

      expect(GenServer.isRunning(ref)).toBe(true);
      expect(getConnectionCount(supervisorRef)).toBe(1);
    });

    it('sends welcome message on connect', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws), '127.0.0.1', 30_000, config);

      expect(ws.sent).toHaveLength(1);
      const welcome = parseResponse(ws);
      expect(welcome['type']).toBe('welcome');
      expect(welcome['version']).toBe('1.0.0');
      expect(welcome['requiresAuth']).toBe(false);
    });

    it('manages multiple connections independently', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const ws3 = new MockWebSocket();

      const ref1 = await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      const ref2 = await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);
      const ref3 = await addConnection(supervisorRef, asWs(ws3), '10.0.0.3', 30_000, config);

      expect(getConnectionCount(supervisorRef)).toBe(3);
      expect(GenServer.isRunning(ref1)).toBe(true);
      expect(GenServer.isRunning(ref2)).toBe(true);
      expect(GenServer.isRunning(ref3)).toBe(true);
    });

    it('forwards WebSocket messages to the GenServer', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws), '127.0.0.1', 30_000, config);
      ws.clearSent();

      ws.simulateEvent('message', Buffer.from('{"id":1,"type":"store.all"}'));
      await flush();

      expect(ws.sent).toHaveLength(1);
      const response = parseResponse(ws);
      expect(response['id']).toBe(1);
      expect(response['type']).toBe('error');
    });

    it('stops GenServer on WebSocket close', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws = new MockWebSocket();
      const ref = await addConnection(supervisorRef, asWs(ws), '127.0.0.1', 30_000, config);

      expect(GenServer.isRunning(ref)).toBe(true);

      ws.simulateEvent('close', 1000, Buffer.from(''));
      await flush(150);

      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('decrements connection count after close', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);

      expect(getConnectionCount(supervisorRef)).toBe(2);

      ws1.simulateEvent('close', 1000, Buffer.from(''));
      await flush(150);

      // Temporary children are removed from the supervisor once stopped
      expect(getConnectionCount(supervisorRef)).toBe(1);
    });
  });

  // ── stopConnectionSupervisor ───────────────────────────────────

  describe('stopConnectionSupervisor', () => {
    it('stops the supervisor', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      await stopConnectionSupervisor(supervisorRef);
      expect(Supervisor.isRunning(supervisorRef)).toBe(false);
      supervisorRef = undefined;
    });

    it('closes all active WebSocket connections on shutdown', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);

      await stopConnectionSupervisor(supervisorRef);

      expect(ws1.readyState).toBe(3); // CLOSED
      expect(ws2.readyState).toBe(3); // CLOSED
      supervisorRef = undefined;
    });

    it('stops all child GenServers on shutdown', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const ref1 = await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      const ref2 = await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);

      await stopConnectionSupervisor(supervisorRef);

      expect(GenServer.isRunning(ref1)).toBe(false);
      expect(GenServer.isRunning(ref2)).toBe(false);
      supervisorRef = undefined;
    });
  });

  // ── temporary restart strategy ─────────────────────────────────

  describe('temporary restart strategy', () => {
    it('does not restart crashed connections', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws = new MockWebSocket();
      const ref = await addConnection(supervisorRef, asWs(ws), '127.0.0.1', 30_000, config);

      // Force-stop the GenServer (simulating a crash)
      await GenServer.stop(ref, 'crash');
      await flush(150);

      expect(GenServer.isRunning(ref)).toBe(false);
      // Should not have been restarted — count should be 0
      expect(getConnectionCount(supervisorRef)).toBe(0);
    });
  });

  // ── isolation ──────────────────────────────────────────────────

  describe('connection isolation', () => {
    it('one connection crash does not affect others', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const ref1 = await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      const ref2 = await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);

      // Crash connection 1
      await GenServer.stop(ref1, 'crash');
      await flush(150);

      expect(GenServer.isRunning(ref1)).toBe(false);
      expect(GenServer.isRunning(ref2)).toBe(true);
    });

    it('each connection receives its own welcome message', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);

      expect(ws1.sent).toHaveLength(1);
      expect(ws2.sent).toHaveLength(1);
      expect(parseResponse(ws1)['type']).toBe('welcome');
      expect(parseResponse(ws2)['type']).toBe('welcome');
    });

    it('messages are routed to the correct connection', async () => {
      const config = createMockConfig();
      supervisorRef = await startConnectionSupervisor(config);

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      await addConnection(supervisorRef, asWs(ws1), '10.0.0.1', 30_000, config);
      await addConnection(supervisorRef, asWs(ws2), '10.0.0.2', 30_000, config);
      ws1.clearSent();
      ws2.clearSent();

      ws1.simulateEvent('message', Buffer.from('{"id":1,"type":"store.all"}'));
      await flush();

      // Only ws1 should have received a response
      expect(ws1.sent).toHaveLength(1);
      expect(ws2.sent).toHaveLength(0);
    });
  });
});
