import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatKickoff, matchStatusLabel } from '@/features/matches/format';
import type { Match } from '@/features/matches/types';
import { enterRoom } from '@/features/rooms/api';
import { RoomsApiError, isCancelled } from '@/features/rooms/types';
import { cn } from '@/lib/utils';

export interface FavoriteRoomCardProps {
  /** El partido ya resuelto: la tarjeta no decide cuál es ni lo consulta. */
  match: Match;
  accessToken: string;
  /**
   * Se dispara si entrar a la sala falla por sesión vencida. La tarjeta no
   * sabe nada del flujo de Auth: quien la monta decide qué hacer. Sin esta
   * prop, el mensaje se muestra igual, pero sin botón de reingreso.
   */
  onSessionExpired?: () => void;
}

interface ErrorSala {
  message: string;
  expired: boolean;
}

const MENSAJE_INESPERADO = 'No pudimos abrir la sala. Intentá de nuevo.';

function toErrorSala(error: unknown): ErrorSala {
  if (error instanceof RoomsApiError) {
    return { message: error.message, expired: error.kind === 'unauthorized' };
  }

  return { message: MENSAJE_INESPERADO, expired: false };
}

/**
 * Tarjeta de la sala del partido del equipo favorito.
 *
 * Recibe todo resuelto por props y no consulta perfil, equipos ni catálogo. Lo
 * único que pide es la entrada a la sala, y sólo cuando la persona lo elige:
 * navega recién con la sala que devuelve el servidor.
 *
 * No usa `CardTitle` a propósito: ese primitive renderiza un `<h1>` y la Home
 * debe conservar uno solo.
 */
export function FavoriteRoomCard({ match, accessToken, onSessionExpired }: FavoriteRoomCardProps) {
  const navigate = useNavigate();
  const [entrando, setEntrando] = useState(false);
  const [errorSala, setErrorSala] = useState<ErrorSala | null>(null);
  const salaController = useRef<AbortController | null>(null);

  // Un pedido en curso se cancela al salir: su respuesta ya no le sirve a nadie.
  useEffect(() => () => salaController.current?.abort(), []);

  const entrarALaSala = useCallback(() => {
    const controller = new AbortController();
    salaController.current = controller;
    setEntrando(true);
    setErrorSala(null);

    enterRoom(match.id, accessToken, controller.signal)
      .then((sala) => {
        navigate(`/rooms/${encodeURIComponent(sala.id)}`);
      })
      .catch((error: unknown) => {
        if (isCancelled(error)) return;

        setErrorSala(toErrorSala(error));
        setEntrando(false);
      });
  }, [match.id, accessToken, navigate]);

  const enVivo = match.status === 'live';
  const partido = `${match.homeTeam} vs. ${match.awayTeam}`;

  return (
    <Card className="gap-3 p-4">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Tu equipo favorito
      </p>

      {/* `min-w-0` y el quiebre de palabra evitan que un nombre largo desborde. */}
      <h2 className="min-w-0 text-lg leading-snug font-semibold break-words">
        {match.homeTeam} <span className="text-muted-foreground">vs.</span> {match.awayTeam}
      </h2>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 text-sm text-muted-foreground">{formatKickoff(match.kickoffAt)}</p>

        <span
          className={cn(
            'rounded-sm px-2 py-1 text-xs font-semibold',
            // El rojo del sistema se reserva para LIVE; el resto usa el fondo sutil.
            enVivo ? 'bg-live/10 text-live' : 'bg-muted text-muted-foreground',
          )}
        >
          {matchStatusLabel(match.status)}
        </span>
      </div>

      <Button
        type="button"
        className="self-start"
        disabled={entrando}
        aria-busy={entrando}
        aria-label={`Entrar a la sala del partido: ${partido}`}
        onClick={entrarALaSala}
      >
        Entrar a la sala
      </Button>

      {errorSala ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">{errorSala.message}</p>

          {errorSala.expired && onSessionExpired ? (
            <Button type="button" onClick={onSessionExpired}>
              Iniciar sesión nuevamente
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
