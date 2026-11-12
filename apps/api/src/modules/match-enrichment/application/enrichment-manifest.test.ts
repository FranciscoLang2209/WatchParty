import { describe, it, expect } from 'vitest';
import {
  MAX_ENRICHMENT_BATCH_SIZE,
  ManifestError,
  parseEnrichmentManifest,
} from './enrichment-manifest.js';

const A = '3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10';
const B = '7a2d1b50-5c3e-4f10-9a77-2d9e4c8b1f33';
const C = '0b8e6f2a-9d41-4c7a-8e55-6a1f3d2c9b04';

function problemsOf(raw: string): string[] {
  try {
    parseEnrichmentManifest(raw);
  } catch (error) {
    if (error instanceof ManifestError) return error.problems;
    throw error;
  }
  return [];
}

describe('parseEnrichmentManifest', () => {
  it('lee pares matchId:fixtureId separados por comas, espacios o saltos de línea', () => {
    expect(parseEnrichmentManifest(`${A}:1145512, ${B}:1145513\n${C}:77`)).toEqual([
      { matchId: A, fixtureId: 1145512 },
      { matchId: B, fixtureId: 1145513 },
      { matchId: C, fixtureId: 77 },
    ]);
  });

  it('normaliza el UUID a minúsculas', () => {
    expect(parseEnrichmentManifest(`${A.toUpperCase()}:5`)).toEqual([{ matchId: A, fixtureId: 5 }]);
  });

  it.each(['', '   ', ',,\n'])(
    'un lote vacío (%j) se rechaza: no hay piloto por defecto',
    (raw) => {
      expect(problemsOf(raw)[0]).toContain('vacío');
    },
  );

  it.each([
    [`${A}`, 'no tiene la forma'],
    [`${A}:12:34`, 'no tiene la forma'],
    [`no-es-uuid:12`, 'no es un UUID'],
    [`${A}:0`, 'no es un id de fixture'],
    [`${A}:-4`, 'no es un id de fixture'],
    [`${A}:1.5`, 'no es un id de fixture'],
    [`${A}:abc`, 'no es un id de fixture'],
  ])('%s se rechaza con un motivo claro', (raw, motivo) => {
    expect(problemsOf(raw).join('\n')).toContain(motivo);
  });

  it('un mismo partido dos veces es una asociación ambigua', () => {
    expect(problemsOf(`${A}:1, ${A}:2`).join('\n')).toContain('aparece más de una vez');
  });

  it('un mismo fixture en dos partidos es una asociación ambigua', () => {
    expect(problemsOf(`${A}:1, ${B}:1`).join('\n')).toContain('más de un partido');
  });

  it('el lote está acotado', () => {
    const muchos = Array.from(
      { length: MAX_ENRICHMENT_BATCH_SIZE + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}:${i + 1}`,
    ).join(',');

    expect(problemsOf(muchos).join('\n')).toContain(`máximo es ${MAX_ENRICHMENT_BATCH_SIZE}`);
  });

  it('informa todos los problemas juntos, no sólo el primero', () => {
    expect(problemsOf(`x:1, ${A}:abc`)).toHaveLength(2);
  });
});
