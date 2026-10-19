import type { RequestHandler } from 'express';
import type { MatchRatingService } from '../application/match-rating-service.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `GET /matches/:matchId/rating`: nota propia, o `{ rating: null }` si el
 * usuario todavía no calificó ese partido.
 *
 * - La identidad sale SOLO de `req.user`; un `userId` en la query se ignora.
 * - El id de ruta se valida antes de tocar el servicio (400, no 404).
 * - Partido inexistente: 404. Un fallo de persistencia llega al error
 *   handler como 500 genérico, nunca como `{ rating: null }`.
 */
export function createGetOwnRatingHandler(
  service: MatchRatingService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await service.getOwnRating(req.user!.id, matchId);

    if (result.kind === 'match_not_found') {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ rating: result.rating });
  };
}
