/**
 * Perfil propio de un usuario (WAT-126).
 *
 * Contrato público del módulo: sin `userId`, timestamps, ni ningún detalle
 * de la tabla `profiles` o de Supabase. `userId` no forma parte del tipo a
 * propósito — es siempre un parámetro explícito de `OwnProfileStore`, nunca
 * un campo que un caller pueda leer o (peor) sobreescribir en un `save`.
 */
export interface Profile {
  displayName: string;
  bio: string;
  /** `null` significa "sin equipo favorito"; también es lo que lo quita al guardar. */
  favoriteTeamId: string | null;
}
