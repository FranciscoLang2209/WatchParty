import type { Match } from './match.js';
import type { NormalizedMatchFixture } from './normalized-match-fixture.js';

/**
 * Identifica un scope de sincronización con un proveedor externo, tal como
 * lo modela `provider_sync_state` (WAT-103): un proveedor, una competición
 * y una temporada.
 */
export interface SyncLeaseScope {
  provider: string;
  competitionExternalId: string;
  season: string;
}

/** Detalles opcionales al cerrar un intento de sincronización. */
export interface SyncResultDetails {
  error?: string;
  observedQuotaRemaining?: number;
  observedQuotaWindowResetAt?: string;
}

/**
 * Puerto de persistencia para el módulo de partidos.
 *
 * Es más amplio que `MatchCatalog` (que solo expone `list`/`findById` con
 * el contrato público `Match`) porque además cubre las operaciones de
 * escritura e importación que WAT-107 necesita: upsert idempotente de
 * fixtures normalizados y el ciclo de vida completo del lease de
 * sincronización (WAT-103). Separar ambos puertos mantiene el principio de
 * segregación de interfaces: los handlers HTTP siguen dependiendo solo de
 * `MatchCatalog`, sin conocer que existen estas operaciones de escritura.
 *
 * Cualquier implementación debe propagar los errores de la base de datos
 * (nunca devolver `[]`, `null` o datos ficticios como sustituto de una
 * falla) y nunca "robar" un lease vigente ni cerrar uno vencido.
 */
export interface MatchStore {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;

  /**
   * Upsertea equipos y partido para un fixture normalizado. Conserva el
   * UUID interno del partido si ya existía uno con el mismo
   * `(provider, externalId)`. Devuelve el UUID interno del partido.
   */
  upsertFixture(fixture: NormalizedMatchFixture): Promise<string>;

  /** Adquiere el lease si está libre. Devuelve el token, o `null` si ya estaba tomado. */
  acquireSyncLease(
    scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds?: number,
  ): Promise<string | null>;

  /** Libera un lease vencido para que vuelva a estar disponible. */
  reclaimExpiredSyncLease(scope: SyncLeaseScope): Promise<boolean>;

  /** Libera un lease vigente; solo tiene efecto si `leaseToken` coincide con el dueño actual. */
  releaseSyncLease(scope: SyncLeaseScope, leaseToken: string): Promise<boolean>;

  /** Registra el resultado de un intento y libera el lease; solo con un `leaseToken` vigente. */
  recordSyncResult(
    scope: SyncLeaseScope,
    leaseToken: string,
    success: boolean,
    details?: SyncResultDetails,
  ): Promise<boolean>;
}
