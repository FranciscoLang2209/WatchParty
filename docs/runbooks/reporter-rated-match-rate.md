# Runbook: agregado `rated_match_rate` (WAT-220)

KPI de negocio de ADR-05 rev. 2.0: porcentaje de pares usuario–partido vistos en el mes que además tienen una nota o un comentario del mismo usuario en ese mes. Unidad `%`, valor entre 0 y 100. Esta tarea solo crea el agregado en la base: conectarlo al adaptador del reporter es WAT-222.

## Qué crea la migración

`supabase/migrations/20261022120000_reporting_rated_match_rate.sql`:

- Preparación de permisos sobre el esquema `reporting`. En producción ya existe (WAT-192, junto con `catalog_match_count`) y su dueño es `watchparty_reporter_source`, así que `postgres` no puede crear objetos ahí. La migración:
  1. crea `watchparty_reporter_source` (`NOLOGIN`) solo si no existe, para que local reproduzca el escenario de producción;
  2. le da a `postgres` membresía con `SET` y sin `INHERIT` sobre ese rol (requiere el `ADMIN` que `postgres` tiene por haberlo creado);
  3. crea el esquema con ese dueño si no existe y, actuando como dueño, le da `USAGE, CREATE` a `postgres` y revoca todo a `public`, `anon` y `authenticated`. El dueño del esquema no cambia.
- `reporting.technical_accounts (user_id)`: cuentas técnicas que se excluyen de los KPIs de negocio. Sin acceso para `anon`, `authenticated` ni el reporter.
- `reporting.rated_match_rate(cutoff timestamptz)`: `SECURITY DEFINER`, devuelve una fila `(value, omission_reason)` y nunca filas personales.
- `USAGE` sobre `reporting` y `EXECUTE` sobre el agregado para el rol `watchparty_reporter`, solo si ese rol existe (en local no). Se revoca todo a `public`, `anon` y `authenticated`.

## Cálculo

Período: desde el inicio del mes de `America/Argentina/Buenos_Aires` que contiene T hasta T inclusive.

- **Denominador:** filas de `watched_matches` con `created_at` en el período, sin cuentas técnicas. La PK garantiza un par por fila.
- **Numerador:** esos pares con una nota (`match_ratings`) creada o editada en el período, o un comentario (`room_comments` en la sala del partido) del mismo usuario en el período. Se evalúa con `EXISTS`: varios comentarios, o nota y comentario, cuentan el par una sola vez.

| Caso                       | `value` | `omission_reason` |
| -------------------------- | ------- | ----------------- |
| Hay pares vistos en el mes | 0–100   | `null`            |
| Sin pares vistos en el mes | `null`  | `no-denominator`  |
| Corte T nulo o futuro      | `null`  | `invalid-cutoff`  |

Nunca devuelve un cero inventado: sin denominador se omite con motivo.

## Marcar una cuenta técnica

Con un rol privilegiado (SQL editor o `psql` como `postgres`), nunca desde la web ni con el rol del reporter:

```sql
insert into reporting.technical_accounts (user_id) values ('<uuid del usuario>');
```

## Verificación local

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @watchparty/api verify:rated-match-rate
```

Corre todo en una transacción que se revierte, con datos sintéticos en marzo de 2020, y solo acepta un host local. Comprueba el cálculo conocido (2/5 = 40 %), los límites del mes argentino y de T, los duplicados, la exclusión técnica, el denominador vacío, el corte futuro y que un rol con solo `USAGE` y `EXECUTE` obtiene el agregado pero no puede leer las tablas que lo alimentan. No se corre contra producción.
