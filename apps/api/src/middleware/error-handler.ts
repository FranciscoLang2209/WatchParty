import type { NextFunction, Request, Response } from 'express';
import { HttpError, NotFoundError } from '../errors/http-error.js';

const GENERIC_INTERNAL_MESSAGE = 'Ocurrió un error inesperado.';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError());
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express exige 4 parámetros para reconocer el middleware de errores
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  console.error(err);

  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: GENERIC_INTERNAL_MESSAGE },
  });
}
