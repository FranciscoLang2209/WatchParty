import type { RoomCommentReactionStore } from '../../comments/domain/room-comment-reaction-store.js';
import {
  BODY_MAX_LENGTH,
  type RoomCommentStore,
} from '../../comments/domain/room-comment-store.js';
import type { MatchCatalog } from '../../matches/domain/match-catalog.js';
import type { MatchRatingService } from '../../ratings/application/match-rating-service.js';
import type { MatchReviewService } from '../../reviews/application/match-review-service.js';
import { normalizeMatchReviewBody } from '../../reviews/domain/match-review-store.js';
import type { PublicRoomStore } from '../../rooms/domain/public-room-store.js';
import type { WatchedMatchStore } from '../../watched/domain/watched-match-store.js';
import { deterministicUuid } from './demo-identities.js';

/**
 * Muestra de actividad para las dos cuentas de demostración, sobre partidos terminados que ya
 * existen. No inventa nada del partido: los textos son opiniones generales que no afirman hechos
 * del juego (goles, jugadas, resultados), así que valen para cualquier partido elegido.
 *
 * Todo pasa por las mismas tiendas y servicios que usa la API, así que se cumplen sus reglas: la
 * calificación y la reseña exigen partido terminado, visto y, para la reseña, calificado.
 */

/** Conversación de la sala: el índice par es de la cuenta A y el impar, de la B. */
export const ROOM_CONVERSATION: readonly string[] = [
  '¡Buenas! ¿Quién más está viendo el partido?',
  'Acá, con el grupo. Hoy se vive distinto.',
  'Ojalá se juegue con intensidad desde el arranque.',
  'Así me gusta, que se la jueguen y no se guarden nada.',
  'Qué bien que haya una sala para comentarlo en vivo.',
  'Coincido. Después lo charlamos en la reseña.',
];

/** Los Me gusta cruzados: [índice del comentario, cuenta que reacciona (0 = A, 1 = B)]. */
const CROSS_REACTIONS: readonly (readonly [number, 0 | 1])[] = [
  [0, 1],
  [1, 0],
  [2, 1],
  [3, 0],
];

const RATINGS: readonly (readonly [number, number])[] = [
  [4, 5],
  [3, 4],
  [5, 4],
];

const REVIEWS: readonly (readonly [string, string])[] = [
  [
    'Lo vi completo y valió la pena. Me gusta poder dejar acá lo que pensé después de verlo.',
    'Un partido para recordar y compartir. Lo recomiendo si querés revivir el clima de la tribuna.',
  ],
  [
    'Lo miré con calma y me dejó para pensar. Prefiero quedarme con lo bueno del conjunto.',
    'Buena experiencia verlo acompañado: la charla en la sala suma mucho.',
  ],
  [
    'Entretenido de principio a fin. Después de verlo, me quedé con ganas de ver más partidos así.',
    'Me gustó seguirlo desde la sala y leer lo que opinaba la gente mientras tanto.',
  ],
];

export const MAX_DEMO_MATCHES = RATINGS.length;

export interface DemoActivityDeps {
  catalog: MatchCatalog;
  rooms: PublicRoomStore;
  comments: RoomCommentStore;
  reactions: RoomCommentReactionStore;
  watched: WatchedMatchStore;
  ratings: MatchRatingService;
  reviews: MatchReviewService;
}

export interface DemoActivityMatch {
  matchId: string;
  roomId: string;
  comments: number;
}

export interface SeedActivityResult {
  matches: DemoActivityMatch[];
  failures: string[];
}

/**
 * Siembra la actividad de `userIds` ([cuenta A, cuenta B]) en cada partido de `matchIds`. Repetirla
 * no duplica nada: el visto y las reacciones son idempotentes, la nota y la reseña se guardan por
 * (usuario, partido) y cada comentario lleva una clave de idempotencia determinista.
 */
export async function seedDemoActivity(
  deps: DemoActivityDeps,
  batchId: string,
  userIds: readonly [string, string],
  matchIds: readonly string[],
): Promise<SeedActivityResult> {
  const result: SeedActivityResult = { matches: [], failures: [] };

  if (matchIds.length === 0 || matchIds.length > MAX_DEMO_MATCHES) {
    result.failures.push(`Hay que elegir entre 1 y ${MAX_DEMO_MATCHES} partidos.`);
    return result;
  }

  for (const [position, matchId] of matchIds.entries()) {
    try {
      const match = await deps.catalog.findById(matchId);

      if (!match) {
        result.failures.push(`El partido ${matchId} no existe.`);
        continue;
      }

      if (match.status !== 'finished') {
        // Calificar y reseñar exige un partido terminado: no se cambia su estado para forzarlo.
        result.failures.push(`El partido ${matchId} no está finalizado (${match.status}).`);
        continue;
      }

      const room = await deps.rooms.getOrCreatePublicRoom(matchId);

      if (!room) {
        result.failures.push(`No se pudo obtener la sala del partido ${matchId}.`);
        continue;
      }

      const [ratingA, ratingB] = RATINGS[position]!;
      const [reviewA, reviewB] = REVIEWS[position]!;
      const accounts = [
        { userId: userIds[0], rating: ratingA, review: reviewA },
        { userId: userIds[1], rating: ratingB, review: reviewB },
      ] as const;

      for (const account of accounts) {
        await deps.watched.setWatched(account.userId, matchId, true);

        const rated = await deps.ratings.saveOwnRating(account.userId, matchId, account.rating);
        if (rated.kind !== 'ok') {
          result.failures.push(`Calificación de ${matchId}: ${rated.kind}.`);
          continue;
        }

        const body = normalizeMatchReviewBody(account.review);
        if (body === null) {
          result.failures.push(`La reseña de ${matchId} no es válida.`);
          continue;
        }

        const reviewed = await deps.reviews.saveOwnReview(account.userId, matchId, body);
        if (reviewed.kind !== 'ok') {
          result.failures.push(`Reseña de ${matchId}: ${reviewed.kind}.`);
        }
      }

      const commentIds: string[] = [];

      for (const [index, text] of ROOM_CONVERSATION.entries()) {
        if ([...text].length > BODY_MAX_LENGTH) {
          throw new RangeError('Un comentario de la conversación supera el largo permitido.');
        }

        const comment = await deps.comments.create(
          {
            roomId: room.id,
            body: text,
            clientRequestId: deterministicUuid(batchId, matchId, `comentario-${index}`),
          },
          userIds[index % 2]!,
        );

        if (comment) commentIds.push(comment.id);
      }

      for (const [commentIndex, reactor] of CROSS_REACTIONS) {
        const commentId = commentIds[commentIndex];
        if (!commentId) continue;

        await deps.reactions.setReaction({
          roomId: room.id,
          commentId,
          userId: userIds[reactor],
          reacted: true,
        });
      }

      result.matches.push({ matchId, roomId: room.id, comments: commentIds.length });
    } catch (error) {
      result.failures.push(
        `Partido ${matchId}: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`,
      );
    }
  }

  return result;
}
