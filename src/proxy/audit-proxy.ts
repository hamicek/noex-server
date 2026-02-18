import type { ClientRequest } from '../protocol/types.js';
import type { AuditLog } from '../audit/audit-log.js';
import type { AuditQuery } from '../audit/audit-types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';

export function handleAuditRequest(
  request: ClientRequest,
  auditLog: AuditLog,
): unknown {
  switch (request.type) {
    case 'audit.query':
      return handleAuditQuery(request, auditLog);

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown audit operation "${request.type}"`,
      );
  }
}

function handleAuditQuery(
  request: ClientRequest,
  auditLog: AuditLog,
): { entries: unknown[] } {
  const filter: AuditQuery = {};
  const mutable = filter as Record<string, unknown>;

  if (request['userId'] !== undefined) {
    if (typeof request['userId'] !== 'string') {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "userId": expected string',
      );
    }
    mutable['userId'] = request['userId'];
  }

  if (request['operation'] !== undefined) {
    if (typeof request['operation'] !== 'string') {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "operation": expected string',
      );
    }
    mutable['operation'] = request['operation'];
  }

  if (request['result'] !== undefined) {
    if (request['result'] !== 'success' && request['result'] !== 'error') {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "result": expected "success" or "error"',
      );
    }
    mutable['result'] = request['result'];
  }

  if (request['from'] !== undefined) {
    if (typeof request['from'] !== 'number') {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "from": expected number',
      );
    }
    mutable['from'] = request['from'];
  }

  if (request['to'] !== undefined) {
    if (typeof request['to'] !== 'number') {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "to": expected number',
      );
    }
    mutable['to'] = request['to'];
  }

  if (request['limit'] !== undefined) {
    if (
      typeof request['limit'] !== 'number' ||
      !Number.isInteger(request['limit']) ||
      request['limit'] < 1
    ) {
      throw new NoexServerError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid "limit": expected positive integer',
      );
    }
    mutable['limit'] = request['limit'];
  }

  return { entries: auditLog.query(filter) };
}
