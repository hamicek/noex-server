import type { ErrorCode } from './codes.js';

export const PROTOCOL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface ClientRequest {
  readonly id: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface HeartbeatPong {
  readonly type: 'pong';
  readonly timestamp: number;
}

export type ClientMessage = ClientRequest | HeartbeatPong;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface SuccessResponse {
  readonly id: number;
  readonly type: 'result';
  readonly data: unknown;
}

export interface ErrorResponse {
  readonly id: number;
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface PushMessage {
  readonly type: 'push';
  readonly channel: string;
  readonly subscriptionId: string;
  readonly data: unknown;
}

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly version: string;
  readonly serverTime: number;
  readonly requiresAuth: boolean;
}

export interface HeartbeatPing {
  readonly type: 'ping';
  readonly timestamp: number;
}

export type ServerMessage =
  | SuccessResponse
  | ErrorResponse
  | PushMessage
  | WelcomeMessage
  | HeartbeatPing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface WelcomeConfig {
  readonly requiresAuth: boolean;
  readonly serverTime?: number;
}
