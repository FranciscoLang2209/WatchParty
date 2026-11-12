/**
 * Manifiesto del lote: pares explícitos `matchId interno : fixtureId del proveedor`, separados por
 * comas, espacios o saltos de línea. No hay búsqueda ni coincidencia difusa: sólo se procesa lo
 * que una persona aprobó.
 *
 *   3f9c0c8e-1c1e-4a62-8f64-0a3f6f1a2b10:1145512, 7a2d…:1145513
 */
export interface EnrichmentEntry {
  matchId: string;
  fixtureId: number;
}

/**
 * Tope por corrida. Cada partido consume 3 pedidos (fixture, estadísticas, eventos) contra un
 * presupuesto diario compartido de 80: con 20 entradas se usan 60 como máximo.
 */
export const MAX_ENRICHMENT_BATCH_SIZE = 20;

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`Lote de correspondencias inválido:\n- ${problems.join('\n- ')}`);
    this.name = 'ManifestError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseEnrichmentManifest(raw: string): EnrichmentEntry[] {
  const tokens = raw.split(/[\s,;]+/).filter((token) => token !== '');

  if (tokens.length === 0) {
    throw new ManifestError(['el lote está vacío: indicá al menos un par matchId:fixtureId']);
  }

  const problems: string[] = [];
  const entries: EnrichmentEntry[] = [];
  const seenMatches = new Set<string>();
  const seenFixtures = new Set<number>();

  if (tokens.length > MAX_ENRICHMENT_BATCH_SIZE) {
    problems.push(
      `el lote tiene ${tokens.length} correspondencias y el máximo es ${MAX_ENRICHMENT_BATCH_SIZE}`,
    );
  }

  for (const token of tokens) {
    const parts = token.split(':');
    const [matchPart, fixturePart] = parts;

    if (parts.length !== 2 || matchPart === undefined || fixturePart === undefined) {
      problems.push(`"${token}" no tiene la forma matchId:fixtureId`);
      continue;
    }

    if (!UUID_PATTERN.test(matchPart)) {
      problems.push(`"${matchPart}" no es un UUID de partido válido`);
      continue;
    }

    if (!/^[1-9]\d{0,9}$/.test(fixturePart)) {
      problems.push(`"${fixturePart}" no es un id de fixture válido (entero positivo)`);
      continue;
    }

    const matchId = matchPart.toLowerCase();
    const fixtureId = Number(fixturePart);

    // Un mismo partido con dos fixtures, o un mismo fixture en dos partidos, es justo la
    // asociación ambigua que no se acepta: se rechaza todo el lote antes de consultar nada.
    if (seenMatches.has(matchId)) {
      problems.push(`el partido ${matchId} aparece más de una vez`);
      continue;
    }
    if (seenFixtures.has(fixtureId)) {
      problems.push(`el fixture ${fixtureId} aparece asociado a más de un partido`);
      continue;
    }

    seenMatches.add(matchId);
    seenFixtures.add(fixtureId);
    entries.push({ matchId, fixtureId });
  }

  if (problems.length > 0) throw new ManifestError(problems);

  return entries;
}
