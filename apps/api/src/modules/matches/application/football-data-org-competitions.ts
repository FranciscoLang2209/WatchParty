import type { SyncClock, SyncFootballDataOrgClient } from './sync-matches.js';

/**
 * Competiciones del plan Free de football-data.org, con el id que llevan sus
 * partidos. Confirmado con `GET /v4/competitions` el 2026-11-10. Copa
 * Libertadores (`CLI`) queda afuera: es `TIER_FOUR`.
 */
export const FOOTBALL_DATA_ORG_FREE_COMPETITIONS: Readonly<Record<string, string>> = {
  PL: '2021',
  PD: '2014',
  CL: '2001',
  WC: '2000',
  EC: '2018',
  ELC: '2016',
  PPL: '2017',
  BL1: '2002',
  SA: '2019',
  FL1: '2015',
  DED: '2003',
  BSA: '2013',
};

/** Una competición en una temporada, tal como se la pide al proveedor. */
export interface FootballDataOrgCompetitionSeason {
  competitionCode: string;
  competitionExternalId: string;
  /** Año de inicio de la temporada, como lo entiende el proveedor. */
  season: string;
}

/**
 * Competiciones del sync diario (WAT-284), siempre con su temporada vigente.
 * Acceso a `CL`, `PD` y `SA` 2026 verificado con la cuenta del equipo el
 * 2026-11-10 (HTTP 200 con calendario). No hay torneos de selecciones: el
 * Mundial 2026 y la Eurocopa 2024 ya terminaron, y se suman acá cuando haya
 * una edición vigente con calendario accesible. Las temporadas cerradas no
 * van en esta lista: se cargan con el histórico manual (`matches:import-batch`).
 */
export const DAILY_FOOTBALL_DATA_ORG_COMPETITIONS: readonly FootballDataOrgCompetitionSeason[] = [
  { competitionCode: 'PL', competitionExternalId: '2021', season: '2026' },
  { competitionCode: 'CL', competitionExternalId: '2001', season: '2026' },
  { competitionCode: 'PD', competitionExternalId: '2014', season: '2026' },
  { competitionCode: 'SA', competitionExternalId: '2019', season: '2026' },
];

const PER_MINUTE_WINDOW_MS = 60_000;

/**
 * Cada corrida de `runSync` respeta el límite por minuto solo dentro de sí
 * misma. Cuando una ejecución encadena varias competiciones, este cliente
 * lleva la cuenta de todos los pedidos (reintentos incluidos, porque también
 * pasan por `fetchMatches`) para no superar el límite del proveedor.
 */
export function createPerMinuteThrottledClient(
  client: SyncFootballDataOrgClient,
  clock: SyncClock,
  perMinuteLimit: number,
): SyncFootballDataOrgClient {
  let timestamps: number[] = [];

  return {
    async fetchMatches(params, signal) {
      for (;;) {
        const nowMs = clock.now().getTime();
        timestamps = timestamps.filter((t) => nowMs - t < PER_MINUTE_WINDOW_MS);
        if (timestamps.length < perMinuteLimit) break;
        await clock.sleep(PER_MINUTE_WINDOW_MS - (nowMs - timestamps[0]!));
      }
      timestamps.push(clock.now().getTime());

      return client.fetchMatches(params, signal);
    },
  };
}
