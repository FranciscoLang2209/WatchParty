import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { postComment } from './api';
import {
  BODY_MAX_LENGTH,
  BODY_MIN_LENGTH,
  CommentsApiError,
  isCancelled,
  type RoomComment,
} from './types';

export interface CommentFormProps {
  roomId: string;
  accessToken: string;
  /** Se llama con el comentario que devuelve el servidor, ya creado. */
  onCommentCreated: (comment: RoomComment) => void;
}

const MENSAJE_VACIO = 'Escribí algo antes de enviar.';
const MENSAJE_INESPERADO = 'No pudimos publicar el comentario. Intentá de nuevo.';

/**
 * Formulario para comentar en una sala (WAT-153).
 *
 * A diferencia de `ProfileFields`, este componente sí llama a la API: la
 * lógica de reintento idempotente (mismo `clientRequestId` mientras no se
 * edite el texto, ver `features/comments/api.ts`) sólo tiene sentido en el
 * momento exacto del envío, y partirla entre este componente y un padre
 * sería más confuso que útil.
 */
export function CommentForm({ roomId, accessToken, onCommentCreated }: CommentFormProps) {
  const fieldId = useId();
  const counterId = useId();
  const errorId = useId();

  const [body, setBody] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se genera una sola vez por intento de envío. Si el POST falla y el
  // usuario reintenta sin tocar el texto, se reusa el mismo id: así, si el
  // primer intento en realidad sí se había guardado en el servidor (la
  // respuesta se perdió por la red, no el pedido), el reintento no crea un
  // comentario duplicado. Editar el texto lo descarta: a partir de ahí ya
  // es un comentario distinto.

  const clientRequestIdRef = useRef<string | null>(null);

  function handleBodyChange(value: string) {
    setBody(value);
    clientRequestIdRef.current = null;
    if (error !== null) setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (enviando) return;

    const trimmed = body.trim();

    if (trimmed.length < BODY_MIN_LENGTH) {
      setError(MENSAJE_VACIO);
      return;
    }

    setError(null);
    setEnviando(true);

    const clientRequestId = clientRequestIdRef.current ?? crypto.randomUUID();
    clientRequestIdRef.current = clientRequestId;

    try {
      const comentario = await postComment(roomId, { body: trimmed, clientRequestId }, accessToken);

      // Recién acá se limpia el borrador: un fallo lo conserva para que la
      // persona pueda corregir o reintentar sin volver a escribir todo.
      setBody('');
      clientRequestIdRef.current = null;
      onCommentCreated(comentario);
    } catch (caught) {
      if (isCancelled(caught)) return;

      setError(caught instanceof CommentsApiError ? caught.message : MENSAJE_INESPERADO);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      className="flex w-full min-w-0 flex-col gap-2"
      onSubmit={handleSubmit}
      aria-busy={enviando}
      noValidate
    >
      <Label htmlFor={fieldId}>Comentario</Label>

      <Textarea
        id={fieldId}
        value={body}
        maxLength={BODY_MAX_LENGTH}
        disabled={enviando}
        placeholder="Comentá la jugada…"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? `${counterId} ${errorId}` : counterId}
        onChange={(event) => handleBodyChange(event.target.value)}
      />

      <p id={counterId} className="self-end text-xs text-muted-foreground">
        {body.length}/{BODY_MAX_LENGTH}
      </p>

      {error !== null ? (
        <p
          id={errorId}
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={enviando} className="self-end">
        {enviando ? 'Enviando…' : 'Comentar'}
      </Button>
    </form>
  );
}
