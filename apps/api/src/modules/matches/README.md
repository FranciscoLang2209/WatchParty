# Módulo de partidos (matches)

## Modelo canónico

`domain/match.ts` define `Match` y `MatchStatus`: el único modelo de partido
que debe usarse en todo el módulo (handlers HTTP incluidos).

## Dos puertos: `MatchCatalog` y `MatchStore`

`domain/match-catalog.ts` define el puerto angosto que consumen los
handlers HTTP:

```ts
interface MatchCatalog {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;
}
```

`domain/match-store.ts` define un puerto más amplio, pensado para el
worker de sincronización (WAT-107): además de leer, sabe escribir un
fixture completo y gestionar el ciclo de vida del lease de sincronización
por proveedor/competición/temporada:

```ts
interface MatchStore {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;
  upsertFixture(fixture: NormalizedMatchFixture): Promise<string>;
  acquireSyncLease(
    scope: SyncLeaseScope,
    owner: string,
    leaseDurationSeconds?: number,
  ): Promise<string | null>;
  reclaimExpiredSyncLease(scope: SyncLeaseScope): Promise<boolean>;
  releaseSyncLease(scope: SyncLeaseScope, leaseToken: string): Promise<boolean>;
  recordSyncResult(
    scope: SyncLeaseScope,
    leaseToken: string,
    success: boolean,
    details?: SyncResultDetails,
  ): Promise<boolean>;
}
```

Es Interface Segregation a propósito: los handlers HTTP dependen solo de
`MatchCatalog` y nunca se enteran de que existen operaciones de escritura.
WAT-107 va a depender de `MatchStore`, nunca al revés.

## Implementación real: `SupabaseMatchCatalog` + `SupabaseMatchStore` (WAT-106)

`infrastructure/supabase-match-catalog.ts` es un adaptador angosto:
implementa `MatchCatalog` delegando `list()`/`findById()` directamente en un
`MatchStore` inyectado, sin lógica propia.

`infrastructure/supabase-match-store.ts` es la implementación real de
`MatchStore` contra Supabase/Postgres:

- `list()`/`findById()`: `select` sobre `matches` con los equipos embebidos
  vía relación de PostgREST (`teams!matches_home_team_id_fkey`/
  `teams!matches_away_team_id_fkey`, con hint explícito porque hay dos FKs a
  `teams`).
- `upsertFixture()`: una única llamada a la función de Postgres
  `upsert_match_fixture` (`supabase/migrations/20260910120000_upsert_match_fixture_function.sql`).
  Equipos y partido se guardan dentro de la misma transacción de la base:
  si el partido es inválido (por ejemplo, mismo equipo local y visitante),
  Postgres revierte también los upserts de equipos que la función haya
  hecho antes de fallar. Antes de este fix, cada upsert (equipo local,
  equipo visitante, partido) era una llamada HTTP independiente, así que un
  partido inválido podía dejar equipos ya guardados — ver el fix de
  atomicidad correspondiente.
- `acquireSyncLease`/`reclaimExpiredSyncLease`/`releaseSyncLease`/
  `recordSyncResult`: delegados por completo en
  `infrastructure/supabase-sync-lease-store.ts` (`SupabaseSyncLeaseStore`),
  que llama a las 4 funciones RPC de WAT-103 sobre `provider_sync_state`.
  Está separado de `SupabaseMatchStore` porque son tablas y ciclos de vida
  independientes: `teams`/`matches` no tienen relación con el lease.

## `SupabasePersistenceError`

`infrastructure/supabase-persistence-error.ts` es la única clase de error
que lanzan `SupabaseMatchStore` y `SupabaseSyncLeaseStore`. Su `message` lo
escribe siempre el código (nunca interpola el error crudo de Postgres); el
error original queda en `.cause` (`Error` con `{ cause }`, ES2022) solo para
logging de servidor. El `errorHandler` global lo traduce a un 500 genérico
sin filtrar detalles internos. Ningún método de `SupabaseMatchStore` atrapa
un error de Supabase para sustituirlo por `[]`, `null` ni `LocalMatchCatalog`.

## `NormalizedMatchFixture` (domain/normalized-match-fixture.ts)

DTO de entrada de `upsertFixture()`, distinto del `NormalizedSportsFixture`
de WAT-105 (ese es específico de la forma de la API del proveedor externo,
con IDs numéricos). `NormalizedMatchFixture` habla el idioma de las tablas
(IDs externos como texto) y reutiliza `MatchStatus` del dominio en vez de
duplicar el enum de estados. WAT-107 va a traducir su propio DTO a este
antes de llamar a `upsertFixture`.

## `LocalMatchCatalog`: doble de test explícito, nunca fallback automático

`infrastructure/local-match-catalog.ts` sigue existiendo, pero ya no es la
implementación real: es un doble explícito, usado solo donde se lo inyecta
a mano (por ejemplo en `app.test.ts`, vía `createApp(new LocalMatchCatalog())`).
`server.ts` (composition root) siempre compone `SupabaseMatchCatalog` sobre
`SupabaseMatchStore`. Si falta `SUPABASE_SERVICE_ROLE_KEY` (o cualquier otra
variable requerida), `env.ts` explota al importarse — no hay try/catch que
caiga de vuelta a `LocalMatchCatalog`.

## Fuera de alcance de este módulo (por ahora)

Autenticación, proveedor deportivo real (sincronización automática —
WAT-107, que va a consumir `MatchStore`), datos en vivo y funcionalidades
sociales.
