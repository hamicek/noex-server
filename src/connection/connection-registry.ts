import { RegistryInstance } from '@hamicek/noex';
import type { ConnectionRef } from './connection-supervisor.js';

// ── Metadata ─────────────────────────────────────────────────────

export interface ConnectionMetadata {
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}

// ── Public query result ──────────────────────────────────────────

export interface ConnectionInfo {
  readonly connectionId: string;
  readonly remoteAddress: string;
  readonly connectedAt: number;
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly storeSubscriptionCount: number;
  readonly rulesSubscriptionCount: number;
}

// ── Registry type ────────────────────────────────────────────────

export type ConnectionRegistry = RegistryInstance<ConnectionMetadata>;

// ── Lifecycle ────────────────────────────────────────────────────

export async function createConnectionRegistry(
  serverName: string,
): Promise<ConnectionRegistry> {
  const registry = new RegistryInstance<ConnectionMetadata>({
    name: `${serverName}:connections`,
    keys: 'unique',
  });
  await registry.start();
  return registry;
}

export async function closeConnectionRegistry(
  registry: ConnectionRegistry,
): Promise<void> {
  await registry.close();
}

// ── Registration ─────────────────────────────────────────────────

let connectionIdSeq = 0;

export function nextConnectionId(): string {
  return `conn-${++connectionIdSeq}`;
}

export function registerConnection(
  registry: ConnectionRegistry,
  connectionId: string,
  ref: ConnectionRef,
  remoteAddress: string,
): void {
  registry.register(connectionId, ref, {
    remoteAddress,
    connectedAt: Date.now(),
    authenticated: false,
    userId: null,
    roles: [],
    storeSubscriptionCount: 0,
    rulesSubscriptionCount: 0,
  });
}

// ── Metadata updates ─────────────────────────────────────────────

export function updateConnectionAuth(
  registry: ConnectionRegistry,
  connectionId: string,
  authenticated: boolean,
  userId: string | null,
  roles: readonly string[],
): void {
  registry.updateMetadata(connectionId, (meta) => ({
    ...meta,
    authenticated,
    userId,
    roles,
  }));
}

export function updateConnectionSubscriptions(
  registry: ConnectionRegistry,
  connectionId: string,
  storeCount: number,
  rulesCount: number,
): void {
  registry.updateMetadata(connectionId, (meta) => ({
    ...meta,
    storeSubscriptionCount: storeCount,
    rulesSubscriptionCount: rulesCount,
  }));
}

// ── Queries ──────────────────────────────────────────────────────

export function getConnections(
  registry: ConnectionRegistry,
): ConnectionInfo[] {
  return registry.select(() => true).map((match) => ({
    connectionId: match.key,
    ...match.metadata,
  }));
}

export function getTotalSubscriptionCount(
  registry: ConnectionRegistry,
): number {
  let total = 0;
  for (const match of registry.select(() => true)) {
    total += match.metadata.storeSubscriptionCount + match.metadata.rulesSubscriptionCount;
  }
  return total;
}

export function getConnectionById(
  registry: ConnectionRegistry,
  connectionId: string,
): ConnectionInfo | undefined {
  const entry = registry.whereis(connectionId);
  if (entry === undefined) return undefined;
  return {
    connectionId,
    ...entry.metadata,
  };
}

// ── Test helpers ─────────────────────────────────────────────────

/** @internal */
export function _resetConnectionIdSeq(): void {
  connectionIdSeq = 0;
}
