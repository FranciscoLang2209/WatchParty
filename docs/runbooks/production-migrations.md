# Runbook: aplicar migraciones al proyecto Supabase de producción (WAT-196)

Aplica las migraciones ya versionadas en `supabase/migrations/` al proyecto remoto. No se
desarrollan migraciones, no se hace reset remoto y no se carga seed: `supabase/seed.sql` es
ficticio y solo vale para local.

## Reglas

- Se usa la CLI fijada por el repo (`pnpm exec supabase`, versión 2.101.0) con `--db-url`.
  No se ejecuta `supabase link`: no queda estado local ni `project_ref`.
- Nunca pasar `--include-seed`, `--include-roles` ni `db reset`.
- Los scripts `verify:*` de `apps/api` NO se corren contra producción: crean usuarios y
  filas de prueba. La verificación remota es solo de lectura (SQL de abajo).
- La cadena de conexión es un secreto: se exporta en la sesión, nunca se commitea ni se
  pega en tickets/PR. Debe estar percent-encoded.

## Paso 0 — Confirmar el destino (antes de escribir)

```sh
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password-encoded>@<host>:5432/postgres'
```

Comprobar que el host/ref corresponde al proyecto cuyo `SUPABASE_URL` usa la API publicada
(Vercel, `watchparty-api`). Registrar en la evidencia solo el nombre del proyecto, no la URL
completa ni la contraseña.

## Paso 1 — Estado previo

```sh
pnpm exec supabase migration list --db-url "$SUPABASE_DB_URL"
```

Esperado: 9 versiones con columna Local y Remote completas (hasta `20260913120000`) y 7 solo
en Local. Si las 9 anteriores figuran solo en Local, el historial remoto no las registra:
DETENERSE (un push intentaría reaplicarlas) y escalar.

Antes de seguir, guardar el conteo de filas de `teams`, `matches`, `profiles` y
`provider_sync_state`, y confirmar que `room_comments` aún no está en la publicación:

```sql
select count(*) from teams;  -- idem matches, profiles, provider_sync_state
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
select policyname from pg_policies where tablename = 'room_comments';
```

## Paso 2 — Simulación

```sh
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
```

Debe listar exactamente, en este orden: `20260917120000_rooms_table`,
`20260923133456_room_comments_table`, `20260923220550_room_comments_constraints`,
`20260924120000_room_comments_realtime`, `20260930120000_watched_matches`,
`20260930130759_room_comment_reactions`, `20261001205545_provider_sync_attempt_summary`.

## Paso 3 — Aplicación

```sh
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
```

Cada archivo corre en una transacción: si uno falla, ese archivo no queda a medias. Si falla,
no reintentar a ciegas: leer el error y comparar con el Paso 1.

## Paso 4 — Verificación (solo lectura)

```sh
pnpm exec supabase migration list --db-url "$SUPABASE_DB_URL"   # 16 versiones, Local = Remote
```

```sql
-- Tablas y RLS (esperado: relrowsecurity = true en las cuatro)
select relname, relrowsecurity from pg_class
 where relname in ('rooms','room_comments','watched_matches','room_comment_reactions');

-- anon/authenticated sin privilegios sobre las tablas privadas (esperado: 0 filas)
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where grantee in ('anon','authenticated')
   and table_name in ('rooms','watched_matches','room_comment_reactions');

-- Columnas legibles por authenticated en room_comments (esperado: id, room_id, body, created_at)
select column_name from information_schema.column_privileges
 where table_name = 'room_comments' and grantee = 'authenticated' and privilege_type = 'SELECT';

-- Policy de lectura (esperado: room_comments_select_authenticated, SELECT)
select policyname, cmd from pg_policies where tablename = 'room_comments';

-- Realtime (esperado: incluye room_comments)
select tablename from pg_publication_tables where pubname = 'supabase_realtime';

-- Resumen de sync: columnas, constraint y una sola firma de la función (esperado: 5 / 1 / 1 fila de 13 argumentos)
select column_name from information_schema.columns
 where table_name = 'provider_sync_state' and column_name like 'last_attempt_%_count';
select conname from pg_constraint where conname = 'provider_sync_state_attempt_counts_not_negative';
select pg_get_function_identity_arguments(oid) from pg_proc
 where proname = 'record_provider_sync_result';

-- Restricciones clave
select conname from pg_constraint
 where conname in ('rooms_match_id_key','room_comments_body_length',
                   'room_comments_author_client_request_id_key',
                   'room_comment_reactions_comment_user_key');

-- Datos conservados: repetir los conteos del Paso 1 (deben ser idénticos)
```

## Evidencia a adjuntar al ticket

Salida sanitizada de los Pasos 1, 2, 3 y 4 (sin host, contraseña ni ref), fecha/hora, quién
ejecutó, y este PR.

## Si algo falla

- `relation "room_comments" is already member of publication`: la tabla ya se había agregado
  a mano. No editar la migración; escalar al TL para decidir.
- `policy ... already exists`: ídem.
- El historial remoto no coincide con el local: no usar `--include-all` sin aprobación.

## Después de aplicar

- Actualizar los "pendiente en remoto" de `docs/runbooks/realtime-comments-validation.md` y
  `docs/decisions/realtime-comments.md`.
- Recién entonces el TL puede activar `MATCHES_SYNC_ENABLED`.
