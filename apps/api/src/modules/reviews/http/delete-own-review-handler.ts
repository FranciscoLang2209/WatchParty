import type { RequestHandler } from 'express';
import type { MatchReviewService } from '../application/match-review-service.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `DELETE /matches/:matchId/review`: elimina el texto de la reseña propia
 * (WAT-255). Responde siempre `200 { review: null }`, el mismo cuerpo que el
 * GET cuando no hay reseña: es idempotente, así que repetir el borrado (o
 * borrar sin haber reseñado) deja el mismo estado y la misma respuesta.
 *
 * - La identidad sale SOLO de `req.user`; un `userId` en body o query se
 *   ignora: no hay forma de borrar la reseña de otro usuario.
 * - El id de ruta se valida antes de tocar el servicio (400, no 404).
 * - Partido inexistente: 404. Un fallo de persistencia llega al error
 *   handler como 500 genérico, nunca como éxito.
 * - Solo se borra el texto: la calificación, el visto, el historial y los
 *   promedios no se tocan. Se puede borrar aunque el usuario haya deshecho
 *   "visto".
 */
export function createDeleteOwnReviewHandler(
  service: MatchReviewService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await service.deleteOwnReview(req.user!.id, matchId);

    if (result.kind === 'match_not_found') {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ review: null });
  };
}
