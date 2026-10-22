import { Shield } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { Profile, TeamOption } from '@/features/profiles/types';

interface ProfileHeaderProps {
  /** El perfil guardado, no el borrador del formulario. */
  profile: Profile;
  teams: TeamOption[];
}

/**
 * Encabezado del perfil propio (WAT-234): nombre visible, equipo favorito y
 * biografía guardados, de más a menos importante.
 *
 * Muestra solo lo que respondió la API. Un dato opcional ausente se dice tal
 * cual («Sin equipo favorito», «Sin biografía»): nunca se completa con un
 * valor inventado. Si el favorito guardado no está en la lista de equipos, no
 * hay nombre que mostrar y se trata como ausente.
 */
export function ProfileHeader({ profile, teams }: ProfileHeaderProps) {
  const favorite =
    profile.favoriteTeamId === null
      ? undefined
      : teams.find((team) => team.id === profile.favoriteTeamId);
  const bio = profile.bio.trim();

  return (
    <Card className="min-w-0 gap-3 p-4 sm:p-6">
      {/* `break-words` parte un nombre sin espacios en vez de desbordar la tarjeta. */}
      <h2 className="min-w-0 font-display text-2xl leading-tight font-semibold break-words">
        {profile.displayName}
      </h2>

      {favorite ? (
        <p className="inline-flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-sm bg-muted px-2 py-1 text-sm font-semibold">
          <Shield aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="sr-only">Equipo favorito: </span>
          <span className="min-w-0 break-words">{favorite.name}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Sin equipo favorito</p>
      )}

      {bio ? (
        // `whitespace-pre-line` respeta los saltos que la persona escribió.
        <p className="min-w-0 text-sm leading-relaxed break-words whitespace-pre-line">{bio}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Sin biografía</p>
      )}
    </Card>
  );
}
