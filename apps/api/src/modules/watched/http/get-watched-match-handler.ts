import type { RequestHandler } from 'express';
import type { WatchedMatchStore } from '../domain/watched-match-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { UUID_PATTERN } from './match-id-pattern.js';

/**
 * Handler de `GET` sobre el partido visto propio (WAT-197): deja que la web
 * recupere el estado persistido tras recargar.
 *
 * Mismas reglas que el handler de marcado (WAT-178):
 * - La identidad sale SOLO de `req.user`; un `userId` en la query se ignora.
 * - El id de ruta se valida antes de tocar el store (400, no 404).
 * - `null` del store significa partido inexistente: 404.
 * - Un fallo de persistencia llega al error handler como 500 genérico,
 *   nunca como `{ watched: false }`.
 */
export function createGetWatchedMatchHandler(
  store: WatchedMatchStore,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;

    if (!UUID_PATTERN.test(matchId)) {
      next(new ValidationError());
      return;
    }

    const result = await store.getWatched(req.user!.id, matchId);

    if (!result) {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ watched: result.watched });
  };
}
