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
  serializeSystem,
} from '../protocol/serializer.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import {
  handleStoreRequest,
  handleStoreSubscribe,
  handleStoreUnsubscribe,
  handleStoreTransaction,
} from '../proxy/store-proxy.js';
import { handleAdminStoreRequest } from '../proxy/admin-store-proxy.js';
import {
  handleRulesRequest,
  handleRulesSubscribe,
  handleRulesUnsubscribe,
} from '../proxy/rules-proxy.js';
import { handleAdminRulesRequest } from '../proxy/admin-rules-proxy.js';
import { handleProceduresRequest } from '../proxy/procedures-proxy.js';
import { handleAuthRequest } from '../auth/auth-handler.js';
import { handleIdentityRequest } from '../identity/identity-handler.js';
import { checkPermissions, extractResource } from '../auth/permissions.js';
import { getOperationTier } from '../auth/operation-tiers.js';
import { hasAccessForTier } from '../auth/role-hierarchy.js';
import { isBackpressured } from '../lifecycle/backpressure.js';
import { handleAuditRequest } from '../proxy/audit-proxy.js';
import type { AuditEntry } from '../audit/audit-types.js';
import {
  updateConnectionAuth,
  updateConnectionSubscriptions,
  getConnections as getRegistryConnections,
  getTotalSubscriptionCount,
} from './connection-registry.js';

// ── State ─────────────────────────────────────────────────────────

export interface ConnectionState {
  readonly ws: WebSocket;
  readonly remoteAddress: string;
  readonly connectionId: string;
  readonly config: ResolvedServerConfig;
  session: AuthSession | null;
  authenticated: boolean;
  sessionToken: string | null;
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
    }
  | { readonly type: 'session_revoked' };

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
        config.identityManager !== null ||
        (config.auth !== null && config.auth.required !== false);

      sendRaw(ws, serializeWelcome({ requiresAuth }));

      return {
        ws,
        remoteAddress,
        connectionId,
        config,
        session: null,
        authenticated: false,
        sessionToken: null,
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
        case 'session_revoked':
          return handleSessionRevoked(state);
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

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'binary_not_supported');
      return;
    }
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
    logAudit(state, request, 'success');
  } catch (error) {
    if (error instanceof NoexServerError) {
      const details = state.config.exposeErrorDetails
        ? error.details
        : undefined;
      sendRaw(
        state.ws,
        serializeError(request.id, error.code, error.message, details),
      );
      logAudit(state, request, 'error', error.message);
    } else {
      sendRaw(
        state.ws,
        serializeError(
          request.id,
          ErrorCode.INTERNAL_ERROR,
          'Internal server error',
        ),
      );
      logAudit(state, request, 'error', 'Internal server error');
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

// ── Internal: Session Revocation ──────────────────────────────────

function handleSessionRevoked(state: ConnectionState): ConnectionState {
  if (state.ws.readyState === WS_OPEN) {
    sendRaw(
      state.ws,
      serializeSystem('session_revoked', {
        reason: 'Session revoked by administrator',
      }),
    );
    state.ws.close(4002, 'session_revoked');
  }
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

  // Identity login operations bypass auth (they establish authentication)
  if (type === 'identity.login' || type === 'identity.loginWithSecret') return;

  const { auth, identityManager } = state.config;
  const authRequired =
    identityManager !== null ||
    (auth !== null && auth.required !== false);

  if (authRequired && !state.authenticated) {
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

  // Built-in identity mode: dynamic permission check via IdentityManager.
  // This replaces the legacy tier check and custom permissions.
  // Identity operations are excluded — they have their own auth in the handler.
  if (identityManager !== null) {
    if (state.session !== null && !type.startsWith('identity.')) {
      const resource = extractResource(request);
      if (!identityManager.isAllowed(state.session.userId, type, resource)) {
        throw new NoexServerError(
          ErrorCode.FORBIDDEN,
          `No access to ${type} on ${resource}`,
        );
      }
    }
    return;
  }

  // Legacy external auth: tier check + custom permissions
  if (auth !== null && state.session !== null) {
    const tier = getOperationTier(type);
    if (tier !== null && !hasAccessForTier(state.session.roles, tier)) {
      throw new NoexServerError(
        ErrorCode.FORBIDDEN,
        `Role level insufficient for ${type} (requires ${tier})`,
      );
    }
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

  if (type.startsWith('identity.')) {
    return handleIdentityOperation(request, state);
  }

  if (type.startsWith('auth.')) {
    return handleAuthOperation(request, state);
  }

  if (type.startsWith('audit.')) {
    return handleAuditOperation(request, state);
  }

  if (type.startsWith('procedures.')) {
    return handleProceduresOperation(request, state);
  }

  if (type.startsWith('server.')) {
    return handleServerOperation(request, state);
  }

  throw new NoexServerError(
    ErrorCode.UNKNOWN_OPERATION,
    `Unknown operation "${type}"`,
  );
}

// ── Internal: Store Operations ────────────────────────────────────

function totalSubscriptions(state: ConnectionState): number {
  return state.storeSubscriptions.size + state.rulesSubscriptions.size;
}

function checkSubscriptionLimit(state: ConnectionState): void {
  const max = state.config.connectionLimits.maxSubscriptionsPerConnection;
  if (totalSubscriptions(state) >= max) {
    throw new NoexServerError(
      ErrorCode.RATE_LIMITED,
      `Subscription limit reached (max ${max} per connection)`,
    );
  }
}

function checkGlobalSubscriptionLimit(state: ConnectionState): void {
  const max = state.config.connectionLimits.maxTotalSubscriptions;
  const total = getTotalSubscriptionCount(state.config.connectionRegistry);
  if (total >= max) {
    throw new NoexServerError(
      ErrorCode.RATE_LIMITED,
      `Global subscription limit reached (max ${max})`,
    );
  }
}

async function handleStoreOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  // System bucket guard: block direct access to _* buckets when built-in auth is active
  if (state.config.identityManager !== null) {
    checkSystemBucketAccess(request);
  }

  // Filter system buckets from store.buckets response
  if (request.type === 'store.buckets' && state.config.identityManager !== null) {
    const stats = await state.config.store.getStats();
    const names = (stats.buckets.names as string[]).filter(
      (n) => !n.startsWith('_'),
    );
    return { count: names.length, names };
  }

  if (request.type === 'store.subscribe') {
    checkSubscriptionLimit(state);
    checkGlobalSubscriptionLimit(state);
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

  if (
    request.type === 'store.defineBucket' ||
    request.type === 'store.dropBucket' ||
    request.type === 'store.updateBucket' ||
    request.type === 'store.getBucketSchema' ||
    request.type === 'store.defineQuery' ||
    request.type === 'store.undefineQuery' ||
    request.type === 'store.listQueries'
  ) {
    const result = await handleAdminStoreRequest(request, state.config.store);

    // Track ownership for built-in identity mode
    if (state.config.identityManager !== null && state.session !== null) {
      const name = request['name'] as string;
      if (request.type === 'store.defineBucket') {
        await state.config.identityManager.setOwner(state.session.userId, 'bucket', name);
      } else if (request.type === 'store.dropBucket') {
        await state.config.identityManager.removeOwnership('bucket', name);
      } else if (request.type === 'store.defineQuery') {
        await state.config.identityManager.setOwner(state.session.userId, 'query', name);
      } else if (request.type === 'store.undefineQuery') {
        await state.config.identityManager.removeOwnership('query', name);
      }
    }

    return result;
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
    checkSubscriptionLimit(state);
    checkGlobalSubscriptionLimit(state);
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

  if (
    request.type === 'rules.registerRule' ||
    request.type === 'rules.unregisterRule' ||
    request.type === 'rules.updateRule' ||
    request.type === 'rules.enableRule' ||
    request.type === 'rules.disableRule' ||
    request.type === 'rules.getRule' ||
    request.type === 'rules.getRules' ||
    request.type === 'rules.validateRule'
  ) {
    return handleAdminRulesRequest(request, state.config.rules);
  }

  return handleRulesRequest(request, state.config.rules);
}

async function handleProceduresOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  if (state.config.procedureEngine === null) {
    throw new NoexServerError(
      ErrorCode.UNKNOWN_OPERATION,
      'Procedures engine is not configured',
    );
  }

  return handleProceduresRequest(request, state.config.procedureEngine);
}

async function handleIdentityOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  if (state.config.identityManager === null) {
    throw new NoexServerError(
      ErrorCode.UNKNOWN_OPERATION,
      'Identity management is not configured',
    );
  }

  const result = await handleIdentityRequest(
    request,
    state,
    state.config.identityManager,
  );

  updateConnectionAuth(
    state.config.connectionRegistry,
    state.connectionId,
    state.authenticated,
    state.session?.userId ?? null,
    state.session?.roles ? [...state.session.roles] : [],
  );

  return result;
}

async function handleAuthOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  const result = await handleAuthRequest(request, state, state.config.auth);

  // Check blacklist after successful login
  if (
    request.type === 'auth.login' &&
    state.authenticated &&
    state.session !== null &&
    state.config.blacklist !== null &&
    state.config.blacklist.isRevoked(state.session.userId)
  ) {
    state.session = null;
    state.authenticated = false;
    throw new NoexServerError(
      ErrorCode.SESSION_REVOKED,
      'Session has been revoked',
    );
  }

  updateConnectionAuth(
    state.config.connectionRegistry,
    state.connectionId,
    state.authenticated,
    state.session?.userId ?? null,
    state.session?.roles ? [...state.session.roles] : [],
  );

  return result;
}

// ── Internal: Server Operations ────────────────────────────────────

async function handleServerOperation(
  request: ClientRequest,
  state: ConnectionState,
): Promise<unknown> {
  switch (request.type) {
    case 'server.stats': {
      const conns = getRegistryConnections(state.config.connectionRegistry);
      const storeStats = await state.config.store.getStats();
      const rulesStats =
        state.config.rules !== null ? state.config.rules.getStats() : null;

      let authenticated = 0;
      let totalStoreSubscriptions = 0;
      let totalRulesSubscriptions = 0;
      for (const c of conns) {
        if (c.authenticated) authenticated++;
        totalStoreSubscriptions += c.storeSubscriptionCount;
        totalRulesSubscriptions += c.rulesSubscriptionCount;
      }

      return {
        name: state.config.name,
        connectionCount: conns.length,
        authEnabled: state.config.auth !== null,
        rateLimitEnabled: state.config.rateLimit !== null,
        rulesEnabled: state.config.rules !== null,
        connections: {
          active: conns.length,
          authenticated,
          totalStoreSubscriptions,
          totalRulesSubscriptions,
        },
        store: storeStats,
        rules: rulesStats,
      };
    }

    case 'server.connections':
      return getRegistryConnections(state.config.connectionRegistry);

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown server operation "${request.type}"`,
      );
  }
}

// ── Internal: Audit Operations ──────────────────────────────────

function handleAuditOperation(
  request: ClientRequest,
  state: ConnectionState,
): unknown {
  if (state.config.auditLog === null) {
    throw new NoexServerError(
      ErrorCode.UNKNOWN_OPERATION,
      'Audit log is not configured',
    );
  }
  return handleAuditRequest(request, state.config.auditLog);
}

// ── Internal: Audit Logging ─────────────────────────────────────

function logAudit(
  state: ConnectionState,
  request: ClientRequest,
  result: 'success' | 'error',
  error?: string,
): void {
  const { auditLog } = state.config;
  if (auditLog === null) return;

  const tier = getOperationTier(request.type);
  if (!auditLog.shouldLog(tier)) return;

  const details = extractAuditDetails(request);

  const entry: AuditEntry = {
    timestamp: Date.now(),
    userId: state.session?.userId ?? null,
    sessionId: state.connectionId,
    operation: request.type,
    resource: extractAuditResource(request),
    result,
    ...(error !== undefined ? { error } : {}),
    ...(details !== undefined ? { details } : {}),
    remoteAddress: state.remoteAddress,
  };

  auditLog.append(entry);
}

function extractAuditResource(request: ClientRequest): string {
  if (typeof request['bucket'] === 'string') return request['bucket'];
  if (typeof request['name'] === 'string') return request['name'];
  if (typeof request['ruleId'] === 'string') return request['ruleId'];
  if (typeof request['topic'] === 'string') return request['topic'];
  if (typeof request['key'] === 'string') return request['key'];
  if (typeof request['pattern'] === 'string') return request['pattern'];

  // Identity operations
  if (typeof request['username'] === 'string') return `user:${request['username']}`;
  if (typeof request['userId'] === 'string') return `user:${request['userId']}`;
  if (typeof request['roleId'] === 'string') return `role:${request['roleId']}`;
  if (typeof request['resourceType'] === 'string' && typeof request['resourceName'] === 'string') {
    return `${request['resourceType']}:${request['resourceName']}`;
  }

  return '*';
}

function extractAuditDetails(request: ClientRequest): Record<string, unknown> | undefined {
  const { type } = request;

  if (type === 'identity.login') {
    return { username: request['username'] };
  }

  if (type === 'identity.createUser') {
    return { username: request['username'] };
  }

  if (type === 'identity.assignRole' || type === 'identity.removeRole') {
    return { userId: request['userId'], roleName: request['roleName'] };
  }

  if (type === 'identity.grant' || type === 'identity.revoke') {
    return {
      subjectType: request['subjectType'],
      subjectId: request['subjectId'],
      resourceType: request['resourceType'],
      resourceName: request['resourceName'],
      operations: request['operations'],
    };
  }

  if (type === 'identity.transferOwner') {
    return {
      resourceType: request['resourceType'],
      resourceName: request['resourceName'],
      newOwnerId: request['newOwnerId'],
    };
  }

  return undefined;
}

// ── Internal: System Bucket Guard ────────────────────────────────

function checkSystemBucketAccess(request: ClientRequest): void {
  // Check 'bucket' field (data operations: get, insert, where, etc.)
  const bucket = request['bucket'];
  if (typeof bucket === 'string' && bucket.startsWith('_')) {
    throw new NoexServerError(
      ErrorCode.FORBIDDEN,
      `Cannot access system bucket "${bucket}" directly`,
    );
  }

  // Check 'name' field (admin operations: defineBucket, dropBucket, etc.)
  const name = request['name'];
  if (typeof name === 'string' && name.startsWith('_')) {
    throw new NoexServerError(
      ErrorCode.FORBIDDEN,
      `Cannot access system bucket "${name}" directly`,
    );
  }

  // Check buckets inside transactions
  if (request.type === 'store.transaction' && Array.isArray(request['operations'])) {
    for (const op of request['operations'] as Array<Record<string, unknown>>) {
      if (typeof op['bucket'] === 'string' && op['bucket'].startsWith('_')) {
        throw new NoexServerError(
          ErrorCode.FORBIDDEN,
          `Cannot access system bucket "${op['bucket']}" in transaction`,
        );
      }
    }
  }
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
    try {
      ws.send(message);
    } catch {
      // Send can fail if the socket is in a transitional state or the
      // write buffer overflows. Swallowing the error is safe: the client
      // will either reconnect or the heartbeat will detect the dead link.
    }
  }
}
