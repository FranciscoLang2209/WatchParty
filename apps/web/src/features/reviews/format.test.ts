import { describe, expect, it } from 'vitest';
import { formatReviewDate } from './format';

describe('formatReviewDate', () => {
  it('formatea en es-AR', () => {
    expect(formatReviewDate('2026-11-02T15:00:00.000Z')).toBe('2 de nov de 2026');
  });

  it('usa la hora de Argentina (UTC-3), no la del dispositivo ni UTC', () => {
    // 01:00 UTC del 2 de noviembre todavía es 1 de noviembre en Buenos Aires.
    expect(formatReviewDate('2026-11-02T01:00:00.000Z')).toBe('1 de nov de 2026');
  });

  it('devuelve tal cual una fecha ilegible', () => {
    expect(formatReviewDate('ayer')).toBe('ayer');
    expect(formatReviewDate('')).toBe('');
  });
});
