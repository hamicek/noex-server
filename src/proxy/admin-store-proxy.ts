import type { Store, BucketDefinition, BucketSchemaUpdate, DeclarativeQueryConfig } from '@hamicek/noex-store';
import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import { mapStoreError } from './store-proxy.js';

// ── Validation helpers ────────────────────────────────────────────

function requireString(
  request: ClientRequest,
  field: string,
): string {
  const value = request[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${field}": expected non-empty string`,
    );
  }
  return value;
}

function requireObject(
  request: ClientRequest,
  field: string,
): Record<string, unknown> {
  const value = request[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${field}": expected object`,
    );
  }
  return value as Record<string, unknown>;
}

// ── Admin store operations ────────────────────────────────────────

export async function handleAdminStoreRequest(
  request: ClientRequest,
  store: Store,
): Promise<unknown> {
  try {
    return await dispatchAdminStoreOperation(request, store);
  } catch (error) {
    throw mapStoreError(error);
  }
}

async function dispatchAdminStoreOperation(
  request: ClientRequest,
  store: Store,
): Promise<unknown> {
  switch (request.type) {
    case 'store.defineBucket': {
      const name = requireString(request, 'name');
      const config = requireObject(request, 'config') as unknown as BucketDefinition;
      await store.defineBucket(name, config);
      return { name, created: true };
    }

    case 'store.dropBucket': {
      const name = requireString(request, 'name');
      const dropped = await store.dropBucket(name);
      if (!dropped) {
        throw new NoexServerError(
          ErrorCode.BUCKET_NOT_DEFINED,
          `Bucket "${name}" does not exist`,
        );
      }
      return { name, dropped: true };
    }

    case 'store.updateBucket': {
      const name = requireString(request, 'name');
      const updates = requireObject(request, 'updates') as unknown as BucketSchemaUpdate;
      await store.updateBucket(name, updates);
      return { name, updated: true };
    }

    case 'store.getBucketSchema': {
      const name = requireString(request, 'name');
      const config = store.getBucketSchema(name);
      if (config === undefined) {
        throw new NoexServerError(
          ErrorCode.BUCKET_NOT_DEFINED,
          `Bucket "${name}" does not exist`,
        );
      }
      return { name, config };
    }

    // ── Query management ──────────────────────────────────────────

    case 'store.defineQuery': {
      const name = requireString(request, 'name');
      const config = requireObject(request, 'config') as unknown as DeclarativeQueryConfig;
      store.defineDeclarativeQuery(name, config);
      return { name, defined: true };
    }

    case 'store.undefineQuery': {
      const name = requireString(request, 'name');
      const removed = store.undefineQuery(name);
      if (!removed) {
        throw new NoexServerError(
          ErrorCode.QUERY_NOT_DEFINED,
          `Query "${name}" is not defined`,
        );
      }
      return { name, undefined: true };
    }

    case 'store.listQueries': {
      return { queries: store.getQueries() };
    }

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown admin store operation "${request.type}"`,
      );
  }
}
