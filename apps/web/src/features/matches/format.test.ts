import { describe, expect, it } from 'vitest';
import {
  MATCH_STATUS_LABELS,
  formatKickoff,
  formatKickoffDate,
  formatKickoffTime,
  isMatchStatus,
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
