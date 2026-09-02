export type HttpErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL_ERROR';

export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly statusCode: number;

  constructor(code: HttpErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'No autenticado.') {
    super('UNAUTHORIZED', 401, message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Recurso no encontrado.') {
    super('NOT_FOUND', 404, message);
    this.name = 'NotFoundError';
  }
}
