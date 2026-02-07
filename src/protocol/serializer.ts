import type { ErrorCode } from './codes.js';
import { PROTOCOL_VERSION, type WelcomeConfig } from './types.js';

export function serializeResult(id: number, data: unknown): string {
  return JSON.stringify({ id, type: 'result', data });
}

export function serializeError(
  id: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): string {
  return JSON.stringify({ id, type: 'error', code, message, details });
}

export function serializePush(
  subscriptionId: string,
  channel: string,
  data: unknown,
): string {
  return JSON.stringify({ type: 'push', channel, subscriptionId, data });
}

export function serializeWelcome(config: WelcomeConfig): string {
  return JSON.stringify({
    type: 'welcome',
    version: PROTOCOL_VERSION,
    serverTime: config.serverTime ?? Date.now(),
    requiresAuth: config.requiresAuth,
  });
}

export function serializePing(timestamp: number): string {
  return JSON.stringify({ type: 'ping', timestamp });
}

export function serializeSystem(
  event: string,
  data?: Record<string, unknown>,
): string {
  return JSON.stringify({ type: 'system', event, ...data });
}
