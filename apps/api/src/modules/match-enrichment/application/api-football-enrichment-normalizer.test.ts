import { describe, it, expect } from 'vitest';
import type { ApiFootballFetchOutcome } from '../../matches/infrastructure/api-football-client.js';
import {
  isRetryableEnrichmentOutcome,
  normalizeFixtureGoals,
  normalizeFixtureLookup,
  normalizeFixtureStatistics,
} from './api-football-enrichment-normalizer.js';

const HOME = 9; // España
const AWAY = 10; // Inglaterra
const TEAMS = { home: HOME, away: AWAY };

function ok(response: unknown[], extra: Record<string, unknown> = {}): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status: 200,
    ok: true,
    body: { errors: [], results: response.length, response, ...extra },
    paging: undefined,
    headers: {},
  };
}

function withBody(body: unknown, status = 200): ApiFootballFetchOutcome {
  return {
    kind: 'response',
    status,
    ok: status >= 200 && status < 300,
    body,
    paging: undefined,
    headers: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Sobre de la respuesta
// ---------------------------------------------------------------------------------------------

describe('sobre de la respuesta del proveedor', () => {
  it.each([
    ['timeout', { kind: 'timeout' } as ApiFootballFetchOutcome, 'timeout'],
    ['red', { kind: 'network-error', message: 'x' } as ApiFootballFetchOutcome, 'network-error'],
    ['HTTP 429', withBody({}, 429), 'rate-limited'],
    ['HTTP 500', withBody({}, 500), 'http-error'],
    ['sin JSON', withBody(undefined), 'invalid-json'],
    ['cuerpo que no es objeto', withBody('hola'), 'invalid-response-shape'],
    ['sin response', withBody({ errors: [] }), 'invalid-response-shape'],
  ])('%s → error %s, nunca datos', (_caso, outcome, reason) => {
    expect(normalizeFixtureStatistics(outcome, TEAMS)).toEqual({ kind: 'error', reason });
    expect(normalizeFixtureGoals(outcome, TEAMS, { home: 1, away: 0 })).toEqual({
      kind: 'error',
      reason,
    });
  });

  it('un HTTP 200 con `errors` del plan es un rechazo con el mensaje del proveedor', () => {
    const outcome = withBody({
      errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' },
      response: [],
    });

    expect(normalizeFixtureStatistics(outcome, TEAMS)).toEqual({
      kind: 'error',
      reason: 'provider-errors',
      providerMessage: 'Free plans do not have access to this season, try from 2022 to 2024.',
    });
  });

  it('un 200 con `errors.rate` es un límite de pedidos y se puede reintentar', () => {
    const limitado = withBody({ errors: { rate: 'Too many requests.' }, response: [] });
    const rechazoDelPlan = withBody({ errors: { plan: 'sin acceso' }, response: [] });

    expect(isRetryableEnrichmentOutcome(limitado)).toBe(true);
    expect(isRetryableEnrichmentOutcome({ kind: 'timeout' })).toBe(true);
    expect(isRetryableEnrichmentOutcome(withBody({}, 429))).toBe(true);
    expect(isRetryableEnrichmentOutcome(rechazoDelPlan)).toBe(false);
    expect(isRetryableEnrichmentOutcome(withBody({}, 500))).toBe(false);
    expect(isRetryableEnrichmentOutcome({ kind: 'network-error', message: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

function fixtureItem(overrides: Record<string, unknown> = {}) {
  return {
    fixture: { id: 1145512, date: '2024-07-14T19:00:00+00:00', status: { short: 'FT' } },
    league: { id: 4, name: 'Euro Championship', season: 2024 },
    teams: { home: { id: HOME, name: 'Spain' }, away: { id: AWAY, name: 'England' } },
    goals: { home: 2, away: 1 },
    ...overrides,
  };
}

describe('normalizeFixtureLookup', () => {
  it('lee fixture, liga, temporada, equipos, estado y goles', () => {
    expect(normalizeFixtureLookup(ok([fixtureItem()]))).toEqual({
      kind: 'ok',
      fixture: {
        fixtureId: 1145512,
        kickoffAt: '2024-07-14T19:00:00.000Z',
        leagueId: 4,
        leagueName: 'Euro Championship',
        season: 2024,
        statusShort: 'FT',
        home: { id: HOME, name: 'Spain' },
        away: { id: AWAY, name: 'England' },
        goals: { home: 2, away: 1 },
        embeddedStatistics: null,
        embeddedEvents: null,
      },
    });
  });

  it('lee las estadísticas y los eventos embebidos cuando el fixture los trae', () => {
    const result = normalizeFixtureLookup(
      ok([
        fixtureItem({
          statistics: [{ team: { id: HOME }, statistics: [] }],
          events: [{ type: 'Goal' }],
        }),
      ]),
    );

    expect(result).toMatchObject({
      kind: 'ok',
      fixture: {
        embeddedStatistics: [{ team: { id: HOME }, statistics: [] }],
        embeddedEvents: [{ type: 'Goal' }],
      },
    });
  });

  it('si `statistics` o `events` no son listas, se toman como no embebidos', () => {
    const result = normalizeFixtureLookup(ok([fixtureItem({ statistics: {}, events: 'no' })]));

    expect(result).toMatchObject({
      kind: 'ok',
      fixture: { embeddedStatistics: null, embeddedEvents: null },
    });
  });

  it('sin goles informados deja `goals` en null (no inventa 0–0)', () => {
    const result = normalizeFixtureLookup(ok([fixtureItem({ goals: { home: null, away: null } })]));

    expect(result).toMatchObject({ kind: 'ok', fixture: { goals: null } });
  });

  it('un fixture inexistente es `not-found`', () => {
    expect(normalizeFixtureLookup(ok([]))).toEqual({ kind: 'not-found' });
  });

  it('más de un fixture para el id es ambiguo: error, no se elige uno', () => {
    expect(normalizeFixtureLookup(ok([fixtureItem(), fixtureItem()]))).toEqual({
      kind: 'error',
      reason: 'invalid-response-shape',
    });
  });

  it.each([
    ['fecha inválida', { fixture: { id: 1, date: '2024-7-14', status: { short: 'FT' } } }],
    ['sin liga', { league: {} }],
    ['sin equipo local', { teams: { away: { id: AWAY, name: 'England' } } }],
    ['sin estado', { fixture: { id: 1, date: '2024-07-14T19:00:00+00:00' } }],
  ])('%s → forma inesperada', (_caso, override) => {
    expect(normalizeFixtureLookup(ok([fixtureItem(override)]))).toEqual({
      kind: 'error',
      reason: 'invalid-response-shape',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Estadísticas
// ---------------------------------------------------------------------------------------------

function teamStats(teamId: number, values: Record<string, unknown>) {
  return {
    team: { id: teamId, name: 'x' },
    statistics: Object.entries(values).map(([type, value]) => ({ type, value })),
  };
}

const FULL_HOME = {
  'Ball Possession': '58%',
  'Total Shots': 15,
  'Shots on Goal': 7,
  'Corner Kicks': 6,
  Fouls: 11,
  'Yellow Cards': 3,
};
const FULL_AWAY = {
  'Ball Possession': '42%',
  'Total Shots': 9,
  'Shots on Goal': 3,
  'Corner Kicks': 2,
  Fouls: 14,
};

describe('normalizeFixtureStatistics', () => {
  it('con los dos equipos y las cinco métricas la cobertura es completa', () => {
    const result = normalizeFixtureStatistics(
      ok([teamStats(HOME, FULL_HOME), teamStats(AWAY, FULL_AWAY)]),
      TEAMS,
    );

    expect(result).toEqual({
      kind: 'ok',
      discarded: [],
      statistics: {
        coverage: 'complete',
        home: { possessionPct: 58, totalShots: 15, shotsOnGoal: 7, cornerKicks: 6, fouls: 11 },
        away: { possessionPct: 42, totalShots: 9, shotsOnGoal: 3, cornerKicks: 2, fouls: 14 },
      },
    });
  });

  it('asigna local/visitante por el id del equipo, no por el orden de la respuesta', () => {
    const result = normalizeFixtureStatistics(
      ok([teamStats(AWAY, FULL_AWAY), teamStats(HOME, FULL_HOME)]),
      TEAMS,
    );

    expect(result).toMatchObject({
      kind: 'ok',
      statistics: { home: { totalShots: 15 }, away: { totalShots: 9 } },
    });
  });

  it('un cero real se conserva como 0 (córners 0 no es «sin dato»)', () => {
    const result = normalizeFixtureStatistics(
      ok([
        teamStats(HOME, { ...FULL_HOME, 'Corner Kicks': 0, 'Shots on Goal': 0 }),
        teamStats(AWAY, FULL_AWAY),
      ]),
      TEAMS,
    );

    expect(result).toMatchObject({
      kind: 'ok',
      statistics: { coverage: 'complete', home: { cornerKicks: 0, shotsOnGoal: 0 } },
    });
  });

  it('una métrica con valor null o ausente queda null y la cobertura es parcial (nunca 0)', () => {
    // Sin la clave «Fouls»: la faltante es una métrica ausente, no un cero.
    const sinFaltas = Object.fromEntries(
      Object.entries(FULL_HOME).filter(([tipo]) => tipo !== 'Fouls'),
    );
    const result = normalizeFixtureStatistics(
      ok([teamStats(HOME, { ...sinFaltas, 'Corner Kicks': null }), teamStats(AWAY, FULL_AWAY)]),
      TEAMS,
    );

    expect(result).toMatchObject({
      kind: 'ok',
      statistics: {
        coverage: 'partial',
        home: { cornerKicks: null, fouls: null, totalShots: 15 },
      },
    });
  });

  it('con un solo equipo informado, el otro queda sin dato y la cobertura es parcial', () => {
    const result = normalizeFixtureStatistics(ok([teamStats(HOME, FULL_HOME)]), TEAMS);

    expect(result).toMatchObject({
      kind: 'ok',
      statistics: {
        coverage: 'partial',
        away: {
          possessionPct: null,
          totalShots: null,
          shotsOnGoal: null,
          cornerKicks: null,
          fouls: null,
        },
      },
    });
  });

  it('una respuesta vacía no tiene cobertura: no son estadísticas en cero', () => {
    expect(normalizeFixtureStatistics(ok([]), TEAMS)).toEqual({ kind: 'unavailable' });
  });

  it('equipos con todas las métricas en null tampoco tienen cobertura', () => {
    const vacio = { 'Ball Possession': null, 'Total Shots': null };

    expect(
      normalizeFixtureStatistics(ok([teamStats(HOME, vacio), teamStats(AWAY, vacio)]), TEAMS),
    ).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['posesión mayor a 100', { 'Ball Possession': '140%' }, 'home.possessionPct'],
    ['posesión con otra unidad', { 'Ball Possession': '58 puntos' }, 'home.possessionPct'],
    ['remates negativos', { 'Total Shots': -3 }, 'home.totalShots'],
    ['remates decimales', { 'Total Shots': 3.5 }, 'home.totalShots'],
    ['faltas con texto', { Fouls: 'muchas' }, 'home.fouls'],
  ])('valida unidades: %s se descarta como null y se informa', (_caso, malo, campo) => {
    const result = normalizeFixtureStatistics(
      ok([teamStats(HOME, { ...FULL_HOME, ...malo }), teamStats(AWAY, FULL_AWAY)]),
      TEAMS,
    );

    expect(result).toMatchObject({ kind: 'ok', statistics: { coverage: 'partial' } });
    expect(result.kind === 'ok' && result.discarded).toContain(campo);
  });

  it('una posesión que no suma ~100 entre los dos equipos se descarta en ambos', () => {
    const result = normalizeFixtureStatistics(
      ok([
        teamStats(HOME, { ...FULL_HOME, 'Ball Possession': '70%' }),
        teamStats(AWAY, { ...FULL_AWAY, 'Ball Possession': '70%' }),
      ]),
      TEAMS,
    );

    expect(result).toMatchObject({
      kind: 'ok',
      statistics: {
        coverage: 'partial',
        home: { possessionPct: null },
        away: { possessionPct: null },
      },
    });
  });

  it('un redondeo de ±1 en la posesión (58 + 43) es válido', () => {
    const result = normalizeFixtureStatistics(
      ok([teamStats(HOME, FULL_HOME), teamStats(AWAY, { ...FULL_AWAY, 'Ball Possession': '43%' })]),
      TEAMS,
    );

    expect(result).toMatchObject({ kind: 'ok', statistics: { home: { possessionPct: 58 } } });
  });

  it('un equipo que no es ninguno de los dos del partido es error: la orientación no se garantiza', () => {
    expect(
      normalizeFixtureStatistics(
        ok([teamStats(999, FULL_HOME), teamStats(AWAY, FULL_AWAY)]),
        TEAMS,
      ),
    ).toEqual({ kind: 'error', reason: 'teams-do-not-match' });
  });

  it('el mismo equipo dos veces es error', () => {
    expect(
      normalizeFixtureStatistics(
        ok([teamStats(HOME, FULL_HOME), teamStats(HOME, FULL_AWAY)]),
        TEAMS,
      ),
    ).toEqual({ kind: 'error', reason: 'teams-do-not-match' });
  });
});

// ---------------------------------------------------------------------------------------------
// Goles
// ---------------------------------------------------------------------------------------------

function event(
  teamId: number,
  type: string,
  detail: string,
  elapsed: number,
  extra: number | null = null,
  player: string | null = 'Jugador',
  comments: string | null = null,
) {
  return {
    time: { elapsed, extra },
    team: { id: teamId, name: 'x' },
    player: { id: 1, name: player },
    type,
    detail,
    comments,
  };
}

const goal = (team: number, minute: number, extra: number | null = null, player = 'Jugador') =>
  event(team, 'Goal', 'Normal Goal', minute, extra, player);

describe('normalizeFixtureGoals', () => {
  it('una cronología que cierra con el marcador es completa y respeta minuto y añadido', () => {
    const result = normalizeFixtureGoals(
      ok([
        goal(HOME, 47, null, 'N. Williams'),
        goal(AWAY, 73, null, 'C. Palmer'),
        goal(HOME, 86, null, 'M. Oyarzabal'),
      ]),
      TEAMS,
      { home: 2, away: 1 },
    );

    expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
    expect(result.kind === 'ok' && result.goals.events).toEqual([
      { kind: 'goal', side: 'home', playerName: 'N. Williams', minute: 47, extraMinute: null },
      { kind: 'goal', side: 'away', playerName: 'C. Palmer', minute: 73, extraMinute: null },
      { kind: 'goal', side: 'home', playerName: 'M. Oyarzabal', minute: 86, extraMinute: null },
    ]);
  });

  it('guarda el minuto añadido por separado (45+2, 90+4) y ordena por minuto + añadido', () => {
    const result = normalizeFixtureGoals(
      ok([goal(AWAY, 90, 4), goal(HOME, 45, 2), goal(HOME, 45, null)]),
      TEAMS,
      { home: 2, away: 1 },
    );

    expect(
      result.kind === 'ok' && result.goals.events.map((e) => [e.minute, e.extraMinute]),
    ).toEqual([
      [45, null],
      [45, 2],
      [90, 4],
    ]);
    expect(result).toMatchObject({ goals: { coverage: 'complete' } });
  });

  it('sin autor informado deja playerName en null', () => {
    const result = normalizeFixtureGoals(
      ok([event(HOME, 'Goal', 'Normal Goal', 10, null, null)]),
      TEAMS,
      { home: 1, away: 0 },
    );

    expect(result.kind === 'ok' && result.goals.events[0]?.playerName).toBeNull();
  });

  it('un penal convertido en el juego es un gol del juego', () => {
    const result = normalizeFixtureGoals(ok([event(HOME, 'Goal', 'Penalty', 30)]), TEAMS, {
      home: 1,
      away: 0,
    });

    expect(result.kind === 'ok' && result.goals.events[0]?.kind).toBe('penalty_goal');
    expect(result).toMatchObject({ goals: { coverage: 'complete' } });
  });

  it('un penal errado no es un gol', () => {
    const result = normalizeFixtureGoals(
      ok([event(HOME, 'Goal', 'Missed Penalty', 30), goal(AWAY, 50)]),
      TEAMS,
      { home: 0, away: 1 },
    );

    expect(result).toMatchObject({ goals: { coverage: 'complete' } });
    expect(result.kind === 'ok' && result.goals.events).toHaveLength(1);
  });

  it('un 0–0 confirmado por el marcador es una cronología vacía COMPLETA (cero real)', () => {
    expect(normalizeFixtureGoals(ok([]), TEAMS, { home: 0, away: 0 })).toMatchObject({
      kind: 'ok',
      goals: { coverage: 'complete', events: [] },
    });
  });

  it('sin eventos pero con goles en el marcador no hay cobertura: no se muestra como lista vacía', () => {
    expect(normalizeFixtureGoals(ok([]), TEAMS, { home: 2, away: 1 })).toEqual({
      kind: 'unavailable',
    });
  });

  it('sin eventos y sin marcador tampoco se puede afirmar que no hubo goles', () => {
    expect(normalizeFixtureGoals(ok([]), TEAMS, null)).toEqual({ kind: 'unavailable' });
  });

  it('una lista parcial (falta un gol) se marca incompleta, nunca completa', () => {
    const result = normalizeFixtureGoals(ok([goal(HOME, 47), goal(AWAY, 73)]), TEAMS, {
      home: 2,
      away: 1,
    });

    expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'incomplete' } });
    expect(result.kind === 'ok' && result.reconciliation).toContain('no coincide');
  });

  it('con goles pero sin marcador para comprobarlos queda incompleta', () => {
    const result = normalizeFixtureGoals(ok([goal(HOME, 47)]), TEAMS, null);

    expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'incomplete' } });
  });

  it('un evento de gol mal formado impide declarar la cronología completa', () => {
    const roto = { ...goal(HOME, 10), time: { elapsed: 'x', extra: null } };
    const result = normalizeFixtureGoals(ok([roto, goal(HOME, 20)]), TEAMS, { home: 1, away: 0 });

    expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'incomplete' } });
  });

  it('ignora tarjetas y sustituciones', () => {
    const result = normalizeFixtureGoals(
      ok([
        event(HOME, 'Card', 'Yellow Card', 5),
        event(HOME, 'subst', 'Substitution 1', 60),
        goal(HOME, 70),
      ]),
      TEAMS,
      { home: 1, away: 0 },
    );

    expect(result).toMatchObject({ goals: { coverage: 'complete' } });
    expect(result.kind === 'ok' && result.goals.events).toHaveLength(1);
  });

  describe('gol en contra', () => {
    // El proveedor no aclara si el evento trae el equipo del autor o el beneficiado: se prueba
    // contra el marcador en vez de suponerlo.
    it('si el evento trae el equipo del autor, se acredita al rival', () => {
      const result = normalizeFixtureGoals(
        ok([event(AWAY, 'Goal', 'Own Goal', 55, null, 'Defensor inglés')]),
        TEAMS,
        { home: 1, away: 0 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.goals.events[0]).toMatchObject({
        kind: 'own_goal',
        side: 'home',
      });
    });

    it('si el evento ya trae el equipo beneficiado, se acredita a ese', () => {
      const result = normalizeFixtureGoals(ok([event(HOME, 'Goal', 'Own Goal', 55)]), TEAMS, {
        home: 1,
        away: 0,
      });

      expect(result).toMatchObject({ goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.goals.events[0]?.side).toBe('home');
    });

    it('si las dos lecturas cierran con atribuciones distintas se marca incompleta', () => {
      // 1–1: un gol en contra por lado; cualquier lectura cierra, pero la atribución es ambigua.
      const result = normalizeFixtureGoals(
        ok([event(HOME, 'Goal', 'Own Goal', 20), goal(HOME, 60)]),
        TEAMS,
        { home: 1, away: 1 },
      );

      // «autor = HOME» acredita a AWAY y HOME tiene 1 más del segundo evento → 1–1;
      // «beneficiado = HOME» daría 2–0, que no cierra: sin ambigüedad.
      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });

      const ambiguo = normalizeFixtureGoals(
        ok([event(HOME, 'Goal', 'Own Goal', 20), event(AWAY, 'Goal', 'Own Goal', 60)]),
        TEAMS,
        { home: 1, away: 1 },
      );

      expect(ambiguo).toMatchObject({ kind: 'ok', goals: { coverage: 'incomplete' } });
      expect(ambiguo.kind === 'ok' && ambiguo.reconciliation).toContain('ambigua');
    });
  });

  describe('anulaciones', () => {
    it('una anulación suelta (sin el gol listado) se muestra aparte y no suma al marcador', () => {
      const result = normalizeFixtureGoals(
        ok([goal(HOME, 30), event(AWAY, 'Var', 'Goal Disallowed - offside', 65)]),
        TEAMS,
        { home: 1, away: 0 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.goals.events.map((e) => e.kind)).toEqual([
        'goal',
        'goal_cancelled',
      ]);
    });

    it('un gol que el proveedor dejó listado y luego anuló se corrige: pasa a anulado', () => {
      // El marcador final es 1–0; el proveedor lista dos goles locales y anula el del 60'.
      const result = normalizeFixtureGoals(
        ok([goal(HOME, 30), goal(HOME, 60), event(HOME, 'Var', 'Goal cancelled', 60)]),
        TEAMS,
        { home: 1, away: 0 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.goals.events).toEqual([
        { kind: 'goal', side: 'home', playerName: 'Jugador', minute: 30, extraMinute: null },
        {
          kind: 'goal_cancelled',
          side: 'home',
          playerName: 'Jugador',
          minute: 60,
          extraMinute: null,
        },
      ]);
      expect(result.kind === 'ok' && result.reconciliation).toContain('anulaciones emparejadas');
    });

    it('dos anulaciones del mismo equipo y minuto con un solo gol listado: ninguna desaparece', () => {
      // Marcador 1–0 (el gol del 30'). El proveedor lista otro gol local al 60' y lo anula DOS veces.
      const result = normalizeFixtureGoals(
        ok([
          goal(HOME, 30),
          goal(HOME, 60),
          event(HOME, 'Var', 'Goal cancelled', 60),
          event(HOME, 'Var', 'Goal Disallowed - offside', 60),
        ]),
        TEAMS,
        { home: 1, away: 0 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      // El gol del 30' y DOS anulaciones al 60': la que consumió el gol listado y la otra.
      expect(result.kind === 'ok' && result.goals.events.map((e) => e.kind)).toEqual([
        'goal',
        'goal_cancelled',
        'goal_cancelled',
      ]);
    });

    it('si la lectura literal ya cierra con el marcador no se reinterpreta nada', () => {
      const result = normalizeFixtureGoals(
        ok([goal(HOME, 30), event(HOME, 'Var', 'Goal cancelled', 60)]),
        TEAMS,
        { home: 1, away: 0 },
      );

      expect(result.kind === 'ok' && result.goals.events.map((e) => e.kind)).toEqual([
        'goal',
        'goal_cancelled',
      ]);
    });
  });

  describe('tanda de penales', () => {
    const shootout = (team: number, minute = 120) =>
      event(team, 'Goal', 'Penalty', minute, null, 'Penalista', 'Penalty Shootout');

    it('los penales de la tanda van aparte y no cuentan como goles del juego', () => {
      const result = normalizeFixtureGoals(
        ok([goal(HOME, 10), goal(AWAY, 80), shootout(HOME), shootout(AWAY), shootout(HOME)]),
        TEAMS,
        { home: 1, away: 1 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.goals.events.map((e) => e.kind)).toEqual([
        'goal',
        'goal',
        'shootout_goal',
        'shootout_goal',
        'shootout_goal',
      ]);
    });

    it('si el marcador del partido ya incluye la tanda también se concilia', () => {
      // 0–0 en el juego y 3–1 en la tanda; el proveedor del marcador informó 3–1.
      const result = normalizeFixtureGoals(
        ok([shootout(HOME), shootout(HOME), shootout(AWAY), shootout(HOME)]),
        TEAMS,
        { home: 3, away: 1 },
      );

      expect(result).toMatchObject({ kind: 'ok', goals: { coverage: 'complete' } });
      expect(result.kind === 'ok' && result.reconciliation).toContain('tanda de penales');
    });

    it('un partido definido por penales con 0–0 en el marcador del juego es completo', () => {
      const result = normalizeFixtureGoals(ok([shootout(HOME), shootout(AWAY)]), TEAMS, {
        home: 0,
        away: 0,
      });

      expect(result).toMatchObject({ goals: { coverage: 'complete' } });
    });
  });

  it('un evento de un equipo que no es del partido es error', () => {
    expect(normalizeFixtureGoals(ok([goal(999, 10)]), TEAMS, { home: 1, away: 0 })).toEqual({
      kind: 'error',
      reason: 'teams-do-not-match',
    });
  });
});
