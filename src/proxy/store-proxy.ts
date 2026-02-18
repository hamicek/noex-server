import type { Store } from '@hamicek/noex-store';
import {
  BucketAlreadyExistsError,
  BucketNotDefinedError,
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
  QueryAlreadyDefinedError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';
import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import { generateSubscriptionId } from './query-subscription-map.js';

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

  if (error instanceof BucketAlreadyExistsError) {
    return new NoexServerError(
      ErrorCode.ALREADY_EXISTS,
      error.message,
    );
  }

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

  if (error instanceof QueryAlreadyDefinedError) {
    return new NoexServerError(
      ErrorCode.ALREADY_EXISTS,
      error.message,
    );
  }

  if (error instanceof QueryNotDefinedError) {
    return new NoexServerError(
      ErrorCode.QUERY_NOT_DEFINED,
      error.message,
    );
  }

  // Fallback: match by error name for cross-module-boundary resilience
  // (instanceof fails when multiple copies of @hamicek/noex-store are resolved)
  if (error instanceof Error) {
    switch (error.name) {
      case 'BucketAlreadyExistsError':
        return new NoexServerError(ErrorCode.ALREADY_EXISTS, error.message);
      case 'BucketNotDefinedError':
        return new NoexServerError(ErrorCode.BUCKET_NOT_DEFINED, error.message);
      case 'ValidationError':
        return new NoexServerError(ErrorCode.VALIDATION_ERROR, error.message);
      case 'UniqueConstraintError':
        return new NoexServerError(ErrorCode.ALREADY_EXISTS, error.message);
      case 'TransactionConflictError':
        return new NoexServerError(ErrorCode.CONFLICT, error.message);
      case 'QueryAlreadyDefinedError':
        return new NoexServerError(ErrorCode.ALREADY_EXISTS, error.message);
      case 'QueryNotDefinedError':
        return new NoexServerError(ErrorCode.QUERY_NOT_DEFINED, error.message);
      default:
        return new NoexServerError(ErrorCode.INTERNAL_ERROR, error.message);
    }
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

// ── Subscription operations ──────────────────────────────────────

export async function handleStoreSubscribe(
  request: ClientRequest,
  store: Store,
  subscriptions: Map<string, () => void>,
  onPush: (subscriptionId: string, data: unknown) => void,
): Promise<{ subscriptionId: string; data: unknown }> {
  try {
    const queryName = requireString(request, 'query');
    const params = request['params'];
    const subscriptionId = generateSubscriptionId();
    const resolvedParams = params !== undefined && params !== null
      ? params
      : undefined;

    const callback = (result: unknown): void => {
      if (subscriptions.has(subscriptionId)) {
        onPush(subscriptionId, result);
      }
    };

    if (resolvedParams !== undefined) {
      const unsub = await store.subscribe(queryName, resolvedParams, callback);
      subscriptions.set(subscriptionId, unsub);
    } else {
      const unsub = await store.subscribe(queryName, callback);
      subscriptions.set(subscriptionId, unsub);
    }

    const initialResult = await store.runQuery(queryName, resolvedParams);

    return { subscriptionId, data: initialResult };
  } catch (error) {
    throw mapStoreError(error);
  }
}

export function handleStoreUnsubscribe(
  request: ClientRequest,
  subscriptions: Map<string, () => void>,
): { unsubscribed: true } {
  const subscriptionId = requireString(request, 'subscriptionId');
  const unsub = subscriptions.get(subscriptionId);

  if (!unsub) {
    throw new NoexServerError(
      ErrorCode.NOT_FOUND,
      `Subscription "${subscriptionId}" not found`,
    );
  }

  unsub();
  subscriptions.delete(subscriptionId);
  return { unsubscribed: true };
}

// ── Transaction operations ───────────────────────────────────────

interface TransactionOp {
  readonly op: string;
  readonly bucket: string;
  readonly key?: unknown;
  readonly data?: Record<string, unknown>;
  readonly filter?: Record<string, unknown>;
}

const VALID_TX_OPS = new Set([
  'get', 'insert', 'update', 'delete', 'where', 'findOne', 'count',
]);

function validateOperations(operations: unknown): TransactionOp[] {
  if (!Array.isArray(operations)) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      'Missing or invalid "operations": expected array',
    );
  }

  if (operations.length === 0) {
    throw new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      '"operations" must contain at least one operation',
    );
  }

  const result: TransactionOp[] = [];

  for (let i = 0; i < operations.length; i++) {
    const raw = operations[i] as Record<string, unknown> | null;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: expected object`,
      );
    }

    const op = raw['op'];
    if (typeof op !== 'string' || !VALID_TX_OPS.has(op)) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: invalid "op" — expected one of: ${[...VALID_TX_OPS].join(', ')}`,
      );
    }

    const bucket = raw['bucket'];
    if (typeof bucket !== 'string' || bucket.length === 0) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: missing or invalid "bucket"`,
      );
    }

    if ((op === 'get' || op === 'update' || op === 'delete') && (raw['key'] === undefined || raw['key'] === null)) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: "${op}" requires "key"`,
      );
    }

    if ((op === 'insert' || op === 'update') && (typeof raw['data'] !== 'object' || raw['data'] === null || Array.isArray(raw['data']))) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: "${op}" requires "data" object`,
      );
    }

    if ((op === 'where' || op === 'findOne') && (typeof raw['filter'] !== 'object' || raw['filter'] === null || Array.isArray(raw['filter']))) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        `operations[${i}]: "${op}" requires "filter" object`,
      );
    }

    result.push(raw as unknown as TransactionOp);
  }

  return result;
}

export async function handleStoreTransaction(
  request: ClientRequest,
  store: Store,
): Promise<{ results: Array<{ index: number; data: unknown }> }> {
  const operations = validateOperations(request['operations']);

  try {
    return await store.transaction(async (tx) => {
      const results: Array<{ index: number; data: unknown }> = [];

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i]!;
        const bucket = await tx.bucket(op.bucket);
        let data: unknown;

        switch (op.op) {
          case 'get':
            data = (await bucket.get(op.key)) ?? null;
            break;
          case 'insert':
            data = await bucket.insert(op.data!);
            break;
          case 'update':
            data = await bucket.update(op.key, op.data!);
            break;
          case 'delete':
            await bucket.delete(op.key);
            data = { deleted: true };
            break;
          case 'where':
            data = await bucket.where(op.filter!);
            break;
          case 'findOne':
            data = (await bucket.findOne(op.filter!)) ?? null;
            break;
          case 'count':
            data = await bucket.count(op.filter);
            break;
        }

        results.push({ index: i, data });
      }

      return { results };
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}
