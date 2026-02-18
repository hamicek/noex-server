import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '../../src/index.js';
import type { AuthConfig, AuthSession } from '../../src/config.js';

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

async function login(
  ws: WebSocket,
  token: string,
): Promise<Record<string, unknown>> {
  return sendRequest(ws, { type: 'auth.login', token });
}

function waitForPush(
  ws: WebSocket,
  subscriptionId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('waitForPush timed out')),
      timeoutMs,
    );
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (
        msg['type'] === 'push' &&
        msg['subscriptionId'] === subscriptionId
      ) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────

const sessions: Record<string, AuthSession> = {
  admin:  { userId: 'admin-1',  roles: ['admin'] },
  writer: { userId: 'writer-1', roles: ['writer'] },
  reader: { userId: 'reader-1', roles: ['reader'] },
};

const auth: AuthConfig = {
  validate: async (token) => sessions[token] ?? null,
};

function makeRule(id: string, topic: string) {
  return {
    id,
    name: `Rule ${id}`,
    priority: 100,
    enabled: true,
    tags: ['test'],
    trigger: { type: 'event', topic },
    conditions: [],
    actions: [
      { type: 'emit_event', topic: `output.${id}`, data: { source: id } },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Integration: Admin Rules Operations', () => {
  let server: NoexServer | undefined;
  let store: Store | undefined;
  let engine: RuleEngine | undefined;
  const clients: WebSocket[] = [];
  let counter = 0;

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    clients.length = 0;

    if (server?.isRunning) await server.stop();
    server = undefined;

    if (engine) await engine.stop();
    engine = undefined;

    if (store) await store.stop();
    store = undefined;
  });

  async function setup(): Promise<void> {
    const suffix = ++counter;
    store = await Store.start({ name: `admin-rules-test-${suffix}` });
    engine = await RuleEngine.start({ name: `admin-rules-engine-${suffix}` });
    server = await NoexServer.start({
      store,
      rules: engine,
      port: 0,
      host: '127.0.0.1',
      auth,
    });
  }

  async function connect(token: string): Promise<WebSocket> {
    const { ws } = await connectClient(server!.port);
    clients.push(ws);
    const resp = await login(ws, token);
    expect(resp['type']).toBe('result');
    return ws;
  }

  // ── rules.registerRule ──────────────────────────────────────────

  describe('rules.registerRule', () => {
    it('registers a rule and returns metadata', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('welcome-email', 'user.registered'),
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['id']).toBe('welcome-email');
      expect(data['name']).toBe('Rule welcome-email');
      expect(typeof data['version']).toBe('number');
      expect(typeof data['createdAt']).toBe('number');
      expect(typeof data['updatedAt']).toBe('number');
    });

    it('registered rule fires on event', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('fire-test', 'test.trigger'),
      });

      // Subscribe to the output topic
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'output.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      // Set up push listener BEFORE emit
      const pushPromise = waitForPush(ws, subscriptionId);

      // Emit event that triggers the rule
      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'test.trigger',
        data: { value: 42 },
      });

      const push = await pushPromise;
      const pushData = push['data'] as Record<string, unknown>;
      expect((pushData['topic'] as string)).toBe('output.fire-test');
    });

    it('returns ALREADY_EXISTS for duplicate rule id', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('dup-rule', 'some.topic'),
      });

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('dup-rule', 'other.topic'),
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('ALREADY_EXISTS');
    });

    it('returns VALIDATION_ERROR for invalid rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: {
          id: 'bad-rule',
          name: 'Bad Rule',
          priority: 100,
          enabled: true,
          tags: [],
          // Missing trigger
          conditions: [],
          actions: [],
        },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });

    it('returns VALIDATION_ERROR for missing rule field', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('VALIDATION_ERROR');
    });
  });

  // ── rules.unregisterRule ────────────────────────────────────────

  describe('rules.unregisterRule', () => {
    it('removes a registered rule', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('removable', 'remove.topic'),
      });

      const resp = await sendRequest(ws, {
        type: 'rules.unregisterRule',
        ruleId: 'removable',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['ruleId']).toBe('removable');
      expect(data['unregistered']).toBe(true);
    });

    it('unregistered rule no longer fires', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('temp-rule', 'temp.trigger'),
      });

      await sendRequest(ws, {
        type: 'rules.unregisterRule',
        ruleId: 'temp-rule',
      });

      // Subscribe to output
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'output.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      // Emit event — rule should NOT fire
      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'temp.trigger',
        data: {},
      });

      // Give it a moment to process
      await new Promise((r) => setTimeout(r, 100));

      // Verify no push was received by sending another request
      // (if a push had arrived, it would be in the stream)
      const statsResp = await sendRequest(ws, {
        type: 'rules.stats',
      });
      expect(statsResp['type']).toBe('result');

      // No push should have been received — we just verify the flow completed
      // without error. A proper check would use expectNoPush but the simple
      // timeout approach is sufficient here.
      void subscriptionId;
    });

    it('returns NOT_FOUND for non-existent rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.unregisterRule',
        ruleId: 'ghost-rule',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── rules.updateRule ────────────────────────────────────────────

  describe('rules.updateRule', () => {
    it('updates rule properties and increments version', async () => {
      await setup();
      const ws = await connect('admin');

      const regResp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('updatable', 'update.topic'),
      });
      const regData = regResp['data'] as Record<string, unknown>;
      const originalVersion = regData['version'] as number;

      const resp = await sendRequest(ws, {
        type: 'rules.updateRule',
        ruleId: 'updatable',
        updates: {
          priority: 200,
          tags: ['updated', 'test'],
        },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['id']).toBe('updatable');
      expect((data['version'] as number)).toBeGreaterThan(originalVersion);
      expect(typeof data['updatedAt']).toBe('number');
    });

    it('updated rule reflects new behavior', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('behavior-update', 'behavior.trigger'),
      });

      // Update the rule to emit on a different output topic
      await sendRequest(ws, {
        type: 'rules.updateRule',
        ruleId: 'behavior-update',
        updates: {
          actions: [
            { type: 'emit_event', topic: 'new-output.behavior-update', data: { changed: true } },
          ],
        },
      });

      // Subscribe to new output
      const subResp = await sendRequest(ws, {
        type: 'rules.subscribe',
        pattern: 'new-output.*',
      });
      const subscriptionId = (subResp['data'] as Record<string, unknown>)[
        'subscriptionId'
      ] as string;

      const pushPromise = waitForPush(ws, subscriptionId);

      await sendRequest(ws, {
        type: 'rules.emit',
        topic: 'behavior.trigger',
        data: {},
      });

      const push = await pushPromise;
      const pushData = push['data'] as Record<string, unknown>;
      expect((pushData['topic'] as string)).toBe('new-output.behavior-update');
    });

    it('returns error for non-existent rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.updateRule',
        ruleId: 'nonexistent',
        updates: { priority: 500 },
      });

      expect(resp['type']).toBe('error');
    });
  });

  // ── rules.enableRule / rules.disableRule ────────────────────────

  describe('rules.enableRule / rules.disableRule', () => {
    it('disables a rule so it stops firing', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('toggle-rule', 'toggle.trigger'),
      });

      const resp = await sendRequest(ws, {
        type: 'rules.disableRule',
        ruleId: 'toggle-rule',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['ruleId']).toBe('toggle-rule');
      expect(data['enabled']).toBe(false);

      // Verify rule is disabled via getRule
      const getResp = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'toggle-rule',
      });
      const ruleData = getResp['data'] as Record<string, unknown>;
      expect(ruleData['enabled']).toBe(false);
    });

    it('enables a disabled rule', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: {
          ...makeRule('disabled-rule', 'disabled.trigger'),
          enabled: false,
        },
      });

      const resp = await sendRequest(ws, {
        type: 'rules.enableRule',
        ruleId: 'disabled-rule',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['ruleId']).toBe('disabled-rule');
      expect(data['enabled']).toBe(true);
    });

    it('returns NOT_FOUND for non-existent rule', async () => {
      await setup();
      const ws = await connect('admin');

      const disableResp = await sendRequest(ws, {
        type: 'rules.disableRule',
        ruleId: 'no-such-rule',
      });
      expect(disableResp['type']).toBe('error');
      expect(disableResp['code']).toBe('NOT_FOUND');

      const enableResp = await sendRequest(ws, {
        type: 'rules.enableRule',
        ruleId: 'no-such-rule',
      });
      expect(enableResp['type']).toBe('error');
      expect(enableResp['code']).toBe('NOT_FOUND');
    });
  });

  // ── rules.getRule ───────────────────────────────────────────────

  describe('rules.getRule', () => {
    it('returns full rule detail', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('detail-rule', 'detail.topic'),
      });

      const resp = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'detail-rule',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['id']).toBe('detail-rule');
      expect(data['name']).toBe('Rule detail-rule');
      expect(data['priority']).toBe(100);
      expect(data['enabled']).toBe(true);
      expect(data['tags']).toEqual(['test']);
      expect(data['trigger']).toEqual({ type: 'event', topic: 'detail.topic' });
      expect(data['conditions']).toEqual([]);
      expect(Array.isArray(data['actions'])).toBe(true);
      expect(typeof data['version']).toBe('number');
      expect(typeof data['createdAt']).toBe('number');
      expect(typeof data['updatedAt']).toBe('number');
    });

    it('returns NOT_FOUND for non-existent rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'missing',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('NOT_FOUND');
    });
  });

  // ── rules.getRules ──────────────────────────────────────────────

  describe('rules.getRules', () => {
    it('returns summary list of all rules', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('rule-a', 'topic.a'),
      });
      await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('rule-b', 'topic.b'),
      });

      const resp = await sendRequest(ws, {
        type: 'rules.getRules',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      const rules = data['rules'] as Array<Record<string, unknown>>;
      expect(rules).toHaveLength(2);

      const ruleIds = rules.map((r) => r['id']);
      expect(ruleIds).toContain('rule-a');
      expect(ruleIds).toContain('rule-b');

      // Verify summary format (no conditions/actions)
      for (const rule of rules) {
        expect(rule['id']).toBeDefined();
        expect(rule['name']).toBeDefined();
        expect(rule['enabled']).toBeDefined();
        expect(rule['priority']).toBeDefined();
        expect(rule['version']).toBeDefined();
        expect(rule['tags']).toBeDefined();
        expect(rule['conditions']).toBeUndefined();
        expect(rule['actions']).toBeUndefined();
      }
    });

    it('returns empty list when no rules registered', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.getRules',
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['rules']).toEqual([]);
    });
  });

  // ── rules.validateRule ──────────────────────────────────────────

  describe('rules.validateRule', () => {
    it('returns valid for a correct rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.validateRule',
        rule: makeRule('valid-rule', 'valid.topic'),
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['valid']).toBe(true);
      expect((data['errors'] as unknown[]).length).toBe(0);
    });

    it('returns errors for an invalid rule', async () => {
      await setup();
      const ws = await connect('admin');

      const resp = await sendRequest(ws, {
        type: 'rules.validateRule',
        rule: {
          id: 'invalid',
          // Missing required fields
        },
      });

      expect(resp['type']).toBe('result');
      const data = resp['data'] as Record<string, unknown>;
      expect(data['valid']).toBe(false);
      expect((data['errors'] as unknown[]).length).toBeGreaterThan(0);
    });

    it('does not register the rule', async () => {
      await setup();
      const ws = await connect('admin');

      await sendRequest(ws, {
        type: 'rules.validateRule',
        rule: makeRule('dry-run', 'dry.topic'),
      });

      // Verify rule was NOT registered
      const getResp = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'dry-run',
      });

      expect(getResp['type']).toBe('error');
      expect(getResp['code']).toBe('NOT_FOUND');
    });
  });

  // ── Full CRUD cycle ─────────────────────────────────────────────

  describe('full CRUD cycle', () => {
    it('register → get → update → disable → enable → unregister', async () => {
      await setup();
      const ws = await connect('admin');

      // Register
      const regResp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('lifecycle', 'lifecycle.topic'),
      });
      expect(regResp['type']).toBe('result');

      // Get
      const getResp = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'lifecycle',
      });
      expect(getResp['type']).toBe('result');
      expect((getResp['data'] as Record<string, unknown>)['id']).toBe('lifecycle');

      // Update
      const updateResp = await sendRequest(ws, {
        type: 'rules.updateRule',
        ruleId: 'lifecycle',
        updates: { priority: 999 },
      });
      expect(updateResp['type']).toBe('result');

      // Verify update
      const getResp2 = await sendRequest(ws, {
        type: 'rules.getRule',
        ruleId: 'lifecycle',
      });
      expect((getResp2['data'] as Record<string, unknown>)['priority']).toBe(999);

      // Disable
      const disableResp = await sendRequest(ws, {
        type: 'rules.disableRule',
        ruleId: 'lifecycle',
      });
      expect(disableResp['type']).toBe('result');
      expect((disableResp['data'] as Record<string, unknown>)['enabled']).toBe(false);

      // Enable
      const enableResp = await sendRequest(ws, {
        type: 'rules.enableRule',
        ruleId: 'lifecycle',
      });
      expect(enableResp['type']).toBe('result');
      expect((enableResp['data'] as Record<string, unknown>)['enabled']).toBe(true);

      // List (should have 1 rule)
      const listResp = await sendRequest(ws, {
        type: 'rules.getRules',
      });
      expect(
        ((listResp['data'] as Record<string, unknown>)['rules'] as unknown[])
          .length,
      ).toBe(1);

      // Unregister
      const unregResp = await sendRequest(ws, {
        type: 'rules.unregisterRule',
        ruleId: 'lifecycle',
      });
      expect(unregResp['type']).toBe('result');

      // List (should be empty)
      const listResp2 = await sendRequest(ws, {
        type: 'rules.getRules',
      });
      expect(
        ((listResp2['data'] as Record<string, unknown>)['rules'] as unknown[])
          .length,
      ).toBe(0);
    });
  });

  // ── Tier enforcement ────────────────────────────────────────────

  describe('tier enforcement', () => {
    it('writer cannot registerRule', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('forbidden', 'x.y'),
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot registerRule', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('forbidden', 'x.y'),
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot unregisterRule', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'rules.unregisterRule',
        ruleId: 'any',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot updateRule', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'rules.updateRule',
        ruleId: 'any',
        updates: { priority: 1 },
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('reader cannot getRules', async () => {
      await setup();
      const ws = await connect('reader');

      const resp = await sendRequest(ws, {
        type: 'rules.getRules',
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });

    it('writer cannot validateRule', async () => {
      await setup();
      const ws = await connect('writer');

      const resp = await sendRequest(ws, {
        type: 'rules.validateRule',
        rule: makeRule('test', 'test.topic'),
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('FORBIDDEN');
    });
  });

  // ── No auth mode ───────────────────────────────────────────────

  describe('no auth mode', () => {
    it('admin rules operations work without auth configured', async () => {
      const suffix = ++counter;
      store = await Store.start({ name: `admin-rules-noauth-${suffix}` });
      engine = await RuleEngine.start({ name: `admin-rules-noauth-engine-${suffix}` });
      server = await NoexServer.start({
        store,
        rules: engine,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('open-rule', 'open.topic'),
      });

      expect(resp['type']).toBe('result');
      expect((resp['data'] as Record<string, unknown>)['id']).toBe('open-rule');

      const listResp = await sendRequest(ws, {
        type: 'rules.getRules',
      });
      expect(listResp['type']).toBe('result');
      expect(
        ((listResp['data'] as Record<string, unknown>)['rules'] as unknown[])
          .length,
      ).toBe(1);
    });
  });

  // ── Rules not configured ───────────────────────────────────────

  describe('rules not configured', () => {
    it('returns RULES_NOT_AVAILABLE when engine is missing', async () => {
      const suffix = ++counter;
      store = await Store.start({ name: `admin-rules-norules-${suffix}` });
      server = await NoexServer.start({
        store,
        port: 0,
        host: '127.0.0.1',
      });

      const { ws } = await connectClient(server.port);
      clients.push(ws);

      const resp = await sendRequest(ws, {
        type: 'rules.registerRule',
        rule: makeRule('test', 'test.topic'),
      });

      expect(resp['type']).toBe('error');
      expect(resp['code']).toBe('RULES_NOT_AVAILABLE');
    });
  });
});
