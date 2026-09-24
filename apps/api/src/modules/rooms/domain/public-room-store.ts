import type { PublicRoom } from './public-room.js';

/**
 * Puerto mínimo de salas públicas (WAT-146, WAT-148). No es un repositorio
 * genérico: solo expone las operaciones que este módulo necesita.
 */
export interface PublicRoomStore {
  /**
   * Devuelve la sala pública de `matchId`, creándola si todavía no existe.
   * Es idempotente: dos llamadas para el mismo partido devuelven la misma
   * sala. `null` significa que el partido no existe, y en ese caso no se
   * crea ninguna fila.
   */
  getOrCreatePublicRoom(matchId: string): Promise<PublicRoom | null>;

  /**
   * Devuelve la sala con ese `id` (WAT-148), o `null` si no existe. Solo
   * lee: nunca crea una sala.
   */
  findPublicRoomById(roomId: string): Promise<PublicRoom | null>;
}
