import {
  CatalogMatchCountSourceError,
  createPgClient,
  readCatalogSourceConfig,
  type CatalogMatchCountFailureReason,
  type CatalogSqlClientFactory,
} from './catalog-match-count-source.js';

/**
 * Lectura SQL mínima: no nombra ninguna tabla ni función del esquema, así que no
 * necesita ningún permiso. El rol del reporter la puede ejecutar tal cual está y
 * no hace falta concederle acceso a nada para este KPI.
 */
const AVAILABILITY_SQL = 'select 1 as ok';

export interface DatabaseAvailabilityDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: CatalogSqlClientFactory;
}

// La base misma informa que no puede atender: apagado por el administrador (57P01),
// caída (57P02), todavía no acepta conexiones (57P03), sin cupo de conexiones
// (53300) o conexión perdida (08006).
const UNAVAILABLE_SQLSTATES = ['57P01', '57P02', '57P03', '53300', '08006'];

// Rechazo o corte de la conexión por parte del otro extremo. Solo prueba una caída si
// la sesión ya estaba autenticada: antes de eso no hay ninguna respuesta de Postgres, y
// un puerto equivocado, un firewall o un proxy dan exactamente el mismo error.
const REFUSED_NODE_CODES = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'];

// Fallos que no prueban nada sobre la base: DNS, rutas o tiempos agotados al conectar
// son del entorno del reporter o de su configuración, no una caída comprobada.
const ENVIRONMENT_NODE_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
];

/** Un SQLSTATE es una respuesta de la base: cinco caracteres alfanuméricos. */
function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }

  return undefined;
}

/** Fallos de certificado o de TLS: son de la configuración de la conexión del reporter. */
function isTlsFailure(code: string): boolean {
  return (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('UNABLE_TO_') ||
    code.includes('CERT') ||
    code.includes('SELF_SIGNED')
  );
}

type Verdict = { down: true } | { down: false; reason: CatalogMatchCountFailureReason };

/**
 * Decide si un fallo es una indisponibilidad COMPROBADA de la base (0) o algo que
 * no se puede atribuir a ella y se omite con motivo:
 *
 * - 0: la base RESPONDE explícitamente que no atiende (SQLSTATE de apagado, caída o
 *   sin cupo), o la sesión ya autenticada se corta o deja de responder.
 * - Se omite: todo lo que ocurre antes de autenticar sin una respuesta de la base
 *   (rechazo o corte de la conexión, tiempo agotado, DNS, rutas, certificados y TLS:
 *   no se distingue una base caída de un puerto o una red mal configurados), los
 *   permisos (28xxx, 42501) y cualquier otro error de SQL.
 */
function judge(error: unknown, connected: boolean): Verdict {
  const code = errorCode(error);

  if (code !== undefined) {
    if (UNAVAILABLE_SQLSTATES.includes(code)) return { down: true };
    if (code === '42501' || /^28[0-9A-Z]{3}$/.test(code)) {
      return { down: false, reason: 'permission-denied' };
    }
    if (REFUSED_NODE_CODES.includes(code)) {
      return connected ? { down: true } : { down: false, reason: 'connection-failed' };
    }
    if (isTlsFailure(code) || ENVIRONMENT_NODE_CODES.includes(code)) {
      return { down: false, reason: 'connection-failed' };
    }
    // Una respuesta de la base con otro SQLSTATE: la base atiende, el problema es de la consulta.
    if (isSqlState(code)) return { down: false, reason: 'query-failed' };
  }

  // Sin una respuesta de SQL: si la conexión ya estaba autenticada y se cortó o dejó
  // de responder, la base falló; si ni siquiera se conectó, no se puede atribuir.
  return connected ? { down: true } : { down: false, reason: 'connection-failed' };
}

/**
 * Disponibilidad real de la base (`database_up`): `1` si una lectura mínima con
 * el rol de solo lectura del reporter, por una conexión TLS verificada, termina
 * bien; `0` solo ante una indisponibilidad comprobada.
 *
 * Es independiente de `/health` y de la función del catálogo: usa su propia
 * conexión y no depende de ningún objeto de la base. Un fallo de configuración,
 * de permisos o atribuible al reporter lanza el `CatalogMatchCountSourceError` con
 * su motivo y no se informa ningún valor: nunca se convierte en `0`.
 */
export async function probeDatabaseAvailability(
  deps: DatabaseAvailabilityDeps = {},
): Promise<0 | 1> {
  const { env = process.env, createClient = createPgClient } = deps;

  const config = readCatalogSourceConfig(env);
  const client = createClient(config);
  let connected = false;

  try {
    try {
      await client.connect();
      connected = true;
    } catch (error) {
      const verdict = judge(error, false);

      if (verdict.down) return 0;

      throw new CatalogMatchCountSourceError(verdict.reason);
    }

    let rows: unknown[];

    try {
      ({ rows } = await client.query(AVAILABILITY_SQL, []));
    } catch (error) {
      const verdict = judge(error, connected);

      if (verdict.down) return 0;

      throw new CatalogMatchCountSourceError(verdict.reason);
    }

    const row: unknown = rows.length === 1 ? rows[0] : undefined;
    const answered = typeof row === 'object' && row !== null && 'ok' in row && row.ok === 1;

    if (!answered) {
      throw new CatalogMatchCountSourceError('invalid-result');
    }

    return 1;
  } finally {
    try {
      await client.end();
    } catch {
      // Cerrar es best-effort: no debe tapar el resultado ni el motivo del fallo.
    }
  }
}
