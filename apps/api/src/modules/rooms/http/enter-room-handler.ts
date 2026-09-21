import type { RequestHandler } from 'express';
import type { PublicRoomStore } from '../domain/public-room-store.js';
import { UUID_PATTERN } from '../../profiles/domain/own-profile-store.js';
import { NotFoundError } from '../../../errors/http-error.js';

/**
 * `POST /matches/:matchId/room` (WAT-148): crea o devuelve la sala pública
 * del partido. No lee nada del cuerpo: la persona sale del bearer, nunca de
 * un `userId` del cliente. Un id que no es UUID no puede ser un partido, así
 * que responde 404 sin consultar el store.
 */
export function createEnterRoomHandler(
  store: PublicRoomStore,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;
    const room = UUID_PATTERN.test(matchId) ? await store.getOrCreatePublicRoom(matchId) : null;

    if (!room) {
      next(new NotFoundError('No encontramos ese partido.'));
      return;
    }

    res.status(200).json({ room });
  };
}
