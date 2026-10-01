import type { RequestHandler } from 'express';
import type {
  ListRoomCommentsPageOptions,
  RoomCommentStore,
} from '../domain/room-comment-store.js';
import {
  COMMENTS_PAGE_MAX_LIMIT,
  COMMENTS_PAGE_MIN_LIMIT,
  CURSOR_TIMESTAMP_PATTERN,
  UUID_PATTERN,
} from '../domain/room-comment-store.js';
import { NotFoundError, ValidationError } from '../../../errors/http-error.js';
import { toRoomCommentResponse } from './room-comment-response.js';

const PAGINATION_PARAMS = ['beforeCreatedAt', 'beforeId', 'limit'] as const;

type PaginationRequest =
  { mode: 'legacy' } | { mode: 'page'; options: ListRoomCommentsPageOptions };

/**
 * Lee y valida los parámetros de paginación del query string ANTES de tocar
 * el store (mismo criterio que create-room-comment-handler.ts). Devuelve
 * `null` si algún parámetro es inválido.
 *
 * - Sin ningún parámetro de paginación: `legacy`, el listado completo de
 *   siempre (compatibilidad con consumidores existentes y reconexión).
 * - `beforeCreatedAt` y `beforeId` viajan juntos o ninguno de los dos.
 * - `limit` solo (sin cursor) pide la primera página.
 *
 * Nota de nombres: el cursor de la API se llama `before*` pero el store lo
 * recibe como `after` — la página devuelve comentarios posteriores a esa
 * posición en el orden `(created_at, id)`.
 */
function parsePagination(query: Record<string, unknown>): PaginationRequest | null {
  if (!PAGINATION_PARAMS.some((param) => param in query)) return { mode: 'legacy' };

  const { beforeCreatedAt, beforeId, limit: rawLimit } = query;

  // Un parámetro repetido (?limit=1&limit=2) llega como array: se rechaza.
  if (
    [beforeCreatedAt, beforeId, rawLimit].some(
      (value) => value !== undefined && typeof value !== 'string',
    )
  ) {
    return null;
  }

  if ((beforeCreatedAt === undefined) !== (beforeId === undefined)) return null;

  let limit = COMMENTS_PAGE_MAX_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit as string)) return null;
    limit = Number(rawLimit);
    if (limit < COMMENTS_PAGE_MIN_LIMIT || limit > COMMENTS_PAGE_MAX_LIMIT) return null;
  }

  if (beforeCreatedAt === undefined || beforeId === undefined) {
    return { mode: 'page', options: { limit } };
  }

  if (
    typeof beforeCreatedAt !== 'string' ||
    typeof beforeId !== 'string' ||
    !CURSOR_TIMESTAMP_PATTERN.test(beforeCreatedAt) ||
    Number.isNaN(Date.parse(beforeCreatedAt)) ||
    !UUID_PATTERN.test(beforeId)
  ) {
    return null;
  }

  return { mode: 'page', options: { limit, after: { createdAt: beforeCreatedAt, id: beforeId } } };
}

export function createListRoomCommentsHandler(
  store: RoomCommentStore,
): RequestHandler<{ roomId: string }> {
  return async (req, res, next) => {
    const { roomId } = req.params;
    const pagination = parsePagination(req.query);

    if (!pagination) {
      next(new ValidationError());
      return;
    }

    if (pagination.mode === 'legacy') {
      const comments = await store.listByRoom(roomId);

      if (!comments) {
        next(new NotFoundError());
        return;
      }

      res.status(200).json({ comments: comments.map(toRoomCommentResponse) });
      return;
    }

    const page = await store.listPageByRoom(roomId, pagination.options);

    if (!page) {
      next(new NotFoundError());
      return;
    }

    res.status(200).json({
      comments: page.items.map(toRoomCommentResponse),
      nextCursor: page.nextCursor,
    });
  };
}
