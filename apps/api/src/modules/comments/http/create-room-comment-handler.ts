import type { RequestHandler } from 'express';
import type { CreateRoomCommentInput, RoomCommentStore } from '../domain/room-comment-store.js';
import { BODY_MAX_LENGTH, BODY_MIN_LENGTH, UUID_PATTERN } from '../domain/room-comment-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { toRoomCommentResponse } from './room-comment-response.js';

const ALLOWED_KEYS = ['body', 'clientRequestId'];

/**
 * Valida forma, tipos y límites ANTES de llamar al store — un payload
 * inválido nunca debe tocar la persistencia (mismo criterio que
 * put-own-profile-handler.ts). `roomId` no se valida acá: lo resuelve el
 * store contra `rooms` (WAT-151) y responde 404 si no existe.
 */
function parseBody(body: unknown): Omit<CreateRoomCommentInput, 'roomId'> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const keys = Object.keys(body);
  if (keys.length !== ALLOWED_KEYS.length || !ALLOWED_KEYS.every((key) => keys.includes(key))) {
    return null;
  }

  const { body: commentBody, clientRequestId } = body as Record<string, unknown>;

  if (typeof commentBody !== 'string' || typeof clientRequestId !== 'string') return null;

  const trimmedBody = commentBody.trim();
  if (trimmedBody.length < BODY_MIN_LENGTH || trimmedBody.length > BODY_MAX_LENGTH) return null;

  if (!UUID_PATTERN.test(clientRequestId)) return null;

  return { body: trimmedBody, clientRequestId };
}

export function createCreateRoomCommentHandler(
  store: RoomCommentStore,
): RequestHandler<{ roomId: string }> {
  return async (req, res, next) => {
    const { roomId } = req.params;
    const input = parseBody(req.body);

    if (!input) {
      next(new ValidationError());
      return;
    }

    const comment = await store.create({ roomId, ...input }, req.user!.id);

    if (!comment) {
      next(new NotFoundError());
      return;
    }

    res.status(201).json({ comment: toRoomCommentResponse(comment) });
  };
}
