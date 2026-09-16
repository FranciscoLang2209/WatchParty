/**
 * Un equipo elegible como favorito (WAT-126).
 *
 * Proyección mínima de `teams`: solo lo que necesita el selector de
 * favorito. El resto de la fila (`provider`, `external_id`, timestamps)
 * queda en el backend — `listTeams` nunca lo expone.
 */
export interface TeamOption {
  id: string;
  name: string;
}
