import type { RequestHandler } from 'express';
import type {
  ListWatchedHistoryPageOptions,
  WatchedHistoryItem,
  WatchedMatchStore,
} from '../domain/watched-match-store.js';
import {
  WATCHED_AT_CURSOR_PATTERN,
  WATCHED_HISTORY_PAGE_DEFAULT_LIMIT,
  WATCHED_HISTORY_PAGE_MAX_LIMIT,
  WATCHED_HISTORY_PAGE_MIN_LIMIT,
} from '../domain/watched-match-store.js';
import { ValidationError } from '../../../errors/http-error.js';
import { toMatchResponse, type MatchResponse } from '../../matches/http/match-response.js';
import { UUID_PATTERN } from './match-id-pattern.js';

interface WatchedHistoryItemResponse {
  match: MatchResponse;
  watchedAt: string;
}

function toWatchedHistoryItemResponse(item: WatchedHistoryItem): WatchedHistoryItemResponse {
  return { match: toMatchResponse(item.match), watchedAt: item.watchedAt };
}

/**
 * Lee y valida la paginación del query string ANTES de tocar el store, mismo
 * criterio que list-room-comments-handler.ts. Devuelve `null` si algún
 * parámetro es inválido.
 *
 * - `beforeWatchedAt` y `beforeMatchId` viajan juntos o ninguno de los dos.
 * - Sin `limit` se usa el límite por defecto; nunca se devuelve la lista
 *   completa sin acotar.
 */
function parsePagination(query: Record<string, unknown>): ListWatchedHistoryPageOptions | null {
  const { beforeWatchedAt, beforeMatchId, limit: rawLimit } = query;

  // Un parámetro repetido (?limit=1&limit=2) llega como array: se rechaza.
  if (
    [beforeWatchedAt, beforeMatchId, rawLimit].some(
      (value) => value !== undefined && typeof value !== 'string',
    )
  ) {
    return null;
  }

  let limit = WATCHED_HISTORY_PAGE_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit as string)) return null;
    limit = Number(rawLimit);
    if (limit < WATCHED_HISTORY_PAGE_MIN_LIMIT || limit > WATCHED_HISTORY_PAGE_MAX_LIMIT) {
      return null;
    }
  }

  if (beforeWatchedAt === undefined && beforeMatchId === undefined) return { limit };
  if (beforeWatchedAt === undefined || beforeMatchId === undefined) return null;

  const watchedAt = beforeWatchedAt as string;
  const matchId = beforeMatchId as string;

  if (
    !WATCHED_AT_CURSOR_PATTERN.test(watchedAt) ||
    Number.isNaN(Date.parse(watchedAt)) ||
    !UUID_PATTERN.test(matchId)
  ) {
    return null;
  }

  return { limit, before: { watchedAt, matchId } };
}

/**
 * Handler de `GET /me/watched-matches` (WAT-217): historial propio de
 * partidos vistos, del más reciente al más antiguo. El usuario sale siempre
 * del bearer (`req.user`), nunca del query string.
 */
export function createListWatchedHistoryHandler(store: WatchedMatchStore): RequestHandler {
  return async (req, res, next) => {
    const options = parsePagination(req.query);

    if (!options) {
      next(new ValidationError());
      return;
    }

    const page = await store.listHistoryPage(req.user!.id, options);

    res.status(200).json({
      items: page.items.map(toWatchedHistoryItemResponse),
      nextCursor: page.nextCursor,
    });
  };
}
