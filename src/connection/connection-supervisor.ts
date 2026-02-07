import type { SupervisorRef, GenServerRef } from '@hamicek/noex';
import { Supervisor, GenServer } from '@hamicek/noex';
import type { WebSocket } from 'ws';
import type { ResolvedServerConfig } from '../config.js';
import {
  createConnectionBehavior,
  type ConnectionState,
  type ConnectionCast,
} from './connection-server.js';
import { startHeartbeat } from '../lifecycle/heartbeat.js';
import { nextConnectionId, registerConnection } from './connection-registry.js';

// ── Types ──────────────────────────────────────────────────────────

export type ConnectionRef = GenServerRef<ConnectionState, never, ConnectionCast, never>;

// ── Supervisor Lifecycle ───────────────────────────────────────────

/**
 * Starts a simple_one_for_one supervisor that manages WebSocket connection
 * GenServers. Each new connection is started as a temporary child — crashed
 * connections are cleaned up but never restarted.
 */
export async function startConnectionSupervisor(
  config: ResolvedServerConfig,
): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      start: async (...args: unknown[]) => {
        const ws = args[0] as WebSocket;
        const remoteAddress = args[1] as string;
        const connectionId = args[2] as string;
        const behavior = createConnectionBehavior(ws, remoteAddress, config, connectionId);
        return GenServer.start(behavior);
      },
      restart: 'temporary',
      shutdownTimeout: 5_000,
    },
  });
}

/**
 * Starts a new ConnectionServer child under the supervisor and wires
 * WebSocket events to the GenServer.
 *
 * Returns the GenServerRef of the newly created connection.
 */
export async function addConnection(
  supervisorRef: SupervisorRef,
  ws: WebSocket,
  remoteAddress: string,
  heartbeatIntervalMs: number,
  config: ResolvedServerConfig,
): Promise<ConnectionRef> {
  const connectionId = nextConnectionId();
  const ref = await Supervisor.startChild(supervisorRef, [
    ws,
    remoteAddress,
    connectionId,
  ]) as ConnectionRef;

  registerConnection(config.connectionRegistry, connectionId, ref, remoteAddress);

  ws.on('message', (data) => {
    try {
      GenServer.cast(ref, { type: 'ws_message', raw: data.toString() });
    } catch {
      // GenServer already stopped — ignore
    }
  });

  const heartbeat = startHeartbeat(
    () => GenServer.cast(ref, { type: 'heartbeat_tick' }),
    heartbeatIntervalMs,
  );

  ws.on('close', () => {
    heartbeat.stop();
    void GenServer.stop(ref, 'normal');
  });

  ws.on('error', () => {
    // Errors are always followed by close events.
    // Cleanup is handled in the close handler.
  });

  return ref;
}

/**
 * Returns the number of active connections managed by the supervisor.
 */
export function getConnectionCount(supervisorRef: SupervisorRef): number {
  return Supervisor.countChildren(supervisorRef);
}

/**
 * Gracefully stops the connection supervisor and all active connections.
 */
export async function stopConnectionSupervisor(
  supervisorRef: SupervisorRef,
): Promise<void> {
  await Supervisor.stop(supervisorRef, 'shutdown');
}
