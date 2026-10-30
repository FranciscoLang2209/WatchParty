import type { RequestHandler } from 'express';
import type {
  ListWatchedHistoryPageOptions,
  WatchedHistoryItem,
  WatchedMatchStore,
} from '../domain/watched-match-store.js';
import {
  WATCHED_HISTORY_PAGE_DEFAULT_LIMIT,
  WATCHED_HISTORY_PAGE_MAX_LIMIT,
  WATCHED_HISTORY_PAGE_MIN_LIMIT,
  isValidWatchedAtCursor,
  isWatchedHistoryRatingStatus,
} from '../domain/watched-match-store.js';
import { ValidationError } from '../../../errors/http-error.js';
import { toMatchResponse, type MatchResponse } from '../../matches/http/match-response.js';
import { UUID_PATTERN } from './match-id-pattern.js';

interface WatchedHistoryItemResponse {
  match: MatchResponse;
  watchedAt: string;
  /** Nota propia (entero de 1 a 5), o `null` explícito si no lo calificó (WAT-261). */
  rating: number | null;
}

function toWatchedHistoryItemResponse(item: WatchedHistoryItem): WatchedHistoryItemResponse {
  return { match: toMatchResponse(item.match), watchedAt: item.watchedAt, rating: item.rating };
}

/**
 * Lee y valida la paginación y el filtro del query string ANTES de tocar el
 * store, mismo criterio que list-room-comments-handler.ts. Devuelve `null` si
 * algún parámetro es inválido.
 *
 * - `beforeWatchedAt` y `beforeMatchId` viajan juntos o ninguno de los dos.
 * - Sin `limit` se usa el límite por defecto; nunca se devuelve la lista
 *   completa sin acotar.
 * - `teamId` (WAT-262) es opcional y debe ser un UUID, como `teams.id`.
 * - `ratingStatus` (WAT-263) es opcional y debe ser `all`, `rated` o
 *   `unrated`; omitirlo equivale a `all`.
 */
function parseListOptions(query: Record<string, unknown>): ListWatchedHistoryPageOptions | null {
  const { beforeWatchedAt, beforeMatchId, limit: rawLimit, teamId, ratingStatus } = query;

  // Un parámetro repetido (?limit=1&limit=2) llega como array: se rechaza.
  if (
    [beforeWatchedAt, beforeMatchId, rawLimit, teamId, ratingStatus].some(
      (value) => value !== undefined && typeof value !== 'string',
    )
  ) {
    return null;
  }

  if (teamId !== undefined && !UUID_PATTERN.test(teamId as string)) return null;
  if (ratingStatus !== undefined && !isWatchedHistoryRatingStatus(ratingStatus)) return null;

  const pagination = parsePagination(beforeWatchedAt, beforeMatchId, rawLimit);
  if (!pagination) return null;

  return {
    ...pagination,
    ...(teamId !== undefined && { teamId: teamId as string }),
    ...(ratingStatus !== undefined && { ratingStatus }),
  };
}

function parsePagination(
  beforeWatchedAt: unknown,
  beforeMatchId: unknown,
  rawLimit: unknown,
): ListWatchedHistoryPageOptions | null {
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

  if (!isValidWatchedAtCursor(watchedAt) || !UUID_PATTERN.test(matchId)) return null;

  return { limit, before: { watchedAt, matchId } };
}

/**
 * Handler de `GET /me/watched-matches` (WAT-217): historial propio de
 * partidos vistos, del más reciente al más antiguo. El usuario sale siempre
 * del bearer (`req.user`), nunca del query string; `teamId` opcional filtra
 * por equipo local o visitante (WAT-262) y `ratingStatus` por nota propia
 * (WAT-263). Cada item incluye la nota
 * propia (WAT-261); si el store no pudo leerla, lanza y responde 500, nunca
 * `rating: null`.
 */
export function createListWatchedHistoryHandler(store: WatchedMatchStore): RequestHandler {
  return async (req, res, next) => {
    const options = parseListOptions(req.query);

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
