import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { NoexServer } from '../../src/index.js';

// ── Helpers ──────────────────────────────────────────────────────

let requestIdCounter = 1;

function connectClient(
  port: number,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('message', (data) => {
      const welcome = JSON.parse(data.toString()) as Record<string, unknown>;
      resolve({ ws, welcome });
    });
    ws.once('error', reject);
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

function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      msgs.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function autoPong(ws: WebSocket): void {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg['type'] === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: msg['timestamp'] }));
    }
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Heartbeat', () => {
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

  // ── Ping sending ──────────────────────────────────────────────

  describe('ping messages', () => {
    it('sends periodic ping messages to connected clients', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 100, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Also respond to pings so connection stays alive long enough
      autoPong(ws);

      const msgs = await collectMessages(ws, 3, 500);
      const pings = msgs.filter((m) => m['type'] === 'ping');

      expect(pings.length).toBeGreaterThanOrEqual(2);
      for (const ping of pings) {
        expect(typeof ping['timestamp']).toBe('number');
        expect(ping['timestamp']).toBeGreaterThan(0);
      }
    });

    it('includes a valid timestamp in each ping', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 80, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      autoPong(ws);

      const before = Date.now();
      const msgs = await collectMessages(ws, 2, 300);
      const after = Date.now();

      const pings = msgs.filter((m) => m['type'] === 'ping');
      expect(pings.length).toBeGreaterThanOrEqual(1);

      const ts = pings[0]!['timestamp'] as number;
      expect(ts).toBeGreaterThanOrEqual(before - 50);
      expect(ts).toBeLessThanOrEqual(after + 50);
    });
  });

  // ── Timeout ──────────────────────────────────────────────────

  describe('timeout', () => {
    it('closes connection when client does not respond to ping', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 100, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Do NOT respond to pings — connection should be closed
      const result = await new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on('close', (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );

      expect(result.code).toBe(4001);
      expect(result.reason).toBe('heartbeat_timeout');
    });

    it('closes only the unresponsive connection', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
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
        heartbeat: { intervalMs: 100, timeoutMs: 50 },
      });

      // c1 responds to pings, c2 does not
      const { ws: ws1 } = await connectClient(server.port);
      const { ws: ws2 } = await connectClient(server.port);
      clients.push(ws1, ws2);

      autoPong(ws1);
      // ws2 intentionally does NOT respond

      // Wait for c2 to time out
      await new Promise<void>((resolve) => {
        ws2.on('close', () => resolve());
      });

      // c1 should still be alive and functional
      expect(ws1.readyState).toBe(WebSocket.OPEN);

      const resp = await sendRequest(ws1, {
        type: 'store.insert',
        bucket: 'data',
        data: { value: 42 },
      });
      expect(resp['type']).toBe('result');
    });
  });

  // ── Keep-alive ──────────────────────────────────────────────

  describe('keep-alive', () => {
    it('keeps connection alive when client responds to pings', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 80, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      autoPong(ws);

      // Wait for several heartbeat intervals
      await flush(400);

      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('connection remains functional after heartbeat exchanges', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      await store.defineBucket('items', {
        key: 'id',
        schema: {
          id: { type: 'string', generated: 'uuid' },
          name: { type: 'string', required: true },
        },
      });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 80, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      autoPong(ws);

      // Wait for a few heartbeats to pass
      await flush(300);

      // Operations should still work
      const resp = await sendRequest(ws, {
        type: 'store.insert',
        bucket: 'items',
        data: { name: 'after-heartbeat' },
      });
      expect(resp['type']).toBe('result');

      const allResp = await sendRequest(ws, {
        type: 'store.all',
        bucket: 'items',
      });
      expect(allResp['type']).toBe('result');
      expect((allResp['data'] as unknown[]).length).toBe(1);
    });

    it('tolerates delayed pong within the interval window', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 150, timeoutMs: 50 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      // Respond to pings after a small delay (but before the next tick)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'ping') {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({ type: 'pong', timestamp: msg['timestamp'] }),
              );
            }
          }, 30);
        }
      });

      await flush(500);

      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  // ── Server stop ──────────────────────────────────────────────

  describe('server stop cleans up heartbeat', () => {
    it('cleans up heartbeat timers on server stop', async () => {
      store = await Store.start({ name: `hb-test-${++storeCounter}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
        heartbeat: { intervalMs: 50, timeoutMs: 25 },
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);
      autoPong(ws);

      await flush(200);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const closed = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      await server.stop();
      server = undefined;

      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });
});
