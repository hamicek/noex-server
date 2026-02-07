import type { WebSocket } from 'ws';
import type { GenServerBehavior, GenServerRef } from '@hamicek/noex';
import { GenServer } from '@hamicek/noex';
import type { ResolvedServerConfig, AuthSession } from '../config.js';
import type { ClientRequest } from '../protocol/types.js';
import { parseMessage } from '../protocol/parser.js';
import {
  serializeWelcome,
  serializeError,
  serializeResult,
  serializePush,
} from '../protocol/serializer.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import {
  handleStoreRequest,
  handleStoreSubscribe,
  handleStoreUnsubscribe,
} from '../proxy/store-proxy.js';

// ── State ─────────────────────────────────────────────────────────

export interface ConnectionState {
  readonly ws: WebSocket;
  readonly remoteAddress: string;
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
): GenServerBehavior<ConnectionState, never, ConnectionCast, never> {
  return {
    init(): ConnectionState {
      const requiresAuth =
        config.auth !== null && config.auth.required !== false;

      sendRaw(ws, serializeWelcome({ requiresAuth }));

      return {
        ws,
        remoteAddress,
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
          return state;
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
): Promise<GenServerRef<ConnectionState, never, ConnectionCast, never>> {
  const behavior = createConnectionBehavior(ws, remoteAddress, config);
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
    checkAuth(state, request.type);
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
  sendRaw(
    state.ws,
    serializePush(msg.subscriptionId, msg.channel, msg.data),
  );
  return state;
}

// ── Internal: Auth Check ──────────────────────────────────────────

function checkAuth(state: ConnectionState, requestType: string): void {
  if (requestType.startsWith('auth.') || requestType === 'ping') return;

  if (
    state.config.auth !== null &&
    state.config.auth.required !== false &&
    !state.authenticated
  ) {
    throw new NoexServerError(
      ErrorCode.UNAUTHORIZED,
      'Authentication required',
    );
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
    return handleStoreSubscribe(
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
  }

  if (request.type === 'store.unsubscribe') {
    return handleStoreUnsubscribe(request, state.storeSubscriptions);
  }

  return handleStoreRequest(request, state.config.store);
}

async function handleRulesOperation(
  _request: ClientRequest,
  state: ConnectionState,
): Promise<never> {
  if (state.config.rules === null) {
    throw new NoexServerError(
      ErrorCode.RULES_NOT_AVAILABLE,
      'Rule engine is not configured',
    );
  }

  throw new NoexServerError(
    ErrorCode.UNKNOWN_OPERATION,
    'Rules operations are not yet implemented',
  );
}

async function handleAuthOperation(
  _request: ClientRequest,
  _state: ConnectionState,
): Promise<never> {
  throw new NoexServerError(
    ErrorCode.UNKNOWN_OPERATION,
    'Auth operations are not yet implemented',
  );
}

// ── Internal: Utility ─────────────────────────────────────────────

function sendRaw(ws: WebSocket, message: string): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(message);
  }
}
