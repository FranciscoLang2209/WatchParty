import type { RequestHandler } from 'express';
import type { RoomCommentReactionStore } from '../domain/room-comment-reaction-store.js';
import { UUID_PATTERN } from '../domain/room-comment-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { toRoomCommentReactionResponse } from './room-comment-reaction-response.js';

/**
 * Handler compartido por `PUT` (marcar, `reacted: true`) y `DELETE` (quitar,
 * `reacted: false`) sobre la reacción propia de un comentario (WAT-176).
 * Una sola fábrica parametrizada evita duplicar validación y mapeo de
 * errores entre los dos verbos.
 *
 * - La identidad sale SOLO de `req.user` (puesto por
 *   `requireAuthenticatedUser`, que corre antes). `req.body` no se lee: un
 *   `userId` o cualquier otro campo que mande el cliente se ignora.
 * - Los ids de ruta se validan ANTES de tocar el store: un id mal formado
 *   nunca llega a la persistencia (400, no 404).
 * - `null` del store significa sala o comentario inexistente, o comentario
 *   de otra sala: 404 sin filtrar cuál de los casos fue.
 * - Es 200 en ambos verbos: la operación es idempotente y puede no crear
 *   ni borrar nada (repetir un PUT, o un DELETE sin reacción previa).
 */
export function createSetRoomCommentReactionHandler(
  store: RoomCommentReactionStore,
  reacted: boolean,
): RequestHandler<{ roomId: string; commentId: string }> {
  return async (req, res, next) => {
    const { roomId, commentId } = req.params;

    if (!UUID_PATTERN.test(roomId) || !UUID_PATTERN.test(commentId)) {
      next(new ValidationError());
      return;
    }

    const state = await store.setReaction({
      roomId,
      commentId,
      userId: req.user!.id,
      reacted,
    });

    if (!state) {
      next(new NotFoundError());
      return;
    }

    res.status(200).json({ reaction: toRoomCommentReactionResponse(state) });
  };
}
