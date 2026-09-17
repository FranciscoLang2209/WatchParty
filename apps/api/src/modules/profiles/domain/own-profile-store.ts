import type { Profile } from './profile.js';
import type { TeamOption } from './team-option.js';

/**
 * Límites de `Profile`, documentados acá (WAT-126) para que WAT-128
 * (`saveOwnProfile`, validación en código) y WAT-130/133 (formulario web)
 * los repliquen sin tener que leer la migración de constraints
 * (`20260912160809_profiles_constraints.sql`). No se importan entre
 * `apps/web` y `apps/api` — cada runtime declara los suyos y las pruebas de
 * cada lado protegen que no se desvíen, mismo criterio que ya usa
 * `apps/web/src/features/profiles/types.ts`.
 *
 * `displayName` se acepta recortado (trim) de 1 a 50 caracteres tras el
 * recorte; `bio` no se recorta, hasta 280 caracteres tal cual se recibe.
 */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const BIO_MAX_LENGTH = 280;

// Formato canónico de UUID (el mismo que genera gen_random_uuid() en
// Postgres). Compartido entre la validación de formato en el handler HTTP
// (WAT-130, antes de tocar el store) y la implementación real del store
// (WAT-128, que además confirma existencia contra la base).
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que acepta `saveOwnProfile`. Misma forma que `Profile`, distinto propósito. */
export interface SaveOwnProfileInput {
  displayName: string;
  bio: string;
  favoriteTeamId: string | null;
}

/**
 * Puerto mínimo de perfil y equipos (WAT-116/WAT-126).
 *
 * Único contrato que deben cumplir los handlers HTTP futuros (fuera de
 * alcance de WAT-126/127/128) y cualquier implementación (Supabase real,
 * doble de test). No es un repositorio genérico: solo expone las tres
 * operaciones que este módulo necesita.
 *
 * Contrato HTTP posterior (no implementado por este puerto):
 * `GET /me/profile` → `{ profile: Profile | null }`,
 * `GET /teams` → `{ teams: TeamOption[] }`,
 * `PUT /me/profile` → `{ profile: Profile }`.
 */
export interface OwnProfileStore {
  /**
   * Perfil propio de `userId`. `null` significa que la persona todavía no
   * guardó ningún perfil — no es un error ni equivale a "no encontrado".
   */
  getOwnProfile(userId: string): Promise<Profile | null>;

  /**
   * Crea o actualiza el perfil de `userId` (upsert por `user_id`) y
   * devuelve el `Profile` persistido. Rechaza con `ProfileValidationError`
   * si `input` no respeta los límites de arriba o si `favoriteTeamId` no
   * es `null` y no corresponde a un equipo existente.
   */
  saveOwnProfile(userId: string, input: SaveOwnProfileInput): Promise<Profile>;

  /** Equipos elegibles como favorito, ordenados por nombre de forma determinista. */
  listTeams(): Promise<TeamOption[]>;
}
