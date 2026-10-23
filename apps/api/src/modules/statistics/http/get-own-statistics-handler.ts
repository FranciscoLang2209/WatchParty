import type { RequestHandler } from 'express';
import type { UserStatisticsStore } from '../domain/user-statistics-store.js';

/**
 * Handler de `GET /me/statistics` (WAT-232): los tres totales de actividad
 * propia (WAT-231).
 *
 * - La identidad sale SOLO de `req.user`: no hay parámetro para pedir los
 *   totales de otro usuario, y uno en la query se ignora.
 * - Sin actividad responde ceros; un fallo de persistencia llega al error
 *   handler como 500 genérico, nunca como ceros.
 */
export function createGetOwnStatisticsHandler(store: UserStatisticsStore): RequestHandler {
  return async (req, res) => {
    const statistics = await store.getUserStatistics(req.user!.id);

    res.status(200).json({ statistics });
  };
}
