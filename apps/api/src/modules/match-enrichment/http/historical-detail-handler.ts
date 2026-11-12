import type { RequestHandler } from 'express';
import { NotFoundError } from '../../../errors/http-error.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchEnrichmentReader } from '../domain/match-enrichment.js';
import { toHistoricalDetailResponse } from './historical-detail-response.js';

/**
 * `GET /matches/:matchId/historical-detail`. Sólo lee lo ya guardado: nunca consulta al proveedor
 * por una visita. Un partido inexistente es 404; un partido existente sin enriquecer es 200 con
 * `detail: null` (no es un error: simplemente no hay datos cargados).
 */
export function createHistoricalDetailHandler(
  catalog: MatchCatalog,
  reader: MatchEnrichmentReader,
): RequestHandler<{ matchId: string }> {
  return async (req, res, next) => {
    const { matchId } = req.params;
    const match = await catalog.findById(matchId);

    if (!match) {
      next(new NotFoundError());
      return;
    }

    const detail = await reader.findHistoricalDetail(match.id);

    res.status(200).json({ detail: detail ? toHistoricalDetailResponse(detail) : null });
  };
}
