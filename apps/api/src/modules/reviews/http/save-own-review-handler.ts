import type { RequestHandler } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { normalizeMatchReviewBody } from '../domain/match-review-store.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `PUT /matches/:matchId/review` con body `{ "body": "texto" }`: guarda o
 * edita la reseña propia. Idempotente: repetir el mismo PUT deja una sola
 * fila y no cambia `updatedAt`. Responde igual que el GET: `{ review }`.
 *
 * - La identidad sale SOLO de `req.user`. Un `userId` en body o query se
 *   ignora: no hay forma de reseñar como otro usuario.
 * - Se valida antes de tocar el servicio: id de ruta (400) y texto (400 si
 *   falta, no es string, queda vacío tras quitar espacios exteriores, supera
 *   500 caracteres o tiene caracteres de control). Se guarda el texto ya
 *   recortado.
 * - Partido inexistente: 404. Partido no finalizado, no marcado como visto o
 *   sin nota propia: 409 CONFLICT (el recurso existe pero su estado no admite
 *   la operación), con mensaje distinto para cada caso.
 */
export function createSaveOwnReviewHandler(
  service: MatchReviewService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const body = normalizeMatchReviewBody((req.body as { body?: unknown } | undefined)?.body);

    if (body === null) {
      next(new ValidationError('La reseña debe ser un texto de 1 a 500 caracteres.'));
      return;
    }

    const result = await service.saveOwnReview(req.user!.id, matchId, body);

    switch (result.kind) {
      case 'match_not_found':
        next(new NotFoundError('No encontramos ese partido.'));
        return;
      case 'match_not_finished':
        next(new ConflictError('Sólo se puede reseñar un partido finalizado.'));
        return;
      case 'match_not_watched':
        next(new ConflictError('Marcá el partido como visto para poder reseñarlo.'));
        return;
      case 'match_not_rated':
        next(new ConflictError('Calificá el partido para poder reseñarlo.'));
        return;
      case 'ok': {
        const { review } = result;
        res.status(200).json({
          review: { body: review.body, createdAt: review.createdAt, updatedAt: review.updatedAt },
        });
      }
    }
  };
}
