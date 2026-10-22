# Runbook: agregado `monthly_interactions_avg` (WAT-221)

KPI de negocio de ADR-05 rev. 2.0: promedio de interacciones (notas y comentarios) por usuario activo en el mes. Unidad `{interaction}/{user}`, admite decimales. Esta tarea solo crea el agregado en la base: conectarlo al adaptador del reporter es WAT-222.

## Qué crea la migración

`supabase/migrations/20261022140000_reporting_monthly_interactions_avg.sql`:

- `reporting.monthly_interactions_avg(cutoff timestamptz)`: `SECURITY DEFINER`, devuelve una fila `(value, omission_reason)` y nunca filas personales.
- `EXECUTE` para `watchparty_reporter`, solo si ese rol existe (en local no). Se revoca todo a `public`, `anon` y `authenticated`.

Reutiliza lo que preparó WAT-220 ([reporter-rated-match-rate.md](reporter-rated-match-rate.md)): los permisos de `postgres` sobre el esquema `reporting`, el `USAGE` del reporter y la tabla `reporting.technical_accounts`.

## Cálculo

Período: desde el inicio del mes de `America/Argentina/Buenos_Aires` que contiene T hasta T inclusive.

- **Numerador:** notas (`match_ratings`) y comentarios (`room_comments`) con `created_at` en el período. Editar una nota cambia `updated_at`, no crea un registro, así que no suma. Las reacciones no son interacciones. Cada tabla se cuenta por separado, sin joins.
- **Denominador:** usuarios distintos con un visto, una nota o un comentario registrado en el período. Quien solo marcó vistos es activo y aporta cero.
- Las cuentas técnicas se excluyen de las tres fuentes.

| Caso                  | `value`      | `omission_reason` |
| --------------------- | ------------ | ----------------- |
| Hay usuarios activos  | ≥ 0, decimal | `null`            |
| Sin usuarios activos  | `null`       | `no-denominator`  |
| Corte T nulo o futuro | `null`       | `invalid-cutoff`  |

Nunca publica un cero inventado: sin denominador se omite con motivo. Un cero con usuarios activos es un valor real.

## Verificación local

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @watchparty/api verify:monthly-interactions-avg
```

Corre todo en una transacción que se revierte, con datos sintéticos, y solo acepta un host local. Comprueba el cálculo conocido (4/3), los límites del mes argentino y de T, que una edición y una reacción no suman, el usuario activo solo por visto, la exclusión técnica, el denominador vacío, el corte futuro y que un rol con solo `USAGE` y `EXECUTE` obtiene el agregado pero no puede leer las tablas que lo alimentan. No se corre contra producción.
