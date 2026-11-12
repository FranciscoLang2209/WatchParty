import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API_BASE = 'https://api.watchparty.test';

vi.mock('@/lib/env', () => ({
  readWebEnv: () => ({
    supabaseUrl: 'https://supabase.test',
    supabaseAnonKey: 'anon',
    apiBaseUrl: API_BASE,
  }),
}));

const { getHistoricalDetail, parseHistoricalDetail } = await import('./api');
const { MatchHistoricalDetail } = await import('./MatchHistoricalDetail');
const { formatGoalMinute, formatMetric, formatPossession, latestFetchedAt } =
  await import('./historical-format');

const MATCH = { id: 'match-001', homeTeam: 'España', awayTeam: 'Inglaterra' };

const STATS = {
  coverage: 'complete',
  fetchedAt: '2026-11-12T15:00:00.000Z',
  home: { possessionPct: 58, totalShots: 15, shotsOnGoal: 7, cornerKicks: 6, fouls: 11 },
  away: { possessionPct: 42, totalShots: 9, shotsOnGoal: 3, cornerKicks: 0, fouls: 14 },
};

const goal = (over: Record<string, unknown> = {}) => ({
  kind: 'goal',
  side: 'home',
  playerName: 'N. Williams',
  minute: 47,
  extraMinute: null,
  ...over,
});

const GOALS = {
  coverage: 'complete',
  fetchedAt: '2026-11-12T15:00:01.000Z',
  goals: [
    goal(),
    goal({ side: 'away', playerName: 'C. Palmer', minute: 73 }),
    goal({ playerName: 'M. Oyarzabal', minute: 90, extraMinute: 4 }),
  ],
  cancelled: [],
  shootout: [],
};

function detalle(over: Record<string, unknown> = {}) {
  return { source: 'api-football', historical: true, statistics: STATS, goals: GOALS, ...over };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function responder(body: unknown, status = 200) {
  fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

function mostrar(onSessionExpired = vi.fn()) {
  render(
    <MatchHistoricalDetail
      match={MATCH}
      accessToken="token-123"
      onSessionExpired={onSessionExpired}
    />,
  );

  return onSessionExpired;
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------------------------

describe('parseHistoricalDetail', () => {
  it('acepta un detalle completo y descarta los campos extra', () => {
    const parsed = parseHistoricalDetail({
      ...detalle(),
      extra: 'x',
      statistics: { ...STATS, secreto: 1 },
    });

    expect(parsed).toEqual({
      source: 'api-football',
      historical: true,
      statistics: STATS,
      goals: GOALS,
    });
    expect(JSON.stringify(parsed)).not.toContain('secreto');
  });

  it('null es «sin detalle cargado» y cada parte puede ser null por separado', () => {
    expect(parseHistoricalDetail(null)).toBeNull();
    expect(parseHistoricalDetail(detalle({ statistics: null }))).toMatchObject({
      statistics: null,
    });
    expect(parseHistoricalDetail(detalle({ goals: null }))).toMatchObject({ goals: null });
  });

  it('conserva la diferencia entre 0 (dato real) y null (sin dato)', () => {
    const parsed = parseHistoricalDetail(
      detalle({ statistics: { ...STATS, away: { ...STATS.away, cornerKicks: 0, fouls: null } } }),
    );

    expect(parsed?.statistics?.away).toMatchObject({ cornerKicks: 0, fouls: null });
  });

  it.each([
    ['posesión mayor a 100', { possessionPct: 140 }],
    ['posesión negativa', { possessionPct: -1 }],
    ['posesión como texto', { possessionPct: '58%' }],
    ['remates negativos', { totalShots: -3 }],
    ['remates decimales', { totalShots: 3.5 }],
    ['faltas como texto', { fouls: 'muchas' }],
    ['métrica ausente (undefined)', { cornerKicks: undefined }],
  ])('rechaza %s (no se arregla convirtiéndolo en 0)', (_caso, override) => {
    expect(() =>
      parseHistoricalDetail(
        detalle({ statistics: { ...STATS, home: { ...STATS.home, ...override } } }),
      ),
    ).toThrow();
  });

  it.each([
    ['fuente distinta', { source: 'otra' }],
    ['no histórico', { historical: false }],
    ['cobertura inventada', { statistics: { ...STATS, coverage: 'total' } }],
    ['fecha de consulta inválida', { statistics: { ...STATS, fetchedAt: 'ayer' } }],
    ['lista de goles que no es lista', { goals: { ...GOALS, goals: 'no' } }],
  ])('rechaza %s', (_caso, override) => {
    expect(() => parseHistoricalDetail(detalle(override))).toThrow();
  });

  it('una lista con UN evento inválido se rechaza entera: no se muestra una cronología parcial', () => {
    expect(() =>
      parseHistoricalDetail(
        detalle({ goals: { ...GOALS, goals: [goal(), goal({ minute: -4 })] } }),
      ),
    ).toThrow();
    expect(() =>
      parseHistoricalDetail(detalle({ goals: { ...GOALS, goals: [goal({ side: 'centro' })] } })),
    ).toThrow();
  });

  it('cada lista sólo admite su tipo de evento (anulaciones y tanda no se mezclan con los goles)', () => {
    expect(() =>
      parseHistoricalDetail(
        detalle({ goals: { ...GOALS, goals: [goal({ kind: 'goal_cancelled' })] } }),
      ),
    ).toThrow();
    expect(() =>
      parseHistoricalDetail(detalle({ goals: { ...GOALS, shootout: [goal({ kind: 'goal' })] } })),
    ).toThrow();
  });
});

describe('getHistoricalDetail', () => {
  it('pide el detalle del partido con GET y bearer, y codifica el id', async () => {
    responder({ detail: detalle() });

    const result = await getHistoricalDetail('a/b c', 'token-123');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${API_BASE}/matches/a%2Fb%20c/historical-detail`);
    expect((init as RequestInit).method).toBe('GET');
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(
      'Bearer token-123',
    );
    expect(result?.statistics?.home.possessionPct).toBe(58);
  });

  it('detail: null devuelve null', async () => {
    responder({ detail: null });

    expect(await getHistoricalDetail('m', 't')).toBeNull();
  });

  it('una respuesta sin el campo detail es un error del servidor', async () => {
    responder({});

    await expect(getHistoricalDetail('m', 't')).rejects.toMatchObject({ kind: 'server' });
  });

  it.each([
    [404, 'not-found'],
    [401, 'unauthorized'],
    [500, 'server'],
  ])('HTTP %i → %s', async (status, kind) => {
    responder({}, status);

    await expect(getHistoricalDetail('m', 't')).rejects.toMatchObject({ kind });
  });

  it('un fallo de red es un error recuperable', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(getHistoricalDetail('m', 't')).rejects.toMatchObject({ kind: 'network' });
  });
});

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------

describe('formato', () => {
  it("el minuto muestra el añadido: 45+2', 90+4', 73'", () => {
    expect(formatGoalMinute(45, 2)).toBe("45+2'");
    expect(formatGoalMinute(90, 4)).toBe("90+4'");
    expect(formatGoalMinute(73, null)).toBe("73'");
    expect(formatGoalMinute(73, 0)).toBe("73'");
  });

  it('0 es un cero real y null es «Sin dato»', () => {
    expect(formatMetric(0)).toBe('0');
    expect(formatMetric(null)).toBe('Sin dato');
    expect(formatPossession(0)).toBe('0 %');
    expect(formatPossession(null)).toBe('Sin dato');
    expect(formatPossession(58)).toBe('58 %');
  });

  it('toma la consulta más reciente de las partes cargadas', () => {
    expect(latestFetchedAt('2026-11-12T15:00:00Z', undefined, '2026-11-13T10:00:00Z')).toBe(
      '2026-11-13T10:00:00Z',
    );
    expect(latestFetchedAt(undefined, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------------------------

describe('MatchHistoricalDetail — estados', () => {
  it('mientras carga muestra el estado de carga y no datos', async () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    mostrar();

    expect(await screen.findByRole('status')).toHaveTextContent('Cargando estadísticas y goles');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('un partido sin detalle cargado no muestra nada: ni tarjeta, ni ceros, ni listas vacías', async () => {
    responder({ detail: null });

    const { container } = render(
      <MatchHistoricalDetail match={MATCH} accessToken="token-123" onSessionExpired={vi.fn()} />,
    );

    // Mientras carga se ve el estado de carga; al confirmar que no hay detalle, desaparece.
    expect(screen.getByRole('status')).toHaveTextContent('Cargando estadísticas y goles');
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('un error muestra el aviso con «Reintentar» y reintentar vuelve a pedir', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, 500));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ detail: detalle() }));

    mostrar();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos cargar las estadísticas y los goles');
    expect(alerta).not.toHaveTextContent('partidos');
    // Un error no se disfraza de «sin datos» ni de ceros.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(within(alerta).getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sin conexión conserva el aviso de red y permite reintentar', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    mostrar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Revisá tu conexión');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('una respuesta con forma inválida es un error recuperable, no datos a medias', async () => {
    responder({
      detail: detalle({ statistics: { ...STATS, home: { ...STATS.home, possessionPct: 140 } } }),
    });

    mostrar();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('con la sesión vencida ofrece volver a iniciar sesión, no reintentar', async () => {
    const user = userEvent.setup();
    responder({ error: { code: 'UNAUTHORIZED' } }, 401);

    const onSessionExpired = mostrar();

    await user.click(await screen.findByRole('button', { name: 'Iniciar sesión nuevamente' }));

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('sin token no pide nada', () => {
    render(<MatchHistoricalDetail match={MATCH} accessToken={null} onSessionExpired={vi.fn()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('si el token llega después de montar, lo pide en ese momento (no queda cargando para siempre)', async () => {
    responder({ detail: detalle() });
    const onSessionExpired = vi.fn();
    const { rerender } = render(
      <MatchHistoricalDetail
        match={MATCH}
        accessToken={null}
        onSessionExpired={onSessionExpired}
      />,
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender(
      <MatchHistoricalDetail
        match={MATCH}
        accessToken="token-123"
        onSessionExpired={onSessionExpired}
      />,
    );

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('renovar el token no repite el pedido', async () => {
    responder({ detail: detalle() });
    const onSessionExpired = vi.fn();
    const { rerender } = render(
      <MatchHistoricalDetail
        match={MATCH}
        accessToken="token-1"
        onSessionExpired={onSessionExpired}
      />,
    );
    await screen.findByRole('table');

    rerender(
      <MatchHistoricalDetail
        match={MATCH}
        accessToken="token-2"
        onSessionExpired={onSessionExpired}
      />,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('hace un único pedido por partido', async () => {
    responder({ detail: detalle() });

    mostrar();
    await screen.findByRole('table');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('MatchHistoricalDetail — estadísticas', () => {
  it('muestra las métricas de local y visitante con los nombres de los equipos', async () => {
    responder({ detail: detalle() });

    mostrar();

    const tabla = await screen.findByRole('table', {
      name: 'Estadísticas del partido: España contra Inglaterra',
    });
    const filas = within(tabla).getAllByRole('row');

    // Cabecera + cinco métricas.
    expect(filas).toHaveLength(6);
    expect(within(filas[0]!).getByRole('columnheader', { name: 'España' })).toBeInTheDocument();
    expect(within(filas[0]!).getByRole('columnheader', { name: 'Inglaterra' })).toBeInTheDocument();

    const fila = (metrica: string) =>
      within(filas.find((row) => within(row).queryByRole('rowheader', { name: metrica }))!);

    expect(
      fila('Posesión')
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['58 %', '42 %']);
    expect(
      fila('Remates')
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['15', '9']);
    expect(
      fila('Remates al arco')
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['7', '3']);
    expect(
      fila('Córners')
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['6', '0']);
    expect(
      fila('Faltas')
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['11', '14']);
  });

  it('un cero real se muestra como 0 y la ausencia como «Sin dato»', async () => {
    responder({
      detail: detalle({
        statistics: {
          ...STATS,
          coverage: 'partial',
          home: { ...STATS.home, cornerKicks: 0, fouls: null },
          away: { ...STATS.away, cornerKicks: null, fouls: 0 },
        },
      }),
    });

    mostrar();

    const tabla = await screen.findByRole('table');
    const fila = (metrica: string) =>
      within(
        within(tabla)
          .getAllByRole('row')
          .find((row) => within(row).queryByRole('rowheader', { name: metrica }))!,
      )
        .getAllByRole('cell')
        .map((c) => c.textContent);

    expect(fila('Córners')).toEqual(['0', 'Sin dato']);
    expect(fila('Faltas')).toEqual(['Sin dato', '0']);
  });

  it('con cobertura parcial avisa que es restringida y que lo que falta no es cero', async () => {
    responder({
      detail: detalle({
        statistics: { ...STATS, coverage: 'partial', home: { ...STATS.home, shotsOnGoal: null } },
      }),
    });

    mostrar();

    expect(await screen.findByText(/Cobertura restringida/)).toHaveTextContent('no como cero');
  });

  it('con cobertura completa no muestra ningún aviso de cobertura', async () => {
    responder({ detail: detalle() });

    mostrar();
    await screen.findByRole('table');

    expect(screen.queryByText(/Cobertura restringida/)).not.toBeInTheDocument();
  });

  it('sin estadísticas cargadas (pero con goles) dice «Sin dato» para esa parte, sin tabla', async () => {
    responder({ detail: detalle({ statistics: null }) });

    mostrar();

    expect(
      await screen.findByText('Sin dato: todavía no se cargaron las estadísticas de este partido.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});

describe('MatchHistoricalDetail — goles', () => {
  it('lista los goles en orden con equipo, autor y minuto con añadido', async () => {
    responder({ detail: detalle() });

    mostrar();

    const lista = await screen.findByRole('list', { name: 'Goles del partido' });
    const items = within(lista).getAllByRole('listitem');

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("47'");
    expect(items[0]).toHaveTextContent('España');
    expect(items[0]).toHaveTextContent('N. Williams');
    expect(items[1]).toHaveTextContent('Inglaterra');
    expect(items[1]).toHaveTextContent('C. Palmer');
    // Minuto 90 con 4 de añadido.
    expect(items[2]).toHaveTextContent("90+4'");
  });

  it('el minuto se anuncia completo a un lector de pantalla', async () => {
    responder({
      detail: detalle({ goals: { ...GOALS, goals: [goal({ minute: 45, extraMinute: 2 })] } }),
    });

    mostrar();

    const item = within(await screen.findByRole('list', { name: 'Goles del partido' })).getByRole(
      'listitem',
    );

    expect(item).toHaveTextContent('minuto 45 más 2 de añadido');
    expect(item).toHaveTextContent("45+2'");
  });

  it('sin autor informado lo dice, en vez de dejarlo en blanco', async () => {
    responder({ detail: detalle({ goals: { ...GOALS, goals: [goal({ playerName: null })] } }) });

    mostrar();

    expect(await screen.findByText('Autor no informado')).toBeInTheDocument();
  });

  it('distingue gol en contra y gol de penal', async () => {
    responder({
      detail: detalle({
        goals: {
          ...GOALS,
          goals: [
            goal({ kind: 'own_goal', minute: 10 }),
            goal({ kind: 'penalty_goal', minute: 30 }),
          ],
        },
      }),
    });

    mostrar();

    expect(await screen.findByText('(gol en contra)')).toBeInTheDocument();
    expect(screen.getByText('(de penal)')).toBeInTheDocument();
  });

  it('un 0–0 confirmado se dice «sin goles», distinto de «sin dato»', async () => {
    responder({ detail: detalle({ goals: { ...GOALS, goals: [] } }) });

    mostrar();

    expect(await screen.findByText('El partido terminó sin goles.')).toBeInTheDocument();
    expect(
      screen.queryByText(/Sin dato: todavía no se cargó la cronología/),
    ).not.toBeInTheDocument();
  });

  it('sin cronología cargada dice «Sin dato», no «sin goles»', async () => {
    responder({ detail: detalle({ goals: null }) });

    mostrar();

    expect(
      await screen.findByText(
        'Sin dato: todavía no se cargó la cronología de goles de este partido.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('El partido terminó sin goles.')).not.toBeInTheDocument();
  });

  it('una cronología incompleta se avisa y no se presenta como completa', async () => {
    responder({
      detail: detalle({ goals: { ...GOALS, coverage: 'incomplete', goals: [goal()] } }),
    });

    mostrar();

    expect(await screen.findByText(/Cronología incompleta/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Goles registrados' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Goles del partido' })).not.toBeInTheDocument();
    expect(screen.queryByText('El partido terminó sin goles.')).not.toBeInTheDocument();
  });

  it('una cronología incompleta y vacía no dice que no hubo goles', async () => {
    responder({ detail: detalle({ goals: { ...GOALS, coverage: 'incomplete', goals: [] } }) });

    mostrar();

    expect(await screen.findByText(/Cronología incompleta/)).toBeInTheDocument();
    expect(screen.getByText('El proveedor no informó ningún gol.')).toBeInTheDocument();
    expect(screen.queryByText('El partido terminó sin goles.')).not.toBeInTheDocument();
  });

  it('separa las anulaciones y la tanda de penales de los goles del juego', async () => {
    responder({
      detail: detalle({
        goals: {
          ...GOALS,
          goals: [goal({ minute: 30 })],
          cancelled: [goal({ kind: 'goal_cancelled', side: 'away', playerName: null, minute: 65 })],
          shootout: [
            goal({ kind: 'shootout_goal', playerName: 'A. Morata', minute: 120 }),
            goal({ kind: 'shootout_goal', side: 'away', playerName: 'H. Kane', minute: 120 }),
          ],
        },
      }),
    });

    mostrar();

    const juego = await screen.findByRole('list', { name: 'Goles del partido' });
    const anulados = screen.getByRole('list', { name: 'Goles anulados' });
    const tanda = screen.getByRole('list', { name: 'Tanda de penales' });

    expect(within(juego).getAllByRole('listitem')).toHaveLength(1);
    expect(within(anulados).getAllByRole('listitem')).toHaveLength(1);
    expect(within(tanda).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('No suman al marcador.')).toBeInTheDocument();
    expect(
      screen.getByText('Penales convertidos en la definición: no son goles del juego.'),
    ).toBeInTheDocument();
  });
});

describe('MatchHistoricalDetail — fuente y carácter histórico', () => {
  it('muestra la fuente, que es histórico, la fecha de consulta y que no se actualiza en vivo', async () => {
    responder({ detail: detalle() });

    mostrar();

    const nota = await screen.findByText(/Fuente: API-Football/);

    expect(nota).toHaveTextContent('Datos históricos de un partido terminado');
    expect(nota).toHaveTextContent('consultados el 12 de noviembre de 2026');
    expect(nota).toHaveTextContent('no se actualizan en vivo');
  });

  it('no muestra la fuente cuando no hay detalle cargado', async () => {
    responder({ detail: null });

    const { container } = render(
      <MatchHistoricalDetail match={MATCH} accessToken="token-123" onSessionExpired={vi.fn()} />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    expect(screen.queryByText(/Fuente: API-Football/)).not.toBeInTheDocument();
  });
});

describe('MatchHistoricalDetail — teclado', () => {
  it('el único control es «Reintentar» y se alcanza con Tab y se activa con Enter', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 500));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ detail: detalle() }));

    mostrar();
    const boton = await screen.findByRole('button', { name: 'Reintentar' });

    await user.tab();
    expect(boton).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
