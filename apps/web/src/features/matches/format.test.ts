import { describe, expect, it } from 'vitest';
import {
  MATCH_STATUS_LABELS,
  formatKickoff,
  formatKickoffDate,
  formatKickoffTime,
  isMatchStatus,
  kickoffDay,
  matchStatusLabel,
} from './format';
import { MATCH_STATUSES } from './types';

// 21:00 UTC = 18:00 en Buenos Aires (UTC-3).
const KICKOFF = '2026-09-06T21:00:00Z';

describe('Etiquetas de estado', () => {
  it('cubre exactamente los cinco estados del dominio', () => {
    expect(Object.keys(MATCH_STATUS_LABELS).sort()).toEqual([...MATCH_STATUSES].sort());
  });

  it('traduce cada estado a una etiqueta legible', () => {
    expect(matchStatusLabel('scheduled')).toBe('Programado');
    expect(matchStatusLabel('live')).toBe('En vivo');
    expect(matchStatusLabel('finished')).toBe('Finalizado');
    expect(matchStatusLabel('postponed')).toBe('Postergado');
    expect(matchStatusLabel('cancelled')).toBe('Cancelado');
  });

  it('reconoce sólo los estados válidos', () => {
    for (const status of MATCH_STATUSES) {
      expect(isMatchStatus(status)).toBe(true);
    }

    expect(isMatchStatus('LIVE')).toBe(false);
    expect(isMatchStatus('halftime')).toBe(false);
    expect(isMatchStatus(undefined)).toBe(false);
  });
});

describe('Formato del horario', () => {
  it('convierte el UTC de la API a hora de Argentina', () => {
    // Sin zona explícita, este test fallaría en una máquina con otro huso.
    expect(formatKickoffTime(KICKOFF)).toContain('18:00');
  });

  it('usa nombres de día y mes en castellano', () => {
    const formatted = formatKickoffDate(KICKOFF);

    expect(formatted).toMatch(/dom/i);
    expect(formatted).toMatch(/sep/i);
  });

  it('el formato completo incluye fecha y hora', () => {
    const formatted = formatKickoff(KICKOFF);

    expect(formatted).toMatch(/sep/i);
    expect(formatted).toContain('18:00');
  });

  it('no rompe ni inventa un horario si la fecha es ilegible', () => {
    expect(formatKickoff('mañana')).toBe('mañana');
    expect(formatKickoffDate('')).toBe('');
  });

  it('respeta el cambio de día al cruzar el huso', () => {
    // 00:30 UTC del 7 es todavía el 6 a las 21:30 en Buenos Aires.
    expect(formatKickoffDate('2026-09-07T00:30:00Z')).toContain('6');
    expect(formatKickoffTime('2026-09-07T00:30:00Z')).toContain('21:30');
  });
});

describe('Día de calendario del partido', () => {
  it('es el día en la zona de Argentina, no el del instante UTC', () => {
    // 21:00 UTC = 18:00 en Buenos Aires: el mismo día.
    expect(kickoffDay(KICKOFF)).toBe('2026-09-06');
    // 00:30 UTC del 7 todavía es el 6 a las 21:30 en Buenos Aires.
    expect(kickoffDay('2026-09-07T00:30:00Z')).toBe('2026-09-06');
  });

  it('cambia de día exactamente a la medianoche de Buenos Aires (03:00 UTC)', () => {
    expect(kickoffDay('2026-11-07T02:59:59Z')).toBe('2026-11-06');
    expect(kickoffDay('2026-11-07T03:00:00Z')).toBe('2026-11-07');
    expect(kickoffDay('2026-11-07T23:59:59-03:00')).toBe('2026-11-07');
    expect(kickoffDay('2026-11-08T00:00:00-03:00')).toBe('2026-11-08');
  });

  it('cruza fin de mes y de año según la zona de presentación', () => {
    expect(kickoffDay('2026-12-01T02:00:00Z')).toBe('2026-11-30');
    expect(kickoffDay('2027-01-01T02:59:00Z')).toBe('2026-12-31');
    expect(kickoffDay('2027-01-01T03:00:00Z')).toBe('2027-01-01');
  });

  it('devuelve siempre el formato YYYY-MM-DD con ceros', () => {
    expect(kickoffDay('2026-03-05T15:00:00Z')).toBe('2026-03-05');
  });

  it('una fecha ilegible no pertenece a ningún día', () => {
    expect(kickoffDay('mañana')).toBeNull();
    expect(kickoffDay('')).toBeNull();
  });
});
