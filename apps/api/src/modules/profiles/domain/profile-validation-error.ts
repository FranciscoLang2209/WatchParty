/**
 * Motivo por el que `saveOwnProfile` rechazó un input (WAT-128).
 *
 * Distingue el rechazo de negocio de un fallo de persistencia
 * (`ProfilePersistenceError`): cualquier handler HTTP futuro (contrato
 * "posterior" de WAT-126) puede mapear esto a 400 en vez del 500 genérico
 * que le corresponde a un error de Supabase.
 */
export type ProfileValidationIssue =
  'display_name_length' | 'bio_length' | 'favorite_team_not_found';

/**
 * Rechazo de negocio de `saveOwnProfile`: formato/longitud fuera de rango,
 * o `favoriteTeamId` apuntando a un equipo que no existe.
 *
 * No es un `ProfilePersistenceError`: no hubo ningún fallo de Supabase, el
 * store decidió no intentar la escritura. El `message` es siempre texto
 * propio, pensado para poder mostrarse tal cual en una respuesta 400.
 */
export class ProfileValidationError extends Error {
  readonly issue: ProfileValidationIssue;

  constructor(issue: ProfileValidationIssue, message: string) {
    super(message);
    this.name = 'ProfileValidationError';
    this.issue = issue;
  }
}
