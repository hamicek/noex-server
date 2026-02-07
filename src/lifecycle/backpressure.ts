import type { WebSocket } from 'ws';
import type { BackpressureConfig } from '../config.js';

/**
 * Returns true when the WebSocket write buffer exceeds the configured
 * high water mark. Callers should drop non-essential messages (push
 * updates) to prevent unbounded memory growth.
 *
 * Reactive query subscriptions will naturally resend on the next state
 * change, so dropped pushes do not cause data loss — only temporary
 * staleness.
 */
export function isBackpressured(
  ws: WebSocket,
  config: BackpressureConfig,
): boolean {
  return ws.bufferedAmount >= config.maxBufferedBytes * config.highWaterMark;
}
