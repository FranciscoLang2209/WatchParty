import { describe, expect, it } from 'vitest';
import { formatAverage, formatVotes } from './format';

describe('formatAverage', () => {
  it.each([
    [1, '1,0'],
    [3.5, '3,5'],
    [4, '4,0'],
    [3.67, '3,67'],
    [4.33, '4,33'],
    [5, '5,0'],
  ])('%s se lee %s (coma decimal y al menos un decimal)', (valor, esperado) => {
    expect(formatAverage(valor)).toBe(esperado);
  });

  it('nunca pasa de dos decimales', () => {
    expect(formatAverage(3.666666)).toBe('3,67');
  });
});

describe('formatVotes', () => {
  it('uno va en singular', () => {
    expect(formatVotes(1)).toBe('1 voto');
  });

  it.each([
    [0, '0 votos'],
    [2, '2 votos'],
    [12, '12 votos'],
  ])('%s va en plural', (cantidad, esperado) => {
    expect(formatVotes(cantidad)).toBe(esperado);
  });
});
