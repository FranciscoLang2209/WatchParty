import type { NextFunction, Request, Response } from 'express';
import { HttpError, NotFoundError, ValidationError } from '../errors/http-error.js';

const GENERIC_INTERNAL_MESSAGE = 'Ocurrió un error inesperado.';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError());
}

/**
 * `express.json()` lanza esto (no un `HttpError` propio) cuando el body no
 * es JSON válido, antes de que cualquier handler llegue a correr. Sin este
 * chequeo caía en la rama de 500 genérico, violando el contrato de WAT-130
 * ("cualquier body inválido responde 400 VALIDATION_ERROR").
 */
function isJsonParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    (err as { type?: unknown }).type === 'entity.parse.failed' &&
    (err as { status?: unknown }).status === 400
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express exige 4 parámetros para reconocer el middleware de errores
  _next: NextFunction,
): void {
  const httpError =
    err instanceof HttpError
      ? err
      : isJsonParseError(err)
        ? new ValidationError('El cuerpo de la solicitud no es JSON válido.')
        : null;

  if (httpError) {
    res
      .status(httpError.statusCode)
      .json({ error: { code: httpError.code, message: httpError.message } });
    return;
  }

  console.error(err);

  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: GENERIC_INTERNAL_MESSAGE },
  });
}
