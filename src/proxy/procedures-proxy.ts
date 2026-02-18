import type { ClientRequest } from '../protocol/types.js';
import { ErrorCode } from '../protocol/codes.js';
import { NoexServerError } from '../errors.js';
import type { ProcedureEngine } from '../procedures/procedure-engine.js';
import {
  ProcedureNotFoundError,
  ProcedureAlreadyExistsError,
  ProcedureInputError,
  ProcedureTimeoutError,
} from '../procedures/procedure-engine.js';
import { ProcedureValidationError } from '../procedures/procedure-validator.js';
import type { ProcedureConfig } from '../procedures/procedure-types.js';

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

// ── Procedures operations ─────────────────────────────────────────

export async function handleProceduresRequest(
  request: ClientRequest,
  engine: ProcedureEngine,
): Promise<unknown> {
  try {
    return await dispatchProceduresOperation(request, engine);
  } catch (error) {
    if (error instanceof NoexServerError) throw error;
    throw mapProcedureError(error);
  }
}

async function dispatchProceduresOperation(
  request: ClientRequest,
  engine: ProcedureEngine,
): Promise<unknown> {
  switch (request.type) {
    case 'procedures.register': {
      const procedure = requireObject(request, 'procedure') as unknown as ProcedureConfig;
      engine.register(procedure);
      return { name: procedure.name, registered: true };
    }

    case 'procedures.unregister': {
      const name = requireString(request, 'name');
      const removed = engine.unregister(name);
      if (!removed) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Procedure "${name}" not found`,
        );
      }
      return { name, unregistered: true };
    }

    case 'procedures.update': {
      const name = requireString(request, 'name');
      const updates = requireObject(request, 'updates') as unknown as Partial<ProcedureConfig>;
      engine.update(name, updates);
      return { name, updated: true };
    }

    case 'procedures.get': {
      const name = requireString(request, 'name');
      const procedure = engine.get(name);
      if (!procedure) {
        throw new NoexServerError(
          ErrorCode.NOT_FOUND,
          `Procedure "${name}" not found`,
        );
      }
      return procedure;
    }

    case 'procedures.list': {
      return { procedures: engine.list() };
    }

    case 'procedures.call': {
      const name = requireString(request, 'name');
      const input = (request['input'] as Record<string, unknown>) ?? {};
      return engine.call(name, input);
    }

    default:
      throw new NoexServerError(
        ErrorCode.UNKNOWN_OPERATION,
        `Unknown procedures operation "${request.type}"`,
      );
  }
}

function mapProcedureError(error: unknown): NoexServerError {
  if (error instanceof ProcedureNotFoundError) {
    return new NoexServerError(ErrorCode.NOT_FOUND, error.message);
  }
  if (error instanceof ProcedureAlreadyExistsError) {
    return new NoexServerError(ErrorCode.ALREADY_EXISTS, error.message);
  }
  if (error instanceof ProcedureInputError) {
    return new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      error.message,
      { issues: error.issues },
    );
  }
  if (error instanceof ProcedureValidationError) {
    return new NoexServerError(
      ErrorCode.VALIDATION_ERROR,
      error.message,
      { issues: error.issues },
    );
  }
  if (error instanceof ProcedureTimeoutError) {
    return new NoexServerError(ErrorCode.INTERNAL_ERROR, error.message);
  }

  // Fallback: match by error name for cross-module resilience
  if (error instanceof Error) {
    switch (error.name) {
      case 'ProcedureNotFoundError':
        return new NoexServerError(ErrorCode.NOT_FOUND, error.message);
      case 'ProcedureAlreadyExistsError':
        return new NoexServerError(ErrorCode.ALREADY_EXISTS, error.message);
      case 'ProcedureInputError':
        return new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          error.message,
          { issues: (error as ProcedureInputError).issues ?? [] },
        );
      case 'ProcedureValidationError':
        return new NoexServerError(
          ErrorCode.VALIDATION_ERROR,
          error.message,
          { issues: (error as ProcedureValidationError).issues ?? [] },
        );
      case 'ProcedureTimeoutError':
        return new NoexServerError(ErrorCode.INTERNAL_ERROR, error.message);
      case 'ValidationError':
        return new NoexServerError(ErrorCode.VALIDATION_ERROR, error.message);
    }
  }

  return new NoexServerError(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : 'Internal server error',
  );
}
