/**
 * Espejo del contrato público del módulo `profiles` de la Node API (WAT-126).
 *
 * La web no comparte DTO ni importa runtime del servidor: replica los tipos y
 * las pruebas protegen que no se desvíen, igual que en `features/matches`.
 */

/**
 * Límites del backend, replicados para validar antes de pedir.
 *
 * El nombre visible es obligatorio (1–50) y la biografía es opcional (0–280).
 * Los comparte el formulario de WAT-133: no se vuelven a escribir en la UI.
 */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const BIO_MAX_LENGTH = 280;

/** Los tres campos del perfil. Sin `userId` ni timestamps: son internos. */
export interface Profile {
  displayName: string;
  bio: string;
  /** `null` significa «sin equipo favorito», y es lo que lo quita al guardar. */
  favoriteTeamId: string | null;
}

/** Lo que se manda al guardar. Misma forma que `Profile`, distinto propósito. */
export type ProfileInput = Profile;

/** Un equipo elegible como favorito. El resto de la fila queda en el backend. */
export interface TeamOption {
  id: string;
  name: string;
}

/**
 * La API envuelve sus respuestas.
 *
 * `profile: null` es una respuesta válida y esperada: la persona todavía no
 * completó su perfil. **No es un error ni un 404**, y las pantallas no pueden
 * confundirlo con uno.
 */
export interface ProfileEnvelope {
  profile: Profile | null;
}

export interface TeamsEnvelope {
  teams: TeamOption[];
}

/**
 * Motivo por el que falló una consulta.
 *
 * `cancelled` nunca se le muestra a la persona, `unauthorized` reingresa por el
 * flujo de Auth, e `invalid` es el 400 que devuelve el backend cuando el nombre
 * o la biografía no respetan sus límites.
 */
export type ProfilesErrorKind =
  'network' | 'unauthorized' | 'not-found' | 'invalid' | 'server' | 'cancelled';

export class ProfilesApiError extends Error {
  readonly kind: ProfilesErrorKind;

  constructor(kind: ProfilesErrorKind, message: string) {
    super(message);
    this.name = 'ProfilesApiError';
    this.kind = kind;
  }
}

/** Una consulta cancelada no es un fallo: no se anuncia ni se reintenta. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ProfilesApiError && error.kind === 'cancelled';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ProfilesApiError && error.kind === 'unauthorized';
}
