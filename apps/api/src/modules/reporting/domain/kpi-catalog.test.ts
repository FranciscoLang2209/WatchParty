import { describe, it, expect } from 'vitest';
import {
  KPI_CATALOG,
  REPORTER_ENVS,
  isKpiId,
  isReporterEnv,
  isValidKpiValue,
  prepareCatalogRegistration,
  type KpiId,
} from './kpi-catalog.js';

describe('KPI_CATALOG', () => {
  it('contiene exactamente los cinco KPIs iniciales, en orden', () => {
    expect(KPI_CATALOG.map((kpi) => kpi.id)).toEqual([
      'catalog_match_count',
      'health_response_latency',
      'health_up',
      'auth_guard_up',
      'report_collection_duration',
    ]);
  });

  it('cada KPI tiene el tipo y la unidad del ADR', () => {
    expect(KPI_CATALOG.map(({ id, kind, unit }) => ({ id, kind, unit }))).toEqual([
      { id: 'catalog_match_count', kind: 'technical', unit: '{match}' },
      { id: 'health_response_latency', kind: 'technical', unit: 'ms' },
      { id: 'health_up', kind: 'health', unit: '1' },
      { id: 'auth_guard_up', kind: 'health', unit: '1' },
      { id: 'report_collection_duration', kind: 'technical', unit: 's' },
    ]);
  });

  it('cada KPI tiene una descripción con su semántica', () => {
    for (const kpi of KPI_CATALOG) {
      expect(kpi.description.trim().length).toBeGreaterThan(20);
    }
  });

  it('no incluye los KPIs de negocio ni los que aún no tienen fuente verificada', () => {
    for (const id of [
      'rated_match_rate',
      'monthly_interactions_avg',
      'catalog_query_latency',
      'database_up',
      'catalog_read_up',
    ]) {
      expect(isKpiId(id)).toBe(false);
    }
  });
});

describe('isValidKpiValue: rangos y unidades', () => {
  it.each<[KpiId, number]>([
    ['catalog_match_count', 0],
    ['catalog_match_count', 4210],
    ['health_response_latency', 0],
    ['health_response_latency', 312.456],
    ['health_up', 0],
    ['health_up', 1],
    ['auth_guard_up', 0],
    ['auth_guard_up', 1],
    ['report_collection_duration', 0],
    ['report_collection_duration', 1.591],
  ])('%s acepta %d', (id, value) => {
    expect(isValidKpiValue(id, value)).toBe(true);
  });

  it.each<[KpiId, unknown]>([
    ['catalog_match_count', -1],
    ['catalog_match_count', 1.5],
    ['health_response_latency', -0.001],
    ['health_up', 2],
    ['health_up', -1],
    ['health_up', 0.5],
    ['auth_guard_up', 2],
    ['auth_guard_up', 0.5],
    ['report_collection_duration', -0.1],
  ])('%s rechaza %s (fuera de rango o de dominio)', (id, value) => {
    expect(isValidKpiValue(id, value)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['texto numérico', '12'],
    ['booleano', true],
    ['objeto', {}],
  ])('ningún KPI acepta %s', (_label, value) => {
    for (const { id } of KPI_CATALOG) {
      expect(isValidKpiValue(id, value)).toBe(false);
    }
  });
});

describe('prepareCatalogRegistration', () => {
  it.each(REPORTER_ENVS)('%s: registra solo id, kind, unit y description', (env) => {
    const registration = prepareCatalogRegistration(env);

    expect(registration.env).toBe(env);
    expect(registration.records).toHaveLength(5);

    for (const record of registration.records) {
      expect(Object.keys(record)).toEqual(['id', 'kind', 'unit', 'description']);
    }
  });

  it('dev y prod son independientes: no comparten objetos ni se afectan', () => {
    const dev = prepareCatalogRegistration('dev');
    const prod = prepareCatalogRegistration('prod');

    expect(dev.records).toEqual(prod.records);
    expect(dev.records).not.toBe(prod.records);
    expect(dev.records[0]).not.toBe(prod.records[0]);

    dev.records[0]!.description = 'modificado solo en dev';
    dev.records.pop();

    expect(prod.records).toHaveLength(5);
    expect(prod.records[0]!.description).not.toBe('modificado solo en dev');
    expect(KPI_CATALOG[0].description).not.toBe('modificado solo en dev');
    expect(prepareCatalogRegistration('dev').records).toHaveLength(5);
  });

  it('rechaza un ambiente desconocido', () => {
    expect(() => prepareCatalogRegistration('staging' as never)).toThrow('Ambiente');
  });

  it('solo prepara: no hace ninguna llamada de red', () => {
    const originalFetch = globalThis.fetch;
    let called = false;

    globalThis.fetch = (() => {
      called = true;
      return Promise.reject(new Error('no debería llamarse'));
    }) as typeof fetch;

    try {
      prepareCatalogRegistration('prod');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(called).toBe(false);
  });
});

describe('isReporterEnv', () => {
  it('reconoce solo dev y prod', () => {
    expect(isReporterEnv('dev')).toBe(true);
    expect(isReporterEnv('prod')).toBe(true);
    expect(isReporterEnv('staging')).toBe(false);
    expect(isReporterEnv('PROD')).toBe(false);
    expect(isReporterEnv(undefined)).toBe(false);
  });
});
