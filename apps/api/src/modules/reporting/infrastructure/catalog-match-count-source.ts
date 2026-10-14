import pg from 'pg';

/** Unidad del KPI `catalog_match_count` (ADR-05): cantidad de partidos. */
export const CATALOG_MATCH_COUNT_UNIT = '{match}';

/**
 * Motivos por los que no hay conteo. Cada uno es un motivo de omisión del KPI:
 * nunca se traduce a cero.
 */
export type CatalogMatchCountFailureReason =
  | 'config-missing'
  | 'config-invalid'
  | 'invalid-cutoff'
  | 'connection-failed'
  | 'permission-denied'
  | 'query-failed'
  | 'invalid-result';

// Mensajes fijos y ya sanitizados. Nunca incluyen texto del driver ni de
// Postgres: pueden traer el host, el usuario o parte de la cadena de conexión.
const FAILURE_MESSAGES: Record<CatalogMatchCountFailureReason, string> = {
  'config-missing': 'Falta la configuración de la fuente SQL del reporter (REPORTER_DATABASE_URL).',
  'config-invalid': 'La configuración de la fuente SQL del reporter no es válida.',
  'invalid-cutoff': 'El corte T debe ser una fecha válida y no futura.',
  'connection-failed': 'No se pudo conectar con la fuente SQL del reporter.',
  'permission-denied': 'La fuente SQL del reporter rechazó el acceso o el permiso de lectura.',
  'query-failed': 'La consulta del conteo del catálogo falló.',
  'invalid-result': 'La consulta del conteo del catálogo devolvió un resultado inválido.',
};

export class CatalogMatchCountSourceError extends Error {
  readonly reason: CatalogMatchCountFailureReason;

  constructor(reason: CatalogMatchCountFailureReason) {
    super(FAILURE_MESSAGES[reason]);
    this.name = 'CatalogMatchCountSourceError';
    this.reason = reason;
  }
}

export interface CatalogMatchCount {
  value: number;
  unit: typeof CATALOG_MATCH_COUNT_UNIT;
}

/** Datos de conexión ya validados. Contiene la contraseña: no se loguea ni se serializa. */
export interface CatalogSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** CA del servidor (PEM). Sin ella se usa el almacén de confianza del sistema. */
  ca?: string;
}

const DATABASE_URL_VAR = 'REPORTER_DATABASE_URL';
const CA_CERT_VAR = 'REPORTER_DATABASE_CA_CERT';

// Cuentas que nunca son un usuario de lectura del reporter. El usuario del
// pooler llega como `<rol>.<ref>`, por eso solo se mira lo anterior al primer punto.
const FORBIDDEN_ROLES: readonly string[] = ['postgres', 'service_role', 'supabase_admin'];

const DEFAULT_PORT = 5432;
const TIMEOUT_MS = 10_000;

// Consulta única del adaptador. El rol del reporter solo puede ejecutar este
// agregado: no lee tablas directamente.
const COUNT_SQL = 'select reporting.catalog_match_count($1::timestamptz) as value';

function configError(): CatalogMatchCountSourceError {
  return new CatalogMatchCountSourceError('config-invalid');
}

/**
 * Lee la configuración del entorno. Sin `REPORTER_DATABASE_URL` falla: no hay
 * valor por defecto ni se cae a otra credencial (nunca `SUPABASE_SERVICE_ROLE_KEY`).
 *
 * La URL debe pedir `sslmode=verify-full` (validación de CA y de hostname). La
 * conexión se arma con campos explícitos para que el driver no reinterprete ese
 * parámetro: la verificación del certificado no depende de cómo lo lea.
 */
export function readCatalogSourceConfig(env: NodeJS.ProcessEnv = process.env): CatalogSourceConfig {
  const rawUrl = env[DATABASE_URL_VAR]?.trim();

  if (!rawUrl) {
    throw new CatalogMatchCountSourceError('config-missing');
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    // No se propaga el error original: su mensaje incluye la URL completa.
    throw configError();
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw configError();
  if (url.searchParams.get('sslmode') !== 'verify-full') throw configError();

  let user: string;
  let password: string;
  let database: string;

  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw configError();
  }

  if (!url.hostname || !user || !password || !database) throw configError();

  const role = user.split('.')[0]!.toLowerCase();

  if (FORBIDDEN_ROLES.includes(role)) throw configError();

  const port = url.port === '' ? DEFAULT_PORT : Number(url.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw configError();

  const config: CatalogSourceConfig = { host: url.hostname, port, user, password, database };

  const ca = env[CA_CERT_VAR]?.trim();

  if (ca) {
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw configError();

    config.ca = ca;
  }

  return config;
}

/** Lo mínimo del cliente SQL que usa el adaptador; permite probarlo sin base. */
export interface CatalogSqlClient {
  connect(): Promise<unknown>;
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
}

export type CatalogSqlClientFactory = (config: CatalogSourceConfig) => CatalogSqlClient;

/** Cliente `pg` con TLS obligatorio: certificado y hostname del servidor siempre verificados. */
export function createPgClient(config: CatalogSourceConfig): CatalogSqlClient {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ca ? { rejectUnauthorized: true, ca: config.ca } : { rejectUnauthorized: true },
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  });

  // Una conexión perdida (caída de red, reinicio del pooler) además de rechazar
  // la promesa en curso emite `error` en el cliente; sin listener, Node lo trata
  // como excepción no capturada y termina todo el proceso. El fallo ya se propaga
  // por la promesa de `connect`/`query`, que es lo que clasifica `classify`. Acá
  // no se registra nada: el mensaje del driver puede traer host o usuario.
  client.on('error', () => {});

  return {
    connect: () => client.connect(),
    query: (text, values) => client.query(text, values),
    end: () => client.end(),
  };
}

export interface CatalogMatchCountDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: CatalogSqlClientFactory;
  now?: () => Date;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }

  return undefined;
}

// 28xxx = autorización inválida (rol sin LOGIN, contraseña rechazada) y
// 42501 = privilegio insuficiente. Cualquier otra falla cae al motivo de la etapa.
function classify(
  error: unknown,
  fallback: 'connection-failed' | 'query-failed',
): CatalogMatchCountSourceError {
  const code = sqlState(error);

  if (code !== undefined && (code === '42501' || /^28[0-9A-Z]{3}$/.test(code))) {
    return new CatalogMatchCountSourceError('permission-denied');
  }

  return new CatalogMatchCountSourceError(fallback);
}

/**
 * `count(*)` llega como `bigint`, que el driver entrega como texto. Se acepta
 * un entero no negativo, ya sea número o texto de dígitos; todo lo demás
 * (sin filas, nulo, negativo, decimal, no finito, fuera del rango seguro) es
 * un resultado inválido, nunca cero.
 */
function parseCount(rows: unknown[]): number {
  const row: unknown = rows.length === 1 ? rows[0] : undefined;

  if (typeof row !== 'object' || row === null || !('value' in row)) {
    throw new CatalogMatchCountSourceError('invalid-result');
  }

  const raw = row.value;
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CatalogMatchCountSourceError('invalid-result');
  }

  return value;
}

/**
 * Cantidad de partidos distintos del catálogo persistido al corte `cutoff`
 * (`catalog_match_count`, unidad `{match}`), leída con el usuario de solo
 * lectura del reporter por una conexión TLS verificada.
 *
 * Solo hay dos desenlaces: un conteo real o un `CatalogMatchCountSourceError`
 * con su motivo. Un fallo de permisos, de configuración o de la fuente nunca
 * se convierte en cero: cero solo se devuelve si la consulta tuvo éxito y
 * respondió cero.
 */
export async function readCatalogMatchCount(
  cutoff: Date,
  deps: CatalogMatchCountDeps = {},
): Promise<CatalogMatchCount> {
  const { env = process.env, createClient = createPgClient, now = () => new Date() } = deps;

  const config = readCatalogSourceConfig(env);

  const cutoffMs = cutoff.getTime();

  if (!Number.isFinite(cutoffMs) || cutoffMs > now().getTime()) {
    throw new CatalogMatchCountSourceError('invalid-cutoff');
  }

  const client = createClient(config);

  try {
    try {
      await client.connect();
    } catch (error) {
      throw classify(error, 'connection-failed');
    }

    let rows: unknown[];

    try {
      ({ rows } = await client.query(COUNT_SQL, [cutoff.toISOString()]));
    } catch (error) {
      throw classify(error, 'query-failed');
    }

    return { value: parseCount(rows), unit: CATALOG_MATCH_COUNT_UNIT };
  } finally {
    try {
      await client.end();
    } catch {
      // Cerrar es best-effort: no debe tapar el resultado ni el motivo del fallo.
    }
  }
}
