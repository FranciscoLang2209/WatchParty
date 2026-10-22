/** Ambientes del reporter. Cada uno tiene su propio catálogo central y su propia clave. */
export const REPORTER_ENVS = ['dev', 'prod'] as const;

export type ReporterEnv = (typeof REPORTER_ENVS)[number];

export function isReporterEnv(value: unknown): value is ReporterEnv {
  return typeof value === 'string' && (REPORTER_ENVS as readonly string[]).includes(value);
}

/** Tipo de KPI del catálogo central (ADR-05): de negocio, técnico o de salud. */
export type KpiKind = 'business' | 'technical' | 'health';

/** Dominio numérico válido de un KPI. Todo valor además debe ser un número finito. */
interface ValueRule {
  readonly min: number;
  /** Si está, el valor no puede superarlo (el porcentaje llega a 100). */
  readonly max?: number;
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
 * Catálogo: los diez KPIs de ADR-05 rev. 2.0, cada uno con su fuente (SQL,
 * sondeo HTTP o medición propia). Son el máximo de mediciones de un lote
 * (`MAX_BATCH_ROWS`). Cada KPI nuevo debe registrarse además en el catálogo
 * central de cada ambiente antes de publicar. El orden es el de los artefactos.
 */
export const KPI_CATALOG = [
  {
    id: 'rated_match_rate',
    kind: 'business',
    unit: '%',
    description:
      'Porcentaje, entre 0 y 100, de los pares usuario-partido vistos en el mes local hasta el corte T que además tienen una nota o un comentario del mismo usuario en ese mes; cada par cuenta una vez y las cuentas técnicas se excluyen. Sin pares vistos en el mes se omite (no hay denominador).',
    rule: { min: 0, max: 100 },
  },
  {
    id: 'monthly_interactions_avg',
    kind: 'business',
    unit: '{interaction}/{user}',
    description:
      'Promedio de interacciones (notas y comentarios) por usuario activo en el mes local hasta el corte T, con decimales; usuario activo es quien tiene un visto, una nota o un comentario en el mes, y las cuentas técnicas se excluyen. Sin usuarios activos se omite (no hay denominador).',
    rule: { min: 0 },
  },
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
    id: 'catalog_query_latency',
    kind: 'technical',
    unit: 'ms',
    description:
      'Tiempo monotónico, en milisegundos, de la consulta SQL del catálogo hasta recibir su resultado, sin contar la conexión; solo si la consulta termina correctamente, si no se omite. Observa el tiempo de acceso a datos.',
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
    id: 'database_up',
    kind: 'health',
    unit: '1',
    description:
      'Lectura SQL mínima (select 1) con el rol de solo lectura del reporter, por TLS: 1 ante éxito y 0 solo ante una indisponibilidad comprobada de la base; permisos, configuración o fallos del reporter se omiten. /health no lo sustituye. Verifica el acceso real a la base.',
    rule: { min: 0, allowed: [0, 1] },
  },
  {
    id: 'catalog_read_up',
    kind: 'health',
    unit: '1',
    description:
      'GET /matches autenticado con la cuenta técnica de lectura del reporter: 1 ante un 200 con el esquema esperado (también con la lista vacía) y 0 ante un fallo comprobado del servicio; credenciales o configuración inválidas y fallos del reporter se omiten. Verifica la lectura autenticada.',
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
  if ('max' in rule && value > rule.max) return false;
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
