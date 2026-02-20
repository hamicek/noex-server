import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';

// ── Helpers ──────────────────────────────────────────────────────

let requestIdCounter = 1;

function connectClient(
  port: number,
  options?: { headers?: Record<string, string> },
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
    });
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
  });
}

function expectConnectionRejected(
  port: number,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
    });
    ws.once('open', () => {
      ws.close();
      reject(new Error('Expected connection to be rejected'));
    });
    ws.once('error', () => {
      resolve();
    });
  });
}

function sendRequest(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = requestIdCounter++;
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['id'] === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Security Hardening', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  const clients: WebSocket[] = [];
  let storeCounter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }
    server = undefined;

    if (store) {
      await store.stop();
    }
    store = undefined;
  });

  // ── Binary Frame Rejection ────────────────────────────────────

  describe('binary frame rejection', () => {
    it('rejects binary frames with close code 1003', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      ws.send(Buffer.from([0x00, 0x01]), { binary: true });

      const { code, reason } = await closed;
      expect(code).toBe(1003);
      expect(reason).toBe('binary_not_supported');
    });

    it('still accepts text frames after binary rejection test', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      server = await NoexServer.start({ store, port: 0, host: '127.0.0.1' });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'data',
        data: { value: 42 },
      });

      expect(resp['type']).toBe('result');
    });
  });

  // ── Origin Validation ──────────────────────────────────────────

  describe('origin validation', () => {
    it('allows connection with a permitted origin', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['https://app.example.com'],
      });

      const { ws, welcome } = await connectClient(server.port, {
        headers: { Origin: 'https://app.example.com' },
      });
      clients.push(ws);

      expect(welcome['type']).toBe('welcome');
    });

    it('rejects connection with a disallowed origin', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['https://app.example.com'],
      });

      await expectConnectionRejected(server.port, {
        headers: { Origin: 'https://evil.example.com' },
      });
    });

    it('allows connection without Origin header (server-to-server)', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['https://app.example.com'],
      });

      // ws library does not send Origin by default — simulates a server-to-server client
      const { ws, welcome } = await connectClient(server.port);
      clients.push(ws);

      expect(welcome['type']).toBe('welcome');
    });

    it('skips origin check when allowedOrigins is not configured', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        // no allowedOrigins — validation disabled
      });

      const { ws, welcome } = await connectClient(server.port, {
        headers: { Origin: 'https://any-origin.example.com' },
      });
      clients.push(ws);

      expect(welcome['type']).toBe('welcome');
    });

    it('supports multiple allowed origins', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['https://app1.example.com', 'https://app2.example.com'],
      });

      const { ws: ws1, welcome: w1 } = await connectClient(server.port, {
        headers: { Origin: 'https://app2.example.com' },
      });
      clients.push(ws1);
      expect(w1['type']).toBe('welcome');

      await expectConnectionRejected(server.port, {
        headers: { Origin: 'https://app3.example.com' },
      });
    });
  });

  // ── Max Connections Per IP ────────────────────────────────────

  describe('max connections per IP', () => {
    it('rejects connection when IP exceeds the limit', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        maxConnectionsPerIp: 2,
      });

      // Open 2 connections — both should succeed
      const { ws: ws1 } = await connectClient(server.port);
      clients.push(ws1);
      const { ws: ws2 } = await connectClient(server.port);
      clients.push(ws2);

      // 3rd connection from same IP should be rejected with 4003
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        const ws3 = new WebSocket(`ws://127.0.0.1:${server!.port}`);
        clients.push(ws3);
        ws3.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      const { code, reason } = await closed;
      expect(code).toBe(4003);
      expect(reason).toBe('too_many_connections');
    });

    it('allows new connection after one disconnects', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        maxConnectionsPerIp: 2,
      });

      const { ws: ws1 } = await connectClient(server.port);
      clients.push(ws1);
      const { ws: ws2 } = await connectClient(server.port);
      clients.push(ws2);

      // Close one connection to free a slot
      await closeClient(ws1);

      // Now a new connection should succeed
      const { ws: ws3, welcome } = await connectClient(server.port);
      clients.push(ws3);
      expect(welcome['type']).toBe('welcome');
    });

    it('does not limit when maxConnectionsPerIp is not configured', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      // Open 5 connections without any limit — all should succeed
      for (let i = 0; i < 5; i++) {
        const { ws } = await connectClient(server.port);
        clients.push(ws);
      }

      expect(server.connectionCount).toBe(5);
    });

    it('existing connections remain functional after rejecting excess', async () => {
      store = await Store.start({ name: `sec-test-${++storeCounter}` });
      await store.defineBucket('data', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          value: { type: 'number', required: true },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        maxConnectionsPerIp: 1,
      });

      const { ws: ws1 } = await connectClient(server.port);
      clients.push(ws1);

      // 2nd connection gets rejected
      const closed = new Promise<void>((resolve) => {
        const ws2 = new WebSocket(`ws://127.0.0.1:${server!.port}`);
        clients.push(ws2);
        ws2.once('close', () => resolve());
      });
      await closed;

      // Original connection still works
      const resp = await sendRequest(ws1, {
        type: 'store.insert',
        bucket: 'data',
        data: { value: 99 },
      });
      expect(resp['type']).toBe('result');
    });
  });
});
