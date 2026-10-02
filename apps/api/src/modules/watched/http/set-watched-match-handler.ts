import type { RequestHandler } from 'express';
import type { WatchedMatchStore } from '../domain/watched-match-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';

// Mismo patrón que UUID_PATTERN en modules/comments/domain/room-comment-store.ts.
// Se define acá para no acoplar `watched` al dominio de otro módulo.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handler compartido por `PUT` (marcar, `watched: true`) y `DELETE` (deshacer,
 * `watched: false`) sobre el partido visto propio (WAT-178). Una sola fábrica
 * parametrizada evita duplicar validación y mapeo de errores entre los dos
 * verbos (mismo criterio que el handler de reacciones, WAT-176).
 *
 * - La identidad sale SOLO de `req.user` (puesto por `requireAuthenticatedUser`,
 *   que corre antes). Ni `req.body` ni `req.query` se leen: un `userId` o un
 *   `watched` que mande el cliente se ignora.
 * - El id de ruta se valida ANTES de tocar el store: un id mal formado nunca
 *   llega a la persistencia (400, no 404).
 * - `null` del store significa partido inexistente: 404.
 * - Es 200 en ambos verbos: la operación es idempotente y puede no crear ni
 *   borrar nada (repetir un PUT, o un DELETE sin relación previa).
 */
export function createSetWatchedMatchHandler(
  store: WatchedMatchStore,
  watched: boolean,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await store.setWatched(req.user!.id, matchId, watched);

    if (!result) {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ watched: result.watched });
  };
}
