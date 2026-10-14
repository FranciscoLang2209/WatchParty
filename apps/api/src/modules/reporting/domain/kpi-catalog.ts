/** Ambientes del reporter. Cada uno tiene su propio catálogo central y su propia clave. */
export const REPORTER_ENVS = ['dev', 'prod'] as const;

export type ReporterEnv = (typeof REPORTER_ENVS)[number];

export function isReporterEnv(value: unknown): value is ReporterEnv {
  return typeof value === 'string' && (REPORTER_ENVS as readonly string[]).includes(value);
}

/** Tipo de KPI del catálogo central. Los de negocio aún no tienen fuentes verificadas. */
export type KpiKind = 'technical' | 'health';

/** Dominio numérico válido de un KPI. Todo valor además debe ser un número finito. */
interface ValueRule {
  readonly min: number;
  readonly integer?: boolean;
  /** Si está, el valor debe ser uno de estos (indicadores 0/1). */
  readonly allowed?: readonly number[];
}

interface KpiDefinition {
  readonly id: string;
  readonly kind: KpiKind;
  readonly unit: string;
  /** Qué mide y cómo se calcula (semántica del catálogo, ADR-05 rev. 2.0). */
  readonly description: string;
  readonly rule: ValueRule;
}

/**
 * Catálogo inicial: exactamente los cinco KPIs con fuentes verificadas (ADR-05
 * rev. 2.0). Ampliarlo a los diez objetivo es una decisión posterior; el orden
 * es el de los artefactos.
 */
export const KPI_CATALOG = [
  {
    id: 'catalog_match_count',
    kind: 'technical',
    unit: '{match}',
    description:
      'Cantidad de IDs de partido distintos del catálogo real persistido al corte T, sin contar la fixture local. Detecta catálogo vacío o pérdida de datos.',
    rule: { min: 0, integer: true },
  },
  {
    id: 'health_response_latency',
    kind: 'technical',
    unit: 'ms',
    description:
      'Tiempo monotónico, en milisegundos, de GET /health hasta recibir el cuerpo de una respuesta 200; sin éxito se omite. Observa la latencia externa del backend.',
    rule: { min: 0 },
  },
  {
    id: 'health_up',
    kind: 'health',
    unit: '1',
    description:
      'GET /health: 1 ante una respuesta 200 y 0 ante un fallo comprobado del servicio; un fallo del reporter se omite. Disponibilidad del backend al corte T.',
    rule: { min: 0, allowed: [0, 1] },
  },
  {
    id: 'auth_guard_up',
    kind: 'health',
    unit: '1',
    description:
      'GET /matches sin token: 1 ante 401 y 0 ante cualquier otro estado recibido; sin respuesta se omite. Detecta regresiones de autenticación.',
    rule: { min: 0, allowed: [0, 1] },
  },
  {
    id: 'report_collection_duration',
    kind: 'technical',
    unit: 's',
    description:
      'Tiempo monotónico, en segundos, de extracción, sondeos, cálculo y validación de las otras métricas; excluye la publicación. Mide el costo de preparar el reporte.',
    rule: { min: 0 },
  },
] as const satisfies readonly KpiDefinition[];

export type KpiId = (typeof KPI_CATALOG)[number]['id'];

export function isKpiId(value: unknown): value is KpiId {
  return KPI_CATALOG.some((kpi) => kpi.id === value);
}

/**
 * Valida un valor contra la definición del KPI: número finito (ni NaN, ni
 * infinito, ni null, ni texto), dentro del rango y del dominio de su unidad.
 */
export function isValidKpiValue(id: KpiId, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;

  const { rule } = KPI_CATALOG.find((kpi) => kpi.id === id)!;
  const { min } = rule;

  if (value < min) return false;
  if ('integer' in rule && rule.integer && !Number.isInteger(value)) return false;
  if ('allowed' in rule && !(rule.allowed as readonly number[]).includes(value)) return false;

  return true;
}

/** Único contenido que se registra en `kpi_catalog`. */
export interface KpiCatalogRecord {
  id: KpiId;
  kind: KpiKind;
  unit: string;
  description: string;
}

/** Catálogo listo para registrar en UN ambiente. Preparar no lo activa ni lo envía. */
export interface CatalogRegistration {
  env: ReporterEnv;
  records: KpiCatalogRecord[];
}

/**
 * Prepara el registro del catálogo para un ambiente. Devuelve copias nuevas en
 * cada llamada: dev y prod no comparten objetos, así que preparar uno no
 * registra ni modifica al otro. No hace ninguna llamada de red.
 */
export function prepareCatalogRegistration(env: ReporterEnv): CatalogRegistration {
  if (!isReporterEnv(env)) {
    throw new Error('Ambiente del reporter inválido.');
  }

  return {
    env,
    records: KPI_CATALOG.map(({ id, kind, unit, description }) => ({
      id,
      kind,
      unit,
      description,
    })),
  };
}
