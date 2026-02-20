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
});
