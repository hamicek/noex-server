import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
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

function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for push on ${subscriptionId}`));
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function expectNoPush(
  ws: WebSocket,
  subscriptionId: string,
  ms = 300,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve();
    }, ms);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'push' && msg['subscriptionId'] === subscriptionId) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(`Unexpected push on ${subscriptionId}`));
      }
    };
    ws.on('message', handler);
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

describe('Integration: Rules Proxy over WebSocket', () => {
  let server: NoexServer;
  let store: Store;
  let engine: RuleEngine;
  const clients: WebSocket[] = [];
  let instanceCounter = 0;
  let ws: WebSocket;

  beforeEach(async () => {
    requestIdCounter = 1;
    const suffix = ++instanceCounter;
    store = await Store.start({ name: `rules-test-store-${suffix}` });
    engine = await RuleEngine.start({ name: `rules-test-engine-${suffix}` });

    server = await NoexServer.start({
      store,
      rules: engine,
      port: 0,
      host: '127.0.0.1',
    });

    const conn = await connectClient(server.port);
    ws = conn.ws;
    clients.push(ws);
  });

  afterEach(async () => {
    for (const c of clients) {
      if (c.readyState !== WebSocket.CLOSED) {
        c.close();
      }
    }
    clients.length = 0;

    if (server?.isRunning) {
      await server.stop();
    }

    if (engine) {
      await engine.stop();
    }

    if (store) {
      await store.stop();
    }
  });

  // ── rules.emit ─────────────────────────────────────────────────

  describe('rules.emit', () => {
    it('emits an event and returns the event object', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'order.created',
        data: { orderId: '123', total: 99 },
      });

      expect(resp['type']).toBe('result');
      const event = resp['data'] as Record<string, unknown>;
      expect(event['topic']).toBe('order.created');
      expect((event['data'] as Record<string, unknown>)['orderId']).toBe('123');
      expect(typeof event['id']).toBe('string');
      expect(typeof event['timestamp']).toBe('number');
    });

    it('emits with default empty data when data is omitted', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'system.ping',
      });

      expect(resp['type']).toBe('result');
      const event = resp['data'] as Record<string, unknown>;
      expect(event['topic']).toBe('system.ping');
    });

    it('emits correlated event when correlationId is provided', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'payment.received',
        data: { amount: 50 },
        correlationId: 'corr-001',
      });

      expect(resp['type']).toBe('result');
      const event = resp['data'] as Record<string, unknown>;
      expect(event['topic']).toBe('payment.received');
      expect(event['correlationId']).toBe('corr-001');
    });

    it('returns VALIDATION_ERROR when topic is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.emit',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── rules.setFact / rules.getFact ─────────────────────────────

  describe('rules.setFact & rules.getFact', () => {
    it('sets a fact and retrieves it', async () => {
      const setResp = await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'user:1:name',
        value: 'Alice',
      });

      expect(setResp['type']).toBe('result');
      const fact = setResp['data'] as Record<string, unknown>;
      expect(fact['key']).toBe('user:1:name');
      expect(fact['value']).toBe('Alice');

      const getResp = await sendRequest(ws, {
        type: 'rules.getFact',
        key: 'user:1:name',
      });

      expect(getResp['type']).toBe('result');
      expect(getResp['data']).toBe('Alice');
    });

    it('returns null for non-existent fact', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.getFact',
        key: 'nonexistent',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toBeNull();
    });

    it('returns VALIDATION_ERROR when key is missing for setFact', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.setFact',
        value: 42,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR when value is missing for setFact', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'some-key',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── rules.deleteFact ──────────────────────────────────────────

  describe('rules.deleteFact', () => {
    it('deletes an existing fact', async () => {
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'temp:key',
        value: 'temporary',
      });

      const resp = await sendRequest(ws, {
        type: 'rules.deleteFact',
        key: 'temp:key',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual({ deleted: true });

      const getResp = await sendRequest(ws, {
        type: 'rules.getFact',
        key: 'temp:key',
      });
      expect(getResp['data']).toBeNull();
    });

    it('returns deleted: false for non-existent fact', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.deleteFact',
        key: 'does-not-exist',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual({ deleted: false });
    });
  });

  // ── rules.queryFacts ──────────────────────────────────────────

  describe('rules.queryFacts', () => {
    it('queries facts by pattern', async () => {
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'user:1:name',
        value: 'Alice',
      });
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'user:2:name',
        value: 'Bob',
      });
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'system:version',
        value: '1.0',
      });

      const resp = await sendRequest(ws, {
        type: 'rules.queryFacts',
        pattern: 'user:*:name',
      });

      expect(resp['type']).toBe('result');
      const facts = resp['data'] as Array<Record<string, unknown>>;
      expect(facts).toHaveLength(2);
      const keys = facts.map((f) => f['key']);
      expect(keys).toContain('user:1:name');
      expect(keys).toContain('user:2:name');
    });

    it('returns empty array for non-matching pattern', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.queryFacts',
        pattern: 'nothing:*',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual([]);
    });

    it('returns VALIDATION_ERROR when pattern is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.queryFacts',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── rules.getAllFacts ──────────────────────────────────────────

  describe('rules.getAllFacts', () => {
    it('returns all facts', async () => {
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'a',
        value: 1,
      });
      await sendRequest(ws, {
        type: 'rules.setFact',
        key: 'b',
        value: 2,
      });

      const resp = await sendRequest(ws, {
        type: 'rules.getAllFacts',
      });

      expect(resp['type']).toBe('result');
      const facts = resp['data'] as Array<Record<string, unknown>>;
      expect(facts.length).toBeGreaterThanOrEqual(2);
      const keys = facts.map((f) => f['key']);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
    });

    it('returns empty array when no facts exist', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.getAllFacts',
      });

      expect(resp['type']).toBe('result');
      expect(resp['data']).toEqual([]);
    });
  });

  // ── rules.stats ───────────────────────────────────────────────

  describe('rules.stats', () => {
    it('returns engine statistics', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.stats',
      });

      expect(resp['type']).toBe('result');
      const stats = resp['data'] as Record<string, unknown>;
      expect(typeof stats['rulesCount']).toBe('number');
      expect(typeof stats['factsCount']).toBe('number');
      expect(typeof stats['eventsProcessed']).toBe('number');
    });
  });

  // ── rules.subscribe / rules.unsubscribe ───────────────────────

  describe('rules.subscribe', () => {
    it('returns subscriptionId on subscribe', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'order.*',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(typeof data['subscriptionId']).toBe('string');
    });

    it('receives push when matching event is emitted', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'order.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'order.created',
        data: { orderId: 'abc' },
      });

      const push = await pushPromise;

      expect(push['type']).toBe('push');
      expect(push['channel']).toBe('event');
      expect(push['subscriptionId']).toBe(subscriptionId);

      const pushData = push['data'] as Record<string, unknown>;
      expect(pushData['topic']).toBe('order.created');
      const event = pushData['event'] as Record<string, unknown>;
      expect(event['topic']).toBe('order.created');
      expect((event['data'] as Record<string, unknown>)['orderId']).toBe('abc');
    });

    it('does not receive push for non-matching events', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'order.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const noPushPromise = expectNoPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'payment.received',
        data: { amount: 100 },
      });

      await noPushPromise;
    });

    it('receives pushes for wildcard subscription', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: '*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'any.event',
        data: { x: 1 },
      });

      const push = await pushPromise;
      const pushData = push['data'] as Record<string, unknown>;
      expect(pushData['topic']).toBe('any.event');
    });

    it('returns VALIDATION_ERROR when pattern is missing', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.subscribe',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  describe('rules.unsubscribe', () => {
    it('unsubscribes and returns confirmation', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'test.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const unsubResp = await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId,
      });

      expect(unsubResp['type']).toBe('result');
      expect(unsubResp['data']).toEqual({ unsubscribed: true });
    });

    it('stops push notifications after unsubscribe', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'test.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId,
      });

      const noPushPromise = expectNoPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'test.event',
        data: { x: 1 },
      });

      await noPushPromise;
    });

    it('returns NOT_FOUND for unknown subscriptionId', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId: 'sub-nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when unsubscribing twice', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'x.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId,
      });

      const resp = await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId,
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── Multiple subscriptions ────────────────────────────────────

  describe('multiple subscriptions', () => {
    it('supports multiple active subscriptions on the same connection', async () => {
      const sub1Resp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'order.*',
      });
      const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const sub2Resp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'payment.*',
      });
      const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      expect(sub1Id).not.toBe(sub2Id);

      // Emit order event — only sub1 gets push
      const push1Promise = waitForPush(ws, sub1Id);
      const noPush2Promise = expectNoPush(ws, sub2Id);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'order.created',
        data: { orderId: '1' },
      });

      const push1 = await push1Promise;
      expect((push1['data'] as Record<string, unknown>)['topic']).toBe('order.created');
      await noPush2Promise;

      // Emit payment event — only sub2 gets push
      const push2Promise = waitForPush(ws, sub2Id);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'payment.received',
        data: { amount: 100 },
      });

      const push2 = await push2Promise;
      expect((push2['data'] as Record<string, unknown>)['topic']).toBe('payment.received');
    });

    it('unsubscribing one does not affect others', async () => {
      const sub1Resp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'a.*',
      });
      const sub1Id = (sub1Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const sub2Resp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'a.*',
      });
      const sub2Id = (sub2Resp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      await sendRequest(ws, {
        type: 'rules.unsubscribe',
        subscriptionId: sub1Id,
      });

      const pushPromise = waitForPush(ws, sub2Id);
      const noPushPromise = expectNoPush(ws, sub1Id);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'a.event',
        data: {},
      });

      await pushPromise;
      await noPushPromise;
    });
  });

  // ── Multi-client ──────────────────────────────────────────────

  describe('multi-client subscriptions', () => {
    it('pushes to subscriber when another client emits', async () => {
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'chat.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)['subscriptionId'] as string;

      const conn2 = await connectClient(server.port);
      const ws2 = conn2.ws;
      clients.push(ws2);

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws2, {
        type: 'rules.emit',
        topic: 'chat.message',
        data: { from: 'client2', text: 'hello' },
      });

      const push = await pushPromise;
      const pushData = push['data'] as Record<string, unknown>;
      expect(pushData['topic']).toBe('chat.message');
    });
  });

  // ── Cleanup on disconnect ─────────────────────────────────────

  describe('cleanup on disconnect', () => {
    it('subscriptions are cleaned up when client disconnects', async () => {
      await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: '*',
      });

      await closeClient(ws);
      await flush(200);

      // Emit event — should not cause errors on server
      await engine.emit('cleanup.test', { x: 1 });
      await flush(100);

      expect(server.isRunning).toBe(true);
    });
  });

  // ── Rules not configured ──────────────────────────────────────

  describe('rules not configured', () => {
    let noRulesServer: NoexServer;
    let noRulesStore: Store;
    let noRulesWs: WebSocket;

    beforeEach(async () => {
      noRulesStore = await Store.start({ name: `no-rules-${instanceCounter}` });
      noRulesServer = await NoexServer.start({
        store: noRulesStore,
        port: 0,
        host: '127.0.0.1',
      });
      const conn = await connectClient(noRulesServer.port);
      noRulesWs = conn.ws;
    });

    afterEach(async () => {
      if (noRulesWs?.readyState !== WebSocket.CLOSED) {
        noRulesWs.close();
      }
      if (noRulesServer?.isRunning) {
        await noRulesServer.stop();
      }
      if (noRulesStore) {
        await noRulesStore.stop();
      }
    });

    it('returns RULES_NOT_AVAILABLE for rules.emit', async () => {
      const resp = await sendRequest(noRulesWs, {
        type: 'rules.emit',
        topic: 'test',
        data: {},
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RULES_NOT_AVAILABLE');
    });

    it('returns RULES_NOT_AVAILABLE for rules.subscribe', async () => {
      const resp = await sendRequest(noRulesWs, {
        type: 'rules.subscribe',
        pattern: '*',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RULES_NOT_AVAILABLE');
    });

    it('returns RULES_NOT_AVAILABLE for rules.getFact', async () => {
      const resp = await sendRequest(noRulesWs, {
        type: 'rules.getFact',
        key: 'test',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RULES_NOT_AVAILABLE');
    });
  });

  // ── Unknown rules operation ───────────────────────────────────

  describe('unknown rules operation', () => {
    it('returns UNKNOWN_OPERATION for invalid rules.* type', async () => {
      const resp = await sendRequest(ws, {
        type: 'rules.nonexistent',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('UNKNOWN_OPERATION');
    });
  });
});
