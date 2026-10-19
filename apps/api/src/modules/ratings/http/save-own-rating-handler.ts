import type { RequestHandler } from 'express';
import type { MatchRatingService } from '../application/match-rating-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { isValidMatchRating } from '../domain/match-rating-store.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `PUT /matches/:matchId/rating` con body `{ "rating": 1..5 }`: guarda o
 * edita la nota propia. Idempotente: repetir el mismo PUT deja una sola fila.
 *
 * - La identidad sale SOLO de `req.user`. Un `userId` en body o query se
 *   ignora: no hay forma de calificar como otro usuario.
 * - Se valida antes de tocar el servicio: id de ruta (400) y `rating` (400
 *   si falta, es decimal, string, o está fuera de 1–5).
 * - Partido inexistente: 404. Partido no finalizado o no marcado como visto
 *   por el usuario: 409 CONFLICT (el recurso existe pero su estado no admite
 *   la operación), con mensaje distinto para cada caso.
 */
export function createSaveOwnRatingHandler(
  service: MatchRatingService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const rating: unknown = (req.body as { rating?: unknown } | undefined)?.rating;

    if (!isValidMatchRating(rating)) {
      next(new ValidationError('La calificación debe ser un entero entre 1 y 5.'));
      return;
    }

    const result = await service.saveOwnRating(req.user!.id, matchId, rating);

    switch (result.kind) {
      case 'match_not_found':
        next(new NotFoundError('No encontramos ese partido.'));
        return;
      case 'match_not_finished':
        next(new ConflictError('Sólo se puede calificar un partido finalizado.'));
        return;
      case 'match_not_watched':
        next(new ConflictError('Marcá el partido como visto para poder calificarlo.'));
        return;
      case 'ok':
        res.status(200).json({ rating: result.rating });
    }
  };
}
