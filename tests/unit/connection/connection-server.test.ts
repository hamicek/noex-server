import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, type GenServerRef } from '@hamicek/noex';
import {
  createConnectionBehavior,
  startConnection,
  type ConnectionState,
  type ConnectionCast,
} from '../../../src/connection/connection-server.js';
import { RegistryInstance } from '@hamicek/noex';
import type { ResolvedServerConfig, AuthConfig } from '../../../src/config.js';
import type { ConnectionMetadata } from '../../../src/connection/connection-registry.js';
import type { WebSocket } from 'ws';

// ── Mock WebSocket ────────────────────────────────────────────────

class MockWebSocket {
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
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
    name: 'test-server',
    ...overrides,
  };
}

function mockAuth(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    validate: async () => null,
    ...overrides,
  };
}

function flush(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResponse(ws: MockWebSocket, index = 0): Record<string, unknown> {
  return JSON.parse(ws.sent[index]!) as Record<string, unknown>;
}

function asWs(mock: MockWebSocket): WebSocket {
  return mock as unknown as WebSocket;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ConnectionServer', () => {
  let ws: MockWebSocket;
  let config: ResolvedServerConfig;
  let ref: GenServerRef<ConnectionState, never, ConnectionCast, never> | undefined;

  afterEach(async () => {
    if (ref && GenServer.isRunning(ref)) {
      await GenServer.stop(ref);
    }
    ref = undefined;
  });

  // ── init ──────────────────────────────────────────────────────

  describe('init', () => {
    it('sends welcome message on connect', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );

      expect(ws.sent).toHaveLength(1);
      const welcome = parseResponse(ws);
      expect(welcome['type']).toBe('welcome');
      expect(welcome['version']).toBe('1.0.0');
      expect(welcome['requiresAuth']).toBe(false);
      expect(typeof welcome['serverTime']).toBe('number');
    });

    it('sends requiresAuth: true when auth is configured', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({ auth: mockAuth() });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );

      const welcome = parseResponse(ws);
      expect(welcome['requiresAuth']).toBe(true);
    });

    it('sends requiresAuth: false when auth.required is false', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({ auth: mockAuth({ required: false }) });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );

      const welcome = parseResponse(ws);
      expect(welcome['requiresAuth']).toBe(false);
    });
  });

  // ── message handling ──────────────────────────────────────────

  describe('message handling', () => {
    beforeEach(async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();
    });

    it('responds with PARSE_ERROR for invalid JSON', async () => {
      GenServer.cast(ref!, { type: 'ws_message', raw: 'not json' });
      await flush();

      expect(ws.sent).toHaveLength(1);
      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['code']).toBe('PARSE_ERROR');
      expect(response['id']).toBe(0);
    });

    it('responds with INVALID_REQUEST for missing id', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"type":"store.all"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['code']).toBe('INVALID_REQUEST');
    });

    it('responds with INVALID_REQUEST for missing type', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":1}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['code']).toBe('INVALID_REQUEST');
    });

    it('handles pong message without sending response', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"type":"pong","timestamp":12345}',
      });
      await flush();

      expect(ws.sent).toHaveLength(0);
    });

    it('responds with error for store operations on mock store', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":1,"type":"store.all","bucket":"users"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['id']).toBe(1);
      // Mock store has no bucket() method → INTERNAL_ERROR
      expect(response['code']).toBe('INTERNAL_ERROR');
    });

    it('responds with RULES_NOT_AVAILABLE when rules not configured', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":2,"type":"rules.emit","topic":"test","data":{}}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['id']).toBe(2);
      expect(response['code']).toBe('RULES_NOT_AVAILABLE');
    });

    it('responds with UNKNOWN_OPERATION for auth.login when auth not configured', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":3,"type":"auth.login","token":"abc"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['id']).toBe(3);
      expect(response['code']).toBe('UNKNOWN_OPERATION');
    });

    it('responds with UNKNOWN_OPERATION for completely unknown types', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":4,"type":"unknown.action"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['id']).toBe(4);
      expect(response['code']).toBe('UNKNOWN_OPERATION');
      expect(response['message']).toBe('Unknown operation "unknown.action"');
    });

    it('does not send response when WebSocket is closed', async () => {
      ws.readyState = 3; // CLOSED
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: 'not json',
      });
      await flush();

      expect(ws.sent).toHaveLength(0);
    });

    it('handles multiple sequential messages correctly', async () => {
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":1,"type":"store.get","bucket":"users","key":"u1"}',
      });
      GenServer.cast(ref!, {
        type: 'ws_message',
        raw: '{"id":2,"type":"store.all","bucket":"items"}',
      });
      await flush();

      expect(ws.sent).toHaveLength(2);
      const r1 = parseResponse(ws, 0);
      const r2 = parseResponse(ws, 1);
      expect(r1['id']).toBe(1);
      expect(r2['id']).toBe(2);
    });
  });

  // ── auth check ────────────────────────────────────────────────

  describe('auth check', () => {
    it('allows requests when auth is not configured', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      GenServer.cast(ref, {
        type: 'ws_message',
        raw: '{"id":1,"type":"store.all"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['code']).not.toBe('UNAUTHORIZED');
    });

    it('rejects requests when auth required and not authenticated', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({ auth: mockAuth() });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      GenServer.cast(ref, {
        type: 'ws_message',
        raw: '{"id":1,"type":"store.all","bucket":"users"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('error');
      expect(response['id']).toBe(1);
      expect(response['code']).toBe('UNAUTHORIZED');
      expect(response['message']).toBe('Authentication required');
    });

    it('allows auth.login even when not authenticated', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({
        auth: mockAuth({
          validate: async () => ({
            userId: 'user-1',
            roles: ['user'],
          }),
        }),
      });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      GenServer.cast(ref, {
        type: 'ws_message',
        raw: '{"id":1,"type":"auth.login","token":"test"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['type']).toBe('result');
      expect(response['code']).not.toBe('UNAUTHORIZED');
    });

    it('allows ping even when not authenticated', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({ auth: mockAuth() });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      GenServer.cast(ref, {
        type: 'ws_message',
        raw: '{"id":1,"type":"ping"}',
      });
      await flush();

      const response = parseResponse(ws);
      expect(response['code']).not.toBe('UNAUTHORIZED');
    });
  });

  // ── push messages ─────────────────────────────────────────────

  describe('push messages', () => {
    beforeEach(async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();
    });

    it('sends push message via WebSocket', async () => {
      GenServer.cast(ref!, {
        type: 'push',
        subscriptionId: 'sub-1',
        channel: 'subscription',
        data: { users: [] },
      });
      await flush();

      expect(ws.sent).toHaveLength(1);
      const push = parseResponse(ws);
      expect(push['type']).toBe('push');
      expect(push['subscriptionId']).toBe('sub-1');
      expect(push['channel']).toBe('subscription');
      expect(push['data']).toEqual({ users: [] });
    });

    it('does not send push when WebSocket is closed', async () => {
      ws.readyState = 3; // CLOSED
      GenServer.cast(ref!, {
        type: 'push',
        subscriptionId: 'sub-1',
        channel: 'subscription',
        data: { users: [] },
      });
      await flush();

      expect(ws.sent).toHaveLength(0);
    });
  });

  // ── terminate ─────────────────────────────────────────────────

  describe('terminate', () => {
    it('closes WebSocket on terminate with normal reason', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );

      await GenServer.stop(ref);
      ref = undefined;

      expect(ws.readyState).toBe(3); // CLOSED
    });

    it('does not close WebSocket if already closed', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );

      ws.readyState = 3; // Simulate external close

      await GenServer.stop(ref);
      ref = undefined;

      expect(ws.readyState).toBe(3);
    });
  });

  // ── startConnection ───────────────────────────────────────────

  describe('startConnection', () => {
    it('creates GenServer and sends welcome message', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await startConnection(asWs(ws), '127.0.0.1', config);

      expect(GenServer.isRunning(ref)).toBe(true);
      expect(ws.sent).toHaveLength(1);
      const welcome = parseResponse(ws);
      expect(welcome['type']).toBe('welcome');
    });

    it('forwards WebSocket messages to GenServer', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await startConnection(asWs(ws), '127.0.0.1', config);
      ws.clearSent();

      ws.simulateEvent('message', Buffer.from('{"id":1,"type":"store.all"}'));
      await flush();

      expect(ws.sent).toHaveLength(1);
      const response = parseResponse(ws);
      expect(response['id']).toBe(1);
      expect(response['type']).toBe('error');
      // Missing bucket field → VALIDATION_ERROR from store-proxy
      expect(response['code']).toBe('VALIDATION_ERROR');
    });

    it('stops GenServer on WebSocket close', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await startConnection(asWs(ws), '127.0.0.1', config);

      expect(GenServer.isRunning(ref)).toBe(true);

      ws.simulateEvent('close', 1000, Buffer.from(''));
      await flush(100);

      expect(GenServer.isRunning(ref)).toBe(false);
      ref = undefined;
    });

    it('handles WebSocket error gracefully', async () => {
      ws = new MockWebSocket();
      config = createMockConfig();
      ref = await startConnection(asWs(ws), '127.0.0.1', config);

      ws.simulateEvent('error', new Error('connection reset'));
      await flush();

      expect(GenServer.isRunning(ref)).toBe(true);
    });
  });

  // ── backpressure ─────────────────────────────────────────────

  describe('backpressure', () => {
    it('drops push messages when write buffer exceeds high water mark', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({
        backpressure: { maxBufferedBytes: 100, highWaterMark: 0.5 },
      });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      // Simulate high buffer — threshold is 100 * 0.5 = 50
      ws.bufferedAmount = 50;

      GenServer.cast(ref, {
        type: 'push',
        subscriptionId: 'sub-1',
        channel: 'subscription',
        data: { users: [] },
      });
      await flush();

      expect(ws.sent).toHaveLength(0);
    });

    it('sends push messages when write buffer is below high water mark', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({
        backpressure: { maxBufferedBytes: 100, highWaterMark: 0.5 },
      });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      ws.bufferedAmount = 49;

      GenServer.cast(ref, {
        type: 'push',
        subscriptionId: 'sub-1',
        channel: 'subscription',
        data: { users: [] },
      });
      await flush();

      expect(ws.sent).toHaveLength(1);
      const push = parseResponse(ws);
      expect(push['type']).toBe('push');
      expect(push['subscriptionId']).toBe('sub-1');
    });

    it('does not affect request-response messages under backpressure', async () => {
      ws = new MockWebSocket();
      config = createMockConfig({
        backpressure: { maxBufferedBytes: 100, highWaterMark: 0.5 },
      });
      ref = await GenServer.start(
        createConnectionBehavior(asWs(ws), '127.0.0.1', config, 'test-conn'),
      );
      ws.clearSent();

      ws.bufferedAmount = 80;

      // Request-response should still work (errors are fine — mock store)
      GenServer.cast(ref, {
        type: 'ws_message',
        raw: '{"id":1,"type":"store.all","bucket":"users"}',
      });
      await flush();

      expect(ws.sent).toHaveLength(1);
      const response = parseResponse(ws);
      expect(response['id']).toBe(1);
    });
  });
});
