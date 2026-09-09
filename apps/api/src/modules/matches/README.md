# Módulo de partidos (matches)

## Modelo canónico

`domain/match.ts` define `Match` y `MatchStatus`: el único modelo de partido
que debe usarse en todo el módulo (handlers HTTP incluidos).

## Puerto `MatchCatalog`

`domain/match-catalog.ts` define el puerto asíncrono que exponen todos los
catálogos de partidos:

```ts
interface MatchCatalog {
  list(): Promise<readonly Match[]>;
  findById(id: string): Promise<Match | null>;
}
```

Los consumidores HTTP dependen únicamente de este puerto, nunca de una
implementación concreta.

## Implementación real: `SupabaseMatchCatalog` (WAT-106)

`infrastructure/supabase-match-catalog.ts` implementa `MatchCatalog`
delegando en `SupabaseMatchStore`. Es la implementación que compone
`server.ts` para el proceso real: nunca hay un fallback automático a
`LocalMatchCatalog` si falta configuración de Supabase (`env.ts` falla
rápido y explícito en ese caso).

## Puerto `MatchStore`

`domain/match-store.ts` define un segundo puerto, más amplio que
`MatchCatalog`: además de `list`/`findById`, expone `upsertFixture`
(idempotente por `(provider, externalId)`) y el ciclo de vida del lease de
sincronización (`acquireSyncLease`/`reclaimExpiredSyncLease`/
`releaseSyncLease`/`recordSyncResult`, sobre las funciones SQL de
WAT-103). Los handlers HTTP no lo conocen: es el puerto que va a consumir
WAT-107 para importar fixtures, usando exclusivamente estas operaciones.

`infrastructure/supabase-match-store.ts` implementa este puerto, pero
delega los 4 métodos de lease en `infrastructure/supabase-sync-lease-store.ts`:
`provider_sync_state` no comparte ninguna FK con `teams`/`matches`, así que
separamos esa responsabilidad en su propia clase en vez de mezclarla con el
upsert de equipos/partidos (que sí están acoplados por FK). `MatchStore`
sigue siendo una única interfaz para quien la consuma.

Ninguna de las dos clases atrapa un error de Supabase para sustituirlo por
datos ficticios: lo envuelven en `SupabasePersistenceError` y lo dejan
propagar, para que el `errorHandler` global lo traduzca a un 500.

`domain/normalized-match-fixture.ts` define el DTO de entrada a
`upsertFixture`: un fixture normalizado, independiente de cualquier
proveedor externo (distinto del DTO específico de API-Football de WAT-105 en
`application/normalized-sports-fixture.ts`).

## `LocalMatchCatalog`: doble explícito, no fallback

`infrastructure/local-match-catalog.ts` sigue existiendo con datos
embebidos en memoria, pero solo como doble para tests o desarrollo sin
Supabase levantado (se inyecta a propósito, por ejemplo en `app.test.ts`).
`createApp` (en `app.ts`) es una factory que recibe cualquier
`MatchCatalog` por parámetro: no decide por sí misma cuál usar, así que
nunca cae en `LocalMatchCatalog` de forma automática.

## Fuera de alcance de este módulo (por ahora)

Importación real de fixtures desde un proveedor externo (WAT-107), datos en
vivo y funcionalidades sociales.
