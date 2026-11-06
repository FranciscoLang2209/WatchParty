import type { RequestHandler } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';
import {
  MATCH_REVIEWS_PAGE_DEFAULT_LIMIT,
  MATCH_REVIEWS_PAGE_MAX_LIMIT,
  MATCH_REVIEWS_PAGE_MIN_LIMIT,
  type ListMatchReviewsOptions,
} from '../domain/match-review-store.js';
import type { ReviewsCursorCodec } from '../domain/match-review-cursor.js';

/**
 * Lee y valida `limit` y `cursor` ANTES de tocar el servicio. Devuelve `null`
 * si alguno es inválido. Un parámetro repetido (`?limit=1&limit=2`) llega como
 * array y se rechaza.
 */
function parsePagination(
  query: Record<string, unknown>,
  cursorCodec: ReviewsCursorCodec,
): ListMatchReviewsOptions | null {
  const { limit: rawLimit, cursor: rawCursor } = query;

  if ([rawLimit, rawCursor].some((value) => value !== undefined && typeof value !== 'string')) {
    return null;
  }

  let limit = MATCH_REVIEWS_PAGE_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit as string)) return null;
    limit = Number(rawLimit);
    if (limit < MATCH_REVIEWS_PAGE_MIN_LIMIT || limit > MATCH_REVIEWS_PAGE_MAX_LIMIT) return null;
  }

  if (rawCursor === undefined) return { limit };

  const after = cursorCodec.decode(rawCursor as string);
  return after ? { limit, after } : null;
}

/**
 * `GET /matches/:matchId/reviews` (WAT-256): opiniones públicas de un partido
 * para cualquier usuario autenticado, de la más reciente a la más antigua.
 *
 * - Respuesta: `{ reviews: [{ authorName, body, createdAt }], nextCursor }`.
 *   Se arma campo por campo: nunca sale email, id de cuenta ni nota. Sin
 *   reseñas es `{ reviews: [], nextCursor: null }`.
 * - `nextCursor` es un texto opaco y cifrado (nunca lleva el id de cuenta
 *   legible): se pasa tal cual en `?cursor=` para pedir
 *   la página siguiente; `null` cuando no hay más. `limit` es opcional
 *   (1 a 50, por defecto 20).
 * - El id de ruta, `limit` y `cursor` se validan antes de tocar el servicio
 *   (400). Partido inexistente: 404. Un fallo de persistencia llega al error
 *   handler como 500 genérico, nunca como lista vacía.
 */
export function createListMatchReviewsHandler(
  service: MatchReviewService,
  cursorCodec: ReviewsCursorCodec,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const options = parsePagination(req.query, cursorCodec);

    if (!options) {
      next(new ValidationError());
      return;
    }

    const result = await service.listMatchReviews(matchId, options);

    if (result.kind === 'match_not_found') {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    const { items, nextCursor } = result.page;
    res.status(200).json({
      reviews: items.map(({ authorName, body, createdAt }) => ({ authorName, body, createdAt })),
      nextCursor: nextCursor ? cursorCodec.encode(nextCursor) : null,
    });
  };
}
