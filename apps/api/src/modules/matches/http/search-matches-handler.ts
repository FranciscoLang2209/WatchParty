import type { RequestHandler } from 'express';
import { ValidationError } from '../../../errors/http-error.js';
import {
  InvalidSearchCursorError,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LIMIT,
  type MatchSearch,
} from '../domain/match-search.js';
import { toMatchResponse } from './match-response.js';

/** Tamaño de página de la API: 20 resultados, el máximo que admite la búsqueda. */
export const SEARCH_PAGE_SIZE = SEARCH_MAX_LIMIT;

/** Un nombre de equipo cabe de sobra: más largo es un pedido mal formado. */
export const SEARCH_TEXT_MAX_LENGTH = 100;
const CURSOR_MAX_LENGTH = 512;

interface SearchParams {
  text: string;
  limit: number;
  cursor: string | null;
}

/**
 * Lee y valida el query string ANTES de tocar la búsqueda. Devuelve `null` si
 * algún parámetro es inválido. Un parámetro repetido (`?q=a&q=b`) llega como
 * array y se rechaza, igual que en el listado de comentarios.
 */
function parseSearchParams(query: Record<string, unknown>): SearchParams | null {
  const { q, limit: rawLimit, cursor: rawCursor } = query;

  if (typeof q !== 'string') return null;

  const text = q.trim();
  if (text === '' || text.length > SEARCH_TEXT_MAX_LENGTH) return null;

  let limit = SEARCH_PAGE_SIZE;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < SEARCH_MIN_LIMIT || limit > SEARCH_MAX_LIMIT) return null;
  }

  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string' || rawCursor === '' || rawCursor.length > CURSOR_MAX_LENGTH) {
      return null;
    }
  }

  return { text, limit, cursor: (rawCursor as string | undefined) ?? null };
}

/**
 * Busca partidos persistidos por parte del nombre del equipo local o
 * visitante (WAT-239). Reutiliza `MatchSearch` (WAT-167): no consulta al
 * proveedor deportivo ni se limita a la agenda móvil, así que alcanza
 * partidos anteriores y futuros. Pagina por cursor con orden estable.
 */
export function createSearchMatchesHandler(search: MatchSearch): RequestHandler {
  return async (req, res, next) => {
    const params = parseSearchParams(req.query);

    if (!params) {
      next(new ValidationError());
      return;
    }

    try {
      const page = await search.search({
        query: params.text,
        kind: 'matches',
        limit: params.limit,
        cursor: params.cursor,
      });

      if (page.kind !== 'matches') {
        throw new Error('La búsqueda de partidos devolvió otro universo.');
      }

      res.status(200).json({
        matches: page.items.map(toMatchResponse),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      next(error instanceof InvalidSearchCursorError ? new ValidationError() : error);
    }
  };
}
