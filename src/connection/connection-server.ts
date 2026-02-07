import type { WebSocket } from 'ws';
import type { GenServerBehavior, GenServerRef } from '@hamicek/noex';
import { GenServer, RateLimiter, RateLimitExceededError } from '@hamicek/noex';
import type { ResolvedServerConfig, AuthSession } from '../config.js';
import type { ClientRequest } from '../protocol/types.js';
import { parseMessage } from '../protocol/parser.js';
import {
  serializeWelcome,
  serializeError,
  serializeResult,
  serializePush,
  serializePing,
} from '../protocol/serializer.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import {
  handleStoreRequest,
  handleStoreSubscribe,
  handleStoreUnsubscribe,
  handleStoreTransaction,
} from '../proxy/store-proxy.js';
import {
  handleRulesRequest,
  handleRulesSubscribe,
  handleRulesUnsubscribe,
} from '../proxy/rules-proxy.js';
import { handleAuthRequest } from '../auth/auth-handler.js';
import { checkPermissions } from '../auth/permissions.js';
import { isBackpressured } from '../lifecycle/backpressure.js';
import {
  updateConnectionAuth,
  updateConnectionSubscriptions,
} from './connection-registry.js';

// ── State ─────────────────────────────────────────────────────────

export interface ConnectionState {
  readonly ws: WebSocket;
  readonly remoteAddress: string;
  readonly connectionId: string;
  readonly config: ResolvedServerConfig;
  session: AuthSession | null;
  authenticated: boolean;
  readonly storeSubscriptions: Map<string, () => void>;
  readonly rulesSubscriptions: Map<string, () => void>;
  lastPingAt: number;
  lastPongAt: number;
}

// ── Cast Messages ─────────────────────────────────────────────────

export type ConnectionCast =
  | { readonly type: 'ws_message'; readonly raw: string }
  | { readonly type: 'ws_close'; readonly code: number; readonly reason: string }
  | { readonly type: 'ws_error'; readonly error: Error }
  | { readonly type: 'heartbeat_tick' }
  | {
      readonly type: 'push';
      readonly subscriptionId: string;
      readonly channel: string;
      readonly data: unknown;
    };

// ── WebSocket readyState constants ────────────────────────────────

const WS_OPEN = 1;

// ── Behavior Factory ──────────────────────────────────────────────

export function createConnectionBehavior(
  ws: WebSocket,
  remoteAddress: string,
  config: ResolvedServerConfig,
  connectionId: string,
): GenServerBehavior<ConnectionState, never, ConnectionCast, never> {
  return {
    init(): ConnectionState {
      const requiresAuth =
        config.auth !== null && config.auth.required !== false;

      sendRaw(ws, serializeWelcome({ requiresAuth }));

      return {
        ws,
        remoteAddress,
        connectionId,
        config,
        session: null,
        authenticated: false,
        storeSubscriptions: new Map(),
        rulesSubscriptions: new Map(),
        lastPingAt: 0,
        lastPongAt: 0,
      };
    },

    handleCall(
      _msg: never,
      _state: ConnectionState,
    ): [never, ConnectionState] {
      throw new Error(
        'Unreachable: ConnectionServer does not handle call messages',
      );
    },

    handleCast(
      msg: ConnectionCast,
      state: ConnectionState,
    ): ConnectionState | Promise<ConnectionState> {
      switch (msg.type) {
        case 'ws_message':
          return handleWsMessage(msg.raw, state);
        case 'ws_close':
          return state;
        case 'ws_error':
          return state;
        case 'heartbeat_tick':
          return handleHeartbeatTick(state);
        case 'push':
          return handlePush(msg, state);
      }
    },

    terminate(reason, state): void {
      for (const unsub of state.storeSubscriptions.values()) {
        unsub();
      }
      state.storeSubscriptions.clear();

      for (const unsub of state.rulesSubscriptions.values()) {
        unsub();
      }
      state.rulesSubscriptions.clear();

      if (state.ws.readyState === WS_OPEN) {
        const closeReason =
          reason === 'normal' ? 'normal_closure' : 'server_shutdown';
        state.ws.close(1000, closeReason);
      }
    },
  };
}

// ── Start Helper ──────────────────────────────────────────────────

export async function startConnection(
  ws: WebSocket,
  remoteAddress: string,
  config: ResolvedServerConfig,
  connectionId = 'test-conn',
): Promise<GenServerRef<ConnectionState, never, ConnectionCast, never>> {
  const behavior = createConnectionBehavior(ws, remoteAddress, config, connectionId);
  const ref = await GenServer.start(behavior);

  ws.on('message', (data) => {
    try {
      GenServer.cast(ref, { type: 'ws_message', raw: data.toString() });
    } catch {
      // Server already stopped — ignore
    }
  });

  ws.on('close', () => {
    void GenServer.stop(ref, 'normal');
  });

  ws.on('error', () => {
    // Errors are always followed by close events.
    // Cleanup is handled in the close handler.
  });

  return ref;
}

// ── Internal: Message Handling ────────────────────────────────────

async function handleWsMessage(
  raw: string,
  state: ConnectionState,
): Promise<ConnectionState> {
  const parsed = parseMessage(raw);

  if (!parsed.ok) {
    sendRaw(state.ws, serializeError(0, parsed.code, parsed.message));
    return state;
  }

  if (parsed.kind === 'pong') {
    return { ...state, lastPongAt: parsed.timestamp };
  }

  const request = parsed.request;

  try {
    checkAuth(state, request);
    await checkRateLimit(state);
    const result = await routeRequest(request, state);
    sendRaw(state.ws, serializeResult(request.id, result));
  } catch (error) {
    if (error instanceof NoexServerError) {
      sendRaw(
        state.ws,
        serializeError(request.id, error.code, error.message, error.details),
      );
    } else {
      sendRaw(
        state.ws,
        serializeError(
          request.id,
          ErrorCode.INTERNAL_ERROR,
          'Internal server error',
        ),
      );
    }
  }

  return state;
}

function handlePush(
  msg: {
    readonly subscriptionId: string;
    readonly channel: string;
    readonly data: unknown;
  },
  state: ConnectionState,
): ConnectionState {
  if (isBackpressured(state.ws, state.config.backpressure)) {
    // Drop push — reactive queries will resend on the next state change.
    return state;
  }
  sendRaw(
    state.ws,
    serializePush(msg.subscriptionId, msg.channel, msg.data),
  );
  return state;
}

// ── Internal: Heartbeat ──────────────────────────────────────────

function handleHeartbeatTick(state: ConnectionState): ConnectionState {
  const now = Date.now();

  // If we sent a ping and the client hasn't responded since
  if (state.lastPingAt > 0 && state.lastPongAt < state.lastPingAt) {
    if (state.ws.readyState === WS_OPEN) {
      state.ws.close(4001, 'heartbeat_timeout');
    }
    return state;
  }

  // Send a new ping
  sendRaw(state.ws, serializePing(now));
  return { ...state, lastPingAt: now };
}

// ── Internal: Auth Check ──────────────────────────────────────────

function checkAuth(state: ConnectionState, request: ClientRequest): void {
  const { type } = request;

  if (type.startsWith('auth.') || type === 'ping') return;

  const { auth } = state.config;

  if (auth !== null && auth.required !== false && !state.authenticated) {
    throw new NoexServerError(
      ErrorCode.UNAUTHORIZED,
      'Authentication required',
    );
  }

  if (
    state.session !== null &&
    state.session.expiresAt !== undefined &&
    state.session.expiresAt < Date.now()
  ) {
    state.session = null;
    state.authenticated = false;
    throw new NoexServerError(
      ErrorCode.UNAUTHORIZED,
      'Session expired',
    );
  }

  if (auth?.permissions !== undefined && state.session !== null) {
    checkPermissions(state.session, request, auth.permissions);
  }
}

// ── Internal: Rate Limit Check ───────────────────────────────────

async function checkRateLimit(state: ConnectionState): Promise<void> {
  if (state.config.rateLimiterRef === null) return;

  const key = state.session?.userId ?? state.remoteAddress;

  try {
    await RateLimiter.consume(state.config.rateLimiterRef, key);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      throw new NoexServerError(
        ErrorCode.RATE_LIMITED,
        `Rate limit exceeded. Retry after ${error.retryAfterMs}ms`,
        { retryAfterMs: error.retryAfterMs },
      );
    }
    throw error;
  }
}

// ── Internal: Request Routing ─────────────────────────────────────

async function routeRequest(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  const { type } = request;

  if (type.startsWith('store.')) {
    return handleStoreOperation(request, state);
  }

  if (type.startsWith('rules.')) {
    return handleRulesOperation(request, state);
  }

  if (type.startsWith('auth.')) {
    return handleAuthOperation(request, state);
  }

  throw new NoexServerError(
    ErrorCode.UNKNOWN_OPERATION,
    `Unknown operation "${type}"`,
  );
}

// ── Internal: Store Operations ────────────────────────────────────

async function handleStoreOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  if (request.type === 'store.subscribe') {
    const result = await handleStoreSubscribe(
      request,
      state.config.store,
      state.storeSubscriptions,
      (subscriptionId, data) => {
        sendRaw(
          state.ws,
          serializePush(subscriptionId, 'subscription', data),
        );
      },
    );
    syncSubscriptionCounts(state);
    return result;
  }

  if (request.type === 'store.unsubscribe') {
    const result = handleStoreUnsubscribe(request, state.storeSubscriptions);
    syncSubscriptionCounts(state);
    return result;
  }

  if (request.type === 'store.transaction') {
    return handleStoreTransaction(request, state.config.store);
  }

  return handleStoreRequest(request, state.config.store);
}

async function handleRulesOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  if (state.config.rules === null) {
    throw new NoexServerError(
      ErrorCode.RULES_NOT_AVAILABLE,
      'Rule engine is not configured',
    );
  }

  if (request.type === 'rules.subscribe') {
    const result = handleRulesSubscribe(
      request,
      state.config.rules,
      state.rulesSubscriptions,
      (subscriptionId, data) => {
        sendRaw(
          state.ws,
          serializePush(subscriptionId, 'event', data),
        );
      },
    );
    syncSubscriptionCounts(state);
    return result;
  }

  if (request.type === 'rules.unsubscribe') {
    const result = handleRulesUnsubscribe(request, state.rulesSubscriptions);
    syncSubscriptionCounts(state);
    return result;
  }

  return handleRulesRequest(request, state.config.rules);
}

async function handleAuthOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  const result = await handleAuthRequest(request, state, state.config.auth);

  updateConnectionAuth(
    state.config.connectionRegistry,
    state.connectionId,
    state.authenticated,
    state.session?.userId ?? null,
  );

  return result;
}

// ── Internal: Utility ─────────────────────────────────────────────

function syncSubscriptionCounts(state: ConnectionState): void {
  updateConnectionSubscriptions(
    state.config.connectionRegistry,
    state.connectionId,
    state.storeSubscriptions.size,
    state.rulesSubscriptions.size,
  );
}

function sendRaw(ws: WebSocket, message: string): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(message);
  }
}
