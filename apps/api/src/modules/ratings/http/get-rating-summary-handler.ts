import type { RequestHandler } from 'express';
import type { MatchRatingService } from '../application/match-rating-service.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from '../../watched/http/match-id-pattern.js';

/**
 * `GET /matches/:matchId/rating-summary`: `{ average, count }` del partido.
 *
 * - Requiere sesión (lo exige el router), pero el resultado no depende de
 *   quién consulta: es el mismo para todos.
 * - Solo agregados. La respuesta se arma campo por campo, así que aunque el
 *   servicio devolviera más datos nunca saldrían identidades ni notas
 *   individuales.
 * - `average: null` con `count: 0` significa "sin votos" (no un promedio 0).
 * - El id de ruta se valida antes de tocar el servicio (400, no 404).
 *   Partido inexistente: 404. Un fallo de persistencia llega al error handler
 *   como 500 genérico, nunca como `{ average: null, count: 0 }`.
 */
export function createGetRatingSummaryHandler(
  service: MatchRatingService,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await service.getRatingSummary(matchId);

    if (result.kind === 'match_not_found') {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ average: result.summary.average, count: result.summary.count });
  };
}
