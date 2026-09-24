import type { RequestHandler } from 'express';
import type { PublicRoomStore } from '../domain/public-room-store.js';
import { UUID_PATTERN } from '../../profiles/domain/own-profile-store.js';
import { NotFoundError } from '../../../errors/http-error.js';

/**
 * `GET /rooms/:roomId` (WAT-148): vuelve a cargar una sala por su id. Un id
 * que no es UUID responde 404 sin consultar el store.
 */
export function createGetRoomHandler(store: PublicRoomStore): RequestHandler<{ roomId: string }> {
  return async (req, res, next) => {
    const { roomId } = req.params;
    const room = UUID_PATTERN.test(roomId) ? await store.findPublicRoomById(roomId) : null;

    if (!room) {
      next(new NotFoundError('No encontramos esa sala.'));
      return;
    }

    res.status(200).json({ room });
  };
}
