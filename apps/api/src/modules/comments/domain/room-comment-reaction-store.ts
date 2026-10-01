/**
 * Estado de "Me gusta" de un comentario, visto por un usuario concreto
 * (WAT-175). No expone `userId`, ids de fila ni ningún detalle de
 * `room_comment_reactions` — mismo criterio que `RoomComment`.
 */
export interface RoomCommentReactionState {
  /** Total de Me gusta del comentario, sumando a todos los usuarios. */
  count: number;
  /** Si el usuario que consulta tiene su Me gusta puesto. */
  reacted: boolean;
}

/**
 * Input de `setReaction`. `userId` NUNCA lo controla el cliente: viene
 * siempre del usuario autenticado, igual que `authorId` en
 * `RoomCommentStore.create`.
 */
export interface SetRoomCommentReactionInput {
  roomId: string;
  commentId: string;
  userId: string;
  /** Estado deseado: `true` marca el Me gusta, `false` lo quita. */
  reacted: boolean;
}

/**
 * Puerto de reacciones "Me gusta" a comentarios de sala (WAT-175), sobre
 * `room_comment_reactions` (WAT-165: UNIQUE en `(comment_id, user_id)`).
 *
 * Es el único tipo de reacción del MVP, por eso no hay parámetro de emoji.
 */
export interface RoomCommentReactionStore {
  /**
   * Fija el estado de reacción de `userId` sobre un comentario de `roomId` y
   * devuelve el estado resultante.
   *
   * - Idempotente: marcar dos veces deja una sola fila; desmarcar sin fila
   *   previa no falla. Se pide el estado deseado (no "alternar") para que un
   *   reintento no revierta la acción anterior.
   * - Solo toca la fila de `userId`: nunca altera la reacción de otro usuario.
   * - Devuelve `null` si la sala o el comentario no existen, o si el
   *   comentario no pertenece a `roomId` (incluye ids con formato inválido).
   *   En ese caso no muta ningún dato.
   * - Lanza `RoomCommentPersistenceError` ante cualquier otro fallo de base.
   *
   * Limitación conocida: si el comentario se borrara entre la verificación y
   * la inserción, la base rechaza la fila por clave foránea y el error sale
   * como `RoomCommentPersistenceError`, no como `null`. Hoy `room_comments`
   * no se borra desde la API, así que no se maneja; revisar este caso si se
   * agrega el borrado de comentarios.
   */
  setReaction(input: SetRoomCommentReactionInput): Promise<RoomCommentReactionState | null>;
}
