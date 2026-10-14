// Mismo patrón que UUID_PATTERN en modules/comments/domain/room-comment-store.ts.
// Se define acá para no acoplar `watched` al dominio de otro módulo; lo
// comparten los handlers de lectura y de marcado.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
