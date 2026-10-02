import { describe, it, expect } from 'vitest';
import { agendaWindow } from './match-window.js';

describe('agendaWindow', () => {
  it('va desde las 00:00 UTC de ayer hasta las 00:00 UTC del día posterior a los próximos siete días', () => {
    const window = agendaWindow(new Date('2026-10-10T15:30:00.000Z'));

    expect(window).toEqual({
      from: '2026-10-09T00:00:00.000Z',
      to: '2026-10-18T00:00:00.000Z',
    });
  });

  it('no depende de la hora del día: el primer y el último instante de un día UTC dan la misma ventana', () => {
    const alEmpezar = agendaWindow(new Date('2026-10-10T00:00:00.000Z'));
    const alTerminar = agendaWindow(new Date('2026-10-10T23:59:59.999Z'));

    expect(alTerminar).toEqual(alEmpezar);
  });

  it('usa el día UTC, no el del huso local de quien consulta', () => {
    // 22:30 del 10 en Argentina ya es el 11 en UTC.
    const window = agendaWindow(new Date('2026-10-10T22:30:00-03:00'));

    expect(window.from).toBe('2026-10-10T00:00:00.000Z');
  });

  it('cruza el cambio de mes hacia atrás y hacia adelante', () => {
    expect(agendaWindow(new Date('2026-10-01T12:00:00.000Z'))).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-10-09T00:00:00.000Z',
    });
    expect(agendaWindow(new Date('2026-10-28T12:00:00.000Z'))).toEqual({
      from: '2026-10-27T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
    });
  });

  it('cruza el cambio de año', () => {
    expect(agendaWindow(new Date('2026-12-31T12:00:00.000Z'))).toEqual({
      from: '2026-12-30T00:00:00.000Z',
      to: '2027-01-08T00:00:00.000Z',
    });
  });
});
