import type { MatchStatus } from './match.js';

/**
 * Referencia a un equipo dentro de un fixture normalizado: solo lo mínimo
 * que un `MatchStore` necesita para upsertear la fila en `teams`.
 */
export interface NormalizedFixtureTeam {
  externalId: string;
  name: string;
}

/**
 * DTO interno de fixture normalizado, de entrada al `MatchStore`.
 *
 * Es deliberadamente distinto de `NormalizedSportsFixture` (WAT-105, en
 * `application/normalized-sports-fixture.ts`): ese DTO es específico de la
 * forma de respuesta de API-Football (IDs numéricos, liga con nombre y id
 * separados). Este DTO habla el idioma de las tablas `teams`/`matches`
 * (WAT-103): IDs externos como texto, `competitionExternalId` y `season`
 * como los espera la base, y reutiliza `MatchStatus` del dominio en vez de
 * declarar otro enum de estados, porque los valores ya coinciden 1 a 1 con
 * el CHECK de la columna `matches.status`.
 *
 * Que sea un tipo separado mantiene bajo acoplamiento: WAT-107 (u otro
 * proveedor futuro) traduce su propia forma normalizada a este DTO antes de
 * llamar a `MatchStore.upsertFixture`, y este módulo nunca necesita conocer
 * la forma de ningún proveedor externo. No reemplaza ni modifica el
 * contrato público `Match`.
 */
export interface NormalizedMatchFixture {
  provider: string;
  externalId: string;
  homeTeam: NormalizedFixtureTeam;
  awayTeam: NormalizedFixtureTeam;
  competitionExternalId: string;
  season: string;
  /** Fecha y hora de inicio en formato ISO 8601 UTC, p. ej. "2026-09-06T21:00:00Z". */
  kickoffAt: string;
  status: MatchStatus;
}
