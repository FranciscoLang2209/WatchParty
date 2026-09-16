# Módulo de perfiles (profiles)

Frente WAT-116: puerto mínimo de perfil y equipos, implementado a través
del cliente servidor de WAT-106. No introduce ORM, repositorios genéricos
ni acceso Supabase desde `apps/web`.

## Modelo canónico

`domain/profile.ts` define `Profile` (sin `userId` ni timestamps) y
`domain/team-option.ts` define `TeamOption`, la proyección mínima de
`teams` que necesita el selector de favorito.

## Un solo puerto: `OwnProfileStore` (WAT-126)

```ts
interface OwnProfileStore {
  getOwnProfile(userId: string): Promise<Profile | null>;
  saveOwnProfile(userId: string, input: SaveOwnProfileInput): Promise<Profile>;
  listTeams(): Promise<TeamOption[]>;
}
```

A diferencia de `matches` (que separa `MatchCatalog`/`MatchStore` porque
tiene un worker de sincronización con necesidades de escritura mucho más
amplias), acá alcanza un único puerto angosto: no hay más operaciones que
las tres que este módulo necesita.

`domain/own-profile-store.ts` también documenta los límites de `Profile`
(`DISPLAY_NAME_MIN_LENGTH`/`MAX_LENGTH`, `BIO_MAX_LENGTH`) que replica la
migración `20260912160809_profiles_constraints.sql`. No se importan desde
`apps/web`: cada runtime declara los suyos (ver
`apps/web/src/features/profiles/types.ts`) y las pruebas de cada lado
protegen que no se desvíen.

## Implementación real: `SupabaseOwnProfileStore` (WAT-127 lecturas, WAT-128 escritura)

No hay un cliente propio de este módulo: `SupabaseOwnProfileStore` recibe
el `SupabaseClient` por constructor (inyección de dependencias). Quien lo
componga debe reutilizar directamente `createSupabaseSportsDataClient`
(`modules/matches/infrastructure/supabase-sports-data-client.ts`,
WAT-106) — no se duplica el factory. El nombre es específico de `matches`
pero el cliente es genérico (service_role, sin sesión): no hace falta una
instancia por módulo.

`infrastructure/supabase-own-profile-store.ts`:

- `getOwnProfile()`/`listTeams()`: `select` proyectado (nunca `*`) sobre
  `profiles`/`teams`. La ausencia de fila en `getOwnProfile` devuelve
  `null`, no es un error. `listTeams` ordena por `name` y, ante empate,
  por `id`, para que el orden sea determinista entre corridas.
- `saveOwnProfile()`: valida `displayName`/`bio` en código (recorte y
  longitud) y, si `favoriteTeamId` no es `null`, primero valida su
  formato UUID (`UUID_PATTERN`, sin consultar la base) y recién después
  comprueba que exista en `teams` — rechaza con `ProfileValidationError`
  sin tocar la base ante cualquiera de los dos fallos. Si todo pasa, un
  único `upsert` por `user_id` crea o actualiza el perfil. Las
  constraints de `20260912160809_profiles_constraints.sql` quedan como
  defensa final, no como la única.

## `ProfilePersistenceError` y `ProfileValidationError`

Dos motivos de fallo, deliberadamente distintos:

- `ProfilePersistenceError` (`infrastructure/profile-persistence-error.ts`):
  Supabase/Postgres devolvió un error. Mismo criterio que
  `SupabasePersistenceError` de `matches` — `message` es siempre texto
  propio, el error crudo solo queda en `.cause` para logging de servidor.
  Redefinida acá (no importada de `matches`) para no acoplar los dos
  módulos.
- `ProfileValidationError` (`domain/profile-validation-error.ts`): el
  store decidió no intentar la escritura porque `input` no es válido —
  incluye tanto límites de formato/longitud como un `favoriteTeamId` con
  formato inválido o inexistente. Un handler HTTP futuro puede mapear
  esto a 400, y a `ProfilePersistenceError` a 500 — la distinción existe
  para que ese mapeo sea posible sin inspeccionar el error de Supabase.

## Fuera de alcance de WAT-126/127/128

El contrato HTTP (`GET /me/profile`, `GET /teams`, `PUT /me/profile`) es
"posterior": ningún router ni handler de este módulo existe todavía, y
`OwnProfileStore` no está compuesto en `app.ts`/`server.ts`. `apps/web` ya
tiene su propio cliente HTTP (`features/profiles/api.ts`) escrito contra
ese contrato, a la espera del módulo HTTP real.
