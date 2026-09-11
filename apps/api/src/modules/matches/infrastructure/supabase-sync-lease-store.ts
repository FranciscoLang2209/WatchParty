import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncLeaseScope, SyncResultDetails } from '../domain/match-store.js';
import { SupabasePersistenceError } from './supabase-persistence-error.js';

// Límite conservador para no inflar la tabla ni arriesgarnos a que un
// mensaje larguísimo (por ejemplo, el cuerpo completo de una respuesta
// HTTP del proveedor externo) termine persistido en
// provider_sync_state.last_error.
const MAX_SYNC_ERROR_LENGTH = 300;
const FALLBACK_SYNC_ERROR_MESSAGE = 'Error desconocido durante la sincronización.';
const REDACTED_PLACEHOLDER = '[redactado]';

// Patrones de datos sensibles que nunca deben llegar a
// provider_sync_state.last_error: URLs completas (pueden traer
// credenciales o tokens en la query string) y tokens/API keys largos
// (secuencias alfanuméricas de 20+ caracteres — el shape típico de un
// bearer token o una key de servicio).
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;

function redactSensitiveSubstrings(message: string): string {
  return message
    .replace(URL_PATTERN, REDACTED_PLACEHOLDER)
    .replace(LONG_TOKEN_PATTERN, REDACTED_PLACEHOLDER);
}

/**
 * Convierte lo que llegue en `details.error` a un mensaje corto y seguro
 * antes de persistirlo en `provider_sync_state.last_error`.
 *
 * Nunca usamos `Error.message` ni `String(error)` de un objeto/Error: aunque
 * no tengan stack trace, el mensaje en sí puede traer datos sensibles (una
 * URL con credenciales, un token, una API key) que no controlamos porque no
 * sabemos qué código lo generó. Para esos casos devolvemos siempre el
 * mensaje genérico — no hay forma segura de "limpiar" texto arbitrario que
 * no armamos nosotros.
 *
 * Un string ya armado por el caller (asumimos que decidió a propósito qué
 * decir) sí se persiste, pero igual pasa por una redacción explícita de
 * patrones típicos de datos sensibles como defensa en profundidad, más el
 * límite de longitud y el colapso de saltos de línea.
 */
function sanitizeSyncError(error: unknown): string | null {
  if (error === undefined || error === null) {
    return null;
  }

  if (typeof error !== 'string') {
    // Error, objeto, lo que sea: nunca extraemos texto de algo que no
    // controlamos.
    return FALLBACK_SYNC_ERROR_MESSAGE;
  }

  const singleLine = error.replace(/\s+/g, ' ').trim();

  if (singleLine.length === 0) {
    return FALLBACK_SYNC_ERROR_MESSAGE;
  }

  const redacted = redactSensitiveSubstrings(singleLine);

  return redacted.length > MAX_SYNC_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_SYNC_ERROR_LENGTH - 1)}…`
    : redacted;
}

/**
 * Coordinación del lease de sincronización (`provider_sync_state`, WAT-103).
 *
 * Separado de `SupabaseMatchStore` porque no comparte ninguna FK ni relación
 * con `teams`/`matches`: es un tema propio (turnos de sincronización con un
 * proveedor externo), a diferencia de `upsertFixture`, donde equipo y
 * partido sí están acoplados por FK y conviene mantenerlos juntos.
 *
 * Solo llama a las 4 funciones SQL que ya creó WAT-103 vía `.rpc(...)`;
 * nunca hace `.from('provider_sync_state')` directamente.
 */
export class SupabaseSyncLeaseStore {
  constructor(private readonly client: SupabaseClient) {}

  async acquireSyncLease(
    scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds?: number,
  ): Promise<string | null> {
    const { data, error } = await this.client.rpc('acquire_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_owner: owner,
      ...(leaseDurationSeconds !== undefined
        ? { p_lease_duration: `${leaseDurationSeconds} seconds` }
        : {}),
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo adquirir el lease de sincronización.', error);
    }

    return data as string | null;
  }

  async reclaimExpiredSyncLease(scope: SyncLeaseScope): Promise<boolean> {
    const { data, error } = await this.client.rpc('reclaim_expired_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo recuperar el lease vencido.', error);
    }

    return data === true;
  }

  async releaseSyncLease(scope: SyncLeaseScope, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('release_provider_sync_lease', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_lease_token: leaseToken,
    });

    if (error) {
      throw new SupabasePersistenceError('No se pudo liberar el lease de sincronización.', error);
    }

    return data === true;
  }

  async recordSyncResult(
    scope: SyncLeaseScope,
    leaseToken: string,
    success: boolean,
    details?: SyncResultDetails,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('record_provider_sync_result', {
      p_provider: scope.provider,
      p_competition_external_id: scope.competitionExternalId,
      p_season: scope.season,
      p_lease_token: leaseToken,
      p_success: success,
      p_error: sanitizeSyncError(details?.error),
      p_observed_quota_remaining: details?.observedQuotaRemaining ?? null,
      p_observed_quota_window_reset_at: details?.observedQuotaWindowResetAt ?? null,
    });

    if (error) {
      throw new SupabasePersistenceError(
        'No se pudo registrar el resultado de la sincronización.',
        error,
      );
    }

    return data === true;
  }
}
