import type { EnrichmentMatchRef } from '../domain/match-enrichment.js';
import { FOOTBALL_DATA_ORG_PROVIDER } from '../../matches/application/football-data-org-normalizer.js';
import type { FixtureInfo } from './api-football-enrichment-normalizer.js';

/**
 * Verificación de una correspondencia `matchId interno ↔ fixtureId de API-Football`.
 *
 * Los ids externos NO son comunes entre proveedores y los nombres solos no alcanzan: la
 * correspondencia la declara el manifiesto aprobado, y acá se comprueba que el fixture sea de
 * verdad ese partido (competición, fecha/hora UTC, equipos y su orientación local/visitante,
 * estado y, cuando es comparable, el marcador). Ante cualquier duda se rechaza y se reporta para
 * revisión: nunca se enriquece un partido por «parecido».
 */

/**
 * Id de la competición en football-data.org (el que guardan nuestros `matches`) → id de la liga en
 * API-Football. Es la única equivalencia que se acepta: una competición fuera de la tabla se
 * rechaza. La temporada NO se deduce del `season` de football-data.org (es un identificador
 * opaco): la edición queda determinada por la fecha del partido.
 */
export const API_FOOTBALL_LEAGUE_BY_FOOTBALL_DATA_COMPETITION: Readonly<Record<string, number>> = {
  '2021': 39, // Premier League
  '2014': 140, // La Liga
  '2001': 2, // UEFA Champions League
  '2000': 1, // Copa del Mundo
  '2018': 4, // Eurocopa
  '2016': 40, // Championship
  '2017': 94, // Primeira Liga
  '2002': 78, // Bundesliga
  '2019': 135, // Serie A
  '2015': 61, // Ligue 1
  '2003': 88, // Eredivisie
  '2013': 71, // Brasileirão Série A
};

/** Diferencia máxima, en minutos, entre el inicio de ambos proveedores. Más que eso es otro partido o una reprogramación. */
export const KICKOFF_TOLERANCE_MINUTES = 30;

/** Estados del proveedor que significan «partido terminado» (tiempo regular, prórroga, penales). */
const FINISHED_FIXTURE_STATUSES: ReadonlySet<string> = new Set(['FT', 'AET', 'PEN']);

export type RejectionCode =
  | 'proveedor-no-soportado'
  | 'partido-no-finalizado'
  | 'fixture-no-finalizado'
  | 'competicion-sin-equivalente'
  | 'competicion-distinta'
  | 'fecha-distinta'
  | 'orientacion-invertida'
  | 'equipos-distintos'
  | 'marcador-distinto';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export type CorrespondenceVerdict =
  { accepted: true; notes: string[] } | { accepted: false; rejections: Rejection[] };

// Palabras que los proveedores agregan o quitan al nombre de un club sin que sea otro equipo.
const NAME_NOISE: ReadonlySet<string> = new Set([
  'fc',
  'cf',
  'afc',
  'sc',
  'ac',
  'as',
  'ssc',
  'cd',
  'ud',
  'fk',
  'sk',
  'rc',
  'sv',
  'vfb',
  'vfl',
  'club',
  'de',
  'the',
  'calcio',
  'and',
]);

function nameTokens(name: string): Set<string> {
  const tokens = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '' && !NAME_NOISE.has(token));

  return new Set(tokens);
}

/**
 * Los dos nombres son del mismo equipo si, sin acentos, mayúsculas ni sufijos habituales
 * («FC», «CF»…), uno contiene al otro por completo: «Manchester City FC» ↔ «Manchester City».
 * Que sólo compartan una palabra («Manchester City» ↔ «Manchester United») NO alcanza.
 */
export function teamNamesCompatible(a: string, b: string): boolean {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.size === 0 || right.size === 0) return false;

  const [small, large] = left.size <= right.size ? [left, right] : [right, left];

  return [...small].every((token) => large.has(token));
}

/**
 * `competitionExternalId` sólo tiene el sentido de la tabla de ligas si el partido nació en
 * football-data.org: de otro proveedor, los ids no son comparables y se rechaza explícitamente
 * (no «por casualidad» al no encontrar la liga). Se consulta antes de gastar un pedido.
 */
export function rejectUnsupportedProvider(match: EnrichmentMatchRef): Rejection | null {
  if (match.provider === FOOTBALL_DATA_ORG_PROVIDER) return null;

  return {
    code: 'proveedor-no-soportado',
    message: `el partido interno viene de «${match.provider}» y sólo se enriquecen los de «${FOOTBALL_DATA_ORG_PROVIDER}»`,
  };
}

export function verifyCorrespondence(
  match: EnrichmentMatchRef,
  fixture: FixtureInfo,
): CorrespondenceVerdict {
  const rejections: Rejection[] = [];
  const notes: string[] = [];
  const reject = (code: RejectionCode, message: string) => rejections.push({ code, message });

  const unsupported = rejectUnsupportedProvider(match);
  if (unsupported) rejections.push(unsupported);

  if (match.status !== 'finished') {
    reject('partido-no-finalizado', `el partido interno no está finalizado (${match.status})`);
  }

  if (!FINISHED_FIXTURE_STATUSES.has(fixture.statusShort)) {
    reject('fixture-no-finalizado', `el fixture del proveedor no terminó (${fixture.statusShort})`);
  }

  const expectedLeague = Object.hasOwn(
    API_FOOTBALL_LEAGUE_BY_FOOTBALL_DATA_COMPETITION,
    match.competitionExternalId,
  )
    ? API_FOOTBALL_LEAGUE_BY_FOOTBALL_DATA_COMPETITION[match.competitionExternalId]
    : undefined;

  if (expectedLeague === undefined) {
    reject(
      'competicion-sin-equivalente',
      `la competición ${match.competitionExternalId} no tiene equivalente conocido en el proveedor`,
    );
  } else if (expectedLeague !== fixture.leagueId) {
    reject(
      'competicion-distinta',
      `el fixture es de la liga ${fixture.leagueId} y se esperaba la ${expectedLeague}`,
    );
  }

  const differenceMinutes =
    Math.abs(Date.parse(match.kickoffAt) - Date.parse(fixture.kickoffAt)) / 60_000;
  if (!(differenceMinutes <= KICKOFF_TOLERANCE_MINUTES)) {
    reject(
      'fecha-distinta',
      `los inicios difieren ${Math.round(differenceMinutes)} min (${match.kickoffAt} vs ${fixture.kickoffAt}): posible reprogramación o partido distinto`,
    );
  }

  const sameOrientation =
    teamNamesCompatible(match.homeTeamName, fixture.home.name) &&
    teamNamesCompatible(match.awayTeamName, fixture.away.name);
  const swapped =
    teamNamesCompatible(match.homeTeamName, fixture.away.name) &&
    teamNamesCompatible(match.awayTeamName, fixture.home.name);

  if (!sameOrientation) {
    if (swapped) {
      reject(
        'orientacion-invertida',
        `local y visitante están invertidos (${match.homeTeamName} vs ${match.awayTeamName} contra ${fixture.home.name} vs ${fixture.away.name})`,
      );
    } else {
      reject(
        'equipos-distintos',
        `los equipos no coinciden (${match.homeTeamName} vs ${match.awayTeamName} contra ${fixture.home.name} vs ${fixture.away.name})`,
      );
    }
  }

  // Tras una tanda de penales, los proveedores no coinciden en si el marcador la incluye: ahí no
  // es una comparación confiable y no se usa para rechazar.
  if (fixture.statusShort === 'PEN') {
    notes.push('marcador no comparado: el partido se definió por penales');
  } else if (match.score !== null && fixture.goals !== null) {
    if (match.score.home !== fixture.goals.home || match.score.away !== fixture.goals.away) {
      reject(
        'marcador-distinto',
        `el marcador es ${match.score.home}–${match.score.away} y el proveedor informa ${fixture.goals.home}–${fixture.goals.away}`,
      );
    }
  } else {
    notes.push('marcador no comparado: uno de los dos no lo informa');
  }

  return rejections.length > 0 ? { accepted: false, rejections } : { accepted: true, notes };
}
