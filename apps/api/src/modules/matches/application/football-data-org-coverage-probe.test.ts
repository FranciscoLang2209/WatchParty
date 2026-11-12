import { describe, expect, it } from 'vitest';
import type { FootballDataOrgFetchOutcome } from '../infrastructure/football-data-org-client.js';
import {
  formatCoverageProbe,
  isNationalTeamCompetition,
  isWithinPlan,
  selectNationalTeamCompetitions,
  summarizeMatchesProbe,
  type CompetitionProbeRow,
} from './football-data-org-coverage-probe.js';

const competition = (
  code: string,
  name: string,
  plan: string,
  currentSeason: { startDate: string; endDate: string } | null = null,
  area = 'World',
) => ({ code, name, plan, area: { name: area }, currentSeason });

const listado = {
  competitions: [
    competition('PL', 'Premier League', 'TIER_ONE', null, 'England'),
    competition('CL', 'UEFA Champions League', 'TIER_ONE', null, 'Europe'),
    competition('WC', 'FIFA World Cup', 'TIER_ONE', {
      startDate: '2026-06-11',
      endDate: '2026-07-19',
    }),
    competition(
      'EC',
      'European Championship',
      'TIER_ONE',
      { startDate: '2024-06-14', endDate: '2024-07-14' },
      'Europe',
    ),
    competition('UNL', 'UEFA Nations League', 'TIER_FOUR', null, 'Europe'),
    competition('WCQE', 'WC Qualification UEFA', 'TIER_FOUR', null, 'Europe'),
    competition('WWC', "FIFA Women's World Cup", 'TIER_FOUR'),
    competition('CWC', 'FIFA Club World Cup', 'TIER_FOUR'),
    { code: null, name: 'Sin código World Cup', plan: 'TIER_ONE' },
  ],
};

describe('isNationalTeamCompetition', () => {
  it.each([
    'FIFA World Cup',
    'European Championship',
    'UEFA Nations League',
    'WC Qualification CONMEBOL',
    'European Championship Qualifiers',
    'Copa America',
    'Africa Cup Of Nations - Qualification',
    'International Friendlies',
  ])('%s es de selecciones', (name) => {
    expect(isNationalTeamCompetition(name)).toBe(true);
  });

  it.each([
    'Premier League',
    'UEFA Champions League',
    'Champions League Qualification',
    'Conference League Qualification',
    "FIFA Women's World Cup",
    'FIFA Club World Cup',
    'UEFA Super Cup',
    'Summer Olympics',
  ])('%s no es de selecciones masculinas', (name) => {
    expect(isNationalTeamCompetition(name)).toBe(false);
  });
});

describe('selectNationalTeamCompetitions', () => {
  it('deja sólo los torneos de selecciones, con su plan y temporada, ordenados por código', () => {
    expect(selectNationalTeamCompetitions(listado)).toEqual([
      {
        code: 'EC',
        name: 'European Championship',
        area: 'Europe',
        plan: 'TIER_ONE',
        currentSeason: { startDate: '2024-06-14', endDate: '2024-07-14' },
      },
      {
        code: 'UNL',
        name: 'UEFA Nations League',
        area: 'Europe',
        plan: 'TIER_FOUR',
        currentSeason: null,
      },
      {
        code: 'WC',
        name: 'FIFA World Cup',
        area: 'World',
        plan: 'TIER_ONE',
        currentSeason: { startDate: '2026-06-11', endDate: '2026-07-19' },
      },
      {
        code: 'WCQE',
        name: 'WC Qualification UEFA',
        area: 'Europe',
        plan: 'TIER_FOUR',
        currentSeason: null,
      },
    ]);
  });

  it.each([null, undefined, 'texto', {}, { competitions: 'no' }, { competitions: [null, 3] }])(
    'una respuesta inesperada (%j) da una lista vacía en vez de romper',
    (body) => {
      expect(selectNationalTeamCompetitions(body)).toEqual([]);
    },
  );
});

describe('isWithinPlan', () => {
  it('un plan alcanza lo de su nivel y lo inferior, no lo superior', () => {
    expect(isWithinPlan('TIER_ONE', 'TIER_ONE')).toBe(true);
    expect(isWithinPlan('TIER_ONE', 'TIER_FOUR')).toBe(true);
    expect(isWithinPlan('TIER_FOUR', 'TIER_ONE')).toBe(false);
    expect(isWithinPlan('TIER_TWO', 'TIER_ONE')).toBe(false);
  });

  it('un plan desconocido no se da por alcanzado', () => {
    expect(isWithinPlan('desconocido', 'TIER_ONE')).toBe(false);
    expect(isWithinPlan('TIER_ONE', 'otro')).toBe(false);
  });
});

describe('summarizeMatchesProbe', () => {
  const respuesta = (status: number, body: unknown): FootballDataOrgFetchOutcome => ({
    kind: 'response',
    status,
    ok: status >= 200 && status < 300,
    body,
    headers: { 'x-authenticated-client': 'dato-de-la-cuenta', 'x-requests-available-minute': '9' },
  });

  it('cuenta los partidos y da el primero y el último', () => {
    const resumen = summarizeMatchesProbe(
      respuesta(200, {
        matches: [
          { utcDate: '2026-11-14T19:45:00Z' },
          { utcDate: '2026-11-13T17:00:00Z' },
          { utcDate: '2026-11-16T19:45:00Z' },
        ],
      }),
    );

    expect(resumen).toEqual({
      result: 'ok',
      status: 200,
      matchCount: 3,
      firstUtcDate: '2026-11-13T17:00:00Z',
      lastUtcDate: '2026-11-16T19:45:00Z',
      providerMessage: null,
    });
  });

  it('una ventana sin partidos es un 200 con cero, no un error', () => {
    expect(summarizeMatchesProbe(respuesta(200, { matches: [] }))).toMatchObject({
      result: 'ok',
      matchCount: 0,
      firstUtcDate: null,
    });
  });

  it('una restricción del plan se informa como rechazo, con el mensaje recortado', () => {
    const largo = 'Your subscription does not include this competition. '.repeat(10);
    const resumen = summarizeMatchesProbe(respuesta(403, { message: largo, errorCode: 403 }));

    expect(resumen.result).toBe('rechazado');
    expect(resumen.status).toBe(403);
    expect(resumen.matchCount).toBeNull();
    expect(resumen.providerMessage).toHaveLength(160);
  });

  it('un tiempo de espera o un fallo de red no se confunden con cero partidos', () => {
    expect(summarizeMatchesProbe({ kind: 'timeout' })).toMatchObject({
      result: 'timeout',
      matchCount: null,
    });
    expect(
      summarizeMatchesProbe({
        kind: 'network-error',
        message: 'getaddrinfo ENOTFOUND con-detalle',
      }),
    ).toMatchObject({ result: 'error-de-red', matchCount: null, providerMessage: null });
  });

  it('no copia encabezados de la respuesta al resumen', () => {
    const resumen = JSON.stringify(summarizeMatchesProbe(respuesta(200, { matches: [] })));

    expect(resumen).not.toContain('dato-de-la-cuenta');
    expect(resumen).not.toContain('x-authenticated-client');
  });
});

describe('formatCoverageProbe', () => {
  const [ec, unl, wc] = selectNationalTeamCompetitions(listado);
  const filas: CompetitionProbeRow[] = [
    {
      competition: wc!,
      withinPlan: true,
      probe: {
        result: 'ok',
        status: 200,
        matchCount: 0,
        firstUtcDate: null,
        lastUtcDate: null,
        providerMessage: null,
      },
    },
    {
      competition: ec!,
      withinPlan: true,
      probe: {
        result: 'rechazado',
        status: 403,
        matchCount: null,
        firstUtcDate: null,
        lastUtcDate: null,
        providerMessage: 'No incluido',
      },
    },
    { competition: unl!, withinPlan: false, probe: null },
  ];
  const informe = formatCoverageProbe({
    accountPlan: 'TIER_ONE',
    dateFrom: '2026-11-11',
    dateTo: '2026-11-18',
    rows: filas,
  });

  it('indica el plan y la ventana consultados', () => {
    expect(informe).toContain('plan TIER_ONE');
    expect(informe).toContain('2026-11-11 a 2026-11-18');
  });

  it('distingue cero partidos, un rechazo y un torneo fuera del plan', () => {
    expect(informe).toContain(
      'WC | FIFA World Cup | TIER_ONE | 2026-06-11 → 2026-07-19 | HTTP 200, 0 partidos en la ventana',
    );
    expect(informe).toContain(
      'EC | European Championship | TIER_ONE | 2024-06-14 → 2024-07-14 | HTTP 403: No incluido',
    );
    expect(informe).toContain(
      'UNL | UEFA Nations League | TIER_FOUR | sin temporada vigente | fuera del plan de la cuenta (exige TIER_FOUR)',
    );
  });

  it('avisa cuando el proveedor no lista ningún torneo de selecciones', () => {
    expect(
      formatCoverageProbe({ accountPlan: 'TIER_ONE', dateFrom: 'a', dateTo: 'b', rows: [] }),
    ).toContain('no listó ningún torneo de selecciones');
  });
});
