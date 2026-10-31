import type { RequestHandler } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `GET /matches/:matchId/review`: reseña propia, o `{ review: null }` si el
 * usuario todavía no reseñó ese partido.
 *
 * - La identidad sale SOLO de `req.user`; un `userId` en la query se ignora.
 * - El id de ruta se valida antes de tocar el servicio (400, no 404).
 * - Partido inexistente: 404. Un fallo de persistencia llega al error
 *   handler como 500 genérico, nunca como `{ review: null }`.
 * - Se arma la respuesta campo por campo: solo sale `{ body, createdAt,
 *   updatedAt }`.
 */
export function createGetOwnReviewHandler(
  service: MatchReviewService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await service.getOwnReview(req.user!.id, matchId);

    if (result.kind === 'match_not_found') {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    const { review } = result;
    res.status(200).json({
      review: review
        ? { body: review.body, createdAt: review.createdAt, updatedAt: review.updatedAt }
        : null,
    });
  };
}
