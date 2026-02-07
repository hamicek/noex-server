import type { Store } from '@hamicek/noex-store';
import {
  BucketNotDefinedError,
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';
import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

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

function requirePositiveInt(
  request: ClientRequest,
  field: string,
): number {
  const value = request[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Missing or invalid "${field}": expected positive integer`,
    );
  }
  return value;
}

function optionalObject(
  request: ClientRequest,
  field: string,
): Record<string, unknown> | undefined {
  const value = request[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid "${field}": expected object`,
    );
  }
  return value as Record<string, unknown>;
}

// ── Error mapping ─────────────────────────────────────────────────

export function mapStoreError(error: unknown): NoexServerError {
  if (error instanceof NoexServerError) return error;

  if (error instanceof BucketNotDefinedError) {
    return new NoexServerError(
      ErrorCode.BUCKET_NOT_DEFINED,
      error.message,
    );
  }

  if (error instanceof ValidationError) {
    return new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      error.message,
      error.issues,
    );
  }

  if (error instanceof UniqueConstraintError) {
    return new NoexServerError(
      ErrorCode.ALREADY_EXISTS,
      error.message,
      { bucket: error.bucket, field: error.field, value: error.value },
    );
  }

  if (error instanceof TransactionConflictError) {
    return new NoexServerError(
      ErrorCode.CONFLICT,
      error.message,
      { bucket: error.bucket, key: error.key },
    );
  }

  if (error instanceof QueryNotDefinedError) {
    return new NoexServerError(
      ErrorCode.QUERY_NOT_DEFINED,
      error.message,
    );
  }

  if (error instanceof Error) {
    return new NoexServerError(
      ErrorCode.INTERNAL_ERROR,
      error.message,
    );
  }

  return new NoexServerError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred',
  );
}

// ── Store operations ──────────────────────────────────────────────

export async function handleStoreRequest(
  request: ClientRequest,
  store: Store,
): Promise<unknown> {
  try {
    return await dispatchStoreOperation(request, store);
  } catch (error) {
    throw mapStoreError(error);
  }
}

async function dispatchStoreOperation(
  request: ClientRequest,
  store: Store,
): Promise<unknown> {
  switch (request.type) {
    case 'store.insert': {
      const bucketName = requireString(request, 'bucket');
      const data = requireObject(request, 'data');
      const bucket = store.bucket(bucketName);
      return bucket.insert(data);
    }

    case 'store.get': {
      const bucketName = requireString(request, 'bucket');
      const key = request['key'];
      if (key === undefined || key === null) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          'Missing "key": expected non-null value',
        );
      }
      const bucket = store.bucket(bucketName);
      return (await bucket.get(key)) ?? null;
    }

    case 'store.update': {
      const bucketName = requireString(request, 'bucket');
      const key = request['key'];
      if (key === undefined || key === null) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          'Missing "key": expected non-null value',
        );
      }
      const data = requireObject(request, 'data');
      const bucket = store.bucket(bucketName);
      return bucket.update(key, data);
    }

    case 'store.delete': {
      const bucketName = requireString(request, 'bucket');
      const key = request['key'];
      if (key === undefined || key === null) {
        throw new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          'Missing "key": expected non-null value',
        );
      }
      const bucket = store.bucket(bucketName);
      await bucket.delete(key);
      return { deleted: true };
    }

    case 'store.all': {
      const bucketName = requireString(request, 'bucket');
      const bucket = store.bucket(bucketName);
      return bucket.all();
    }

    case 'store.where': {
      const bucketName = requireString(request, 'bucket');
      const filter = requireObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return bucket.where(filter);
    }

    case 'store.findOne': {
      const bucketName = requireString(request, 'bucket');
      const filter = requireObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return (await bucket.findOne(filter)) ?? null;
    }

    case 'store.count': {
      const bucketName = requireString(request, 'bucket');
      const filter = optionalObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return bucket.count(filter);
    }

    case 'store.first': {
      const bucketName = requireString(request, 'bucket');
      const n = requirePositiveInt(request, 'n');
      const bucket = store.bucket(bucketName);
      return bucket.first(n);
    }

    case 'store.last': {
      const bucketName = requireString(request, 'bucket');
      const n = requirePositiveInt(request, 'n');
      const bucket = store.bucket(bucketName);
      return bucket.last(n);
    }

    case 'store.paginate': {
      const bucketName = requireString(request, 'bucket');
      const limit = requirePositiveInt(request, 'limit');
      const bucket = store.bucket(bucketName);
      return bucket.paginate({ limit, after: request['after'] });
    }

    case 'store.clear': {
      const bucketName = requireString(request, 'bucket');
      const bucket = store.bucket(bucketName);
      await bucket.clear();
      return { cleared: true };
    }

    case 'store.sum': {
      const bucketName = requireString(request, 'bucket');
      const field = requireString(request, 'field');
      const filter = optionalObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return bucket.sum(field, filter);
    }

    case 'store.avg': {
      const bucketName = requireString(request, 'bucket');
      const field = requireString(request, 'field');
      const filter = optionalObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return bucket.avg(field, filter);
    }

    case 'store.min': {
      const bucketName = requireString(request, 'bucket');
      const field = requireString(request, 'field');
      const filter = optionalObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return (await bucket.min(field, filter)) ?? null;
    }

    case 'store.max': {
      const bucketName = requireString(request, 'bucket');
      const field = requireString(request, 'field');
      const filter = optionalObject(request, 'filter');
      const bucket = store.bucket(bucketName);
      return (await bucket.max(field, filter)) ?? null;
    }

    case 'store.buckets': {
      const stats = await store.getStats();
      return stats.buckets;
    }

    case 'store.stats': {
      return store.getStats();
    }

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown store operation "${request.type}"`,
      );
  }
}
