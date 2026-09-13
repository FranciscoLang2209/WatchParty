# Runbook: validación de una sincronización real mínima (WAT-108 / B1.4)

## Propósito y alcance

Este runbook valida, con **una única importación real y mínima**, que la cadena completa `matches:sync` → API-Football real → Supabase funciona de punta a punta: adquisición de lease, reserva de cuota persistente, normalización, y persistencia idempotente de equipos y partidos.

No agrega infraestructura nueva (sin cron, sin polling, sin worker, sin cola, sin endpoint) y no cambia de proveedor ni de plan. No repite la importación más de una vez para juntar evidencia — una sola corrida real alcanza. La importación de planteles y estadísticas queda fuera de este runbook.

## Variables requeridas (sin valores)

En `apps/api/.env` (nunca comiteado):

- `API_FOOTBALL_BASE_URL`
- `API_FOOTBALL_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `WEB_ORIGIN`
- `SUPABASE_SERVICE_ROLE_KEY`

Las dos primeras las carga exclusivamente `matches:sync`; el resto ya las requiere el resto de la API para arrancar.

## Base de datos: local (Docker), nunca producción

Esta validación corre contra el Supabase **local** de Docker — nunca contra un proyecto remoto ni de producción.

```sh
pnpm supabase:start
pnpm exec supabase db reset --local
pnpm supabase:status
```

`db reset --local` reaplica todas las migraciones (incluyendo el ledger de cuota y el upsert con flag insert/update de WAT-106) y el seed sobre el contenedor local. `supabase:status` imprime, entre otras cosas, la URL local de Supabase Studio — se usa más abajo para verificar lo persistido.

## Competición, temporada y ventana aprobadas (B1.1)

Documentadas en [`docs/integrations/api-football-coverage.md`](../integrations/api-football-coverage.md) y hardcodeadas como default en `application/sync-matches.ts`:

- Competición: Liga Profesional Argentina, ID externo `128`.
- Temporada: `2023`.
- Ventana: `2023-03-01` a `2023-03-14`.

Esta validación usa esos valores tal cual — no se editan ni se pasan por variable de entorno.

## Comando exacto

```sh
pnpm --filter @watchparty/api matches:sync
```

## Códigos de salida esperados

| Código | Significado                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| `0`    | Ejecución completa, sin errores de página ni de persistencia.                                                         |
| `1`    | Ejecución parcial: cuota agotada, error de proveedor o error de persistencia. No borra ni reemplaza datos existentes. |
| `2`    | Configuración inválida o no se pudo adquirir el lease de sincronización.                                              |

## Formato del resumen impreso

```json
{
  "importados": 0,
  "actualizados": 0,
  "omitidos": [],
  "errores": [],
  "consultasRealizadas": 0,
  "consultasReservadas": 0,
  "presupuestoRestante": 0
}
```

Ver [`docs/runbooks/matches-sync-command.md`](matches-sync-command.md) para el detalle de cada campo.

## Cómo consultar lo persistido

Con `pnpm supabase:status` corriendo, abrí la URL de **Studio** que imprime (local, `http://127.0.0.1:<puerto>` por defecto) → **SQL Editor**, y corré:

```sql
select provider, external_id, home_team_id, away_team_id, kickoff_at, status
from matches
where provider = 'api-football'
order by created_at desc
limit 5;

select provider, external_id, name
from teams
where provider = 'api-football'
order by created_at desc
limit 5;

select provider, competition_external_id, season, lease_owner, lease_token, last_success_at
from provider_sync_state
where provider = 'api-football';

select provider, quota_date, reserved_count
from provider_quota_ledger
where provider = 'api-football'
order by quota_date desc;
```

No hace falta interpretar código: son consultas de lectura directas sobre las tablas que ya crearon WAT-103/WAT-106.

## Cómo distinguir la evidencia

Esta validación junta tres tipos de evidencia distintos; la sección "Evidencia de la ejecución real" de más abajo los separa explícitamente:

1. **Pruebas con mocks/dobles falsos** — ya cubiertas por las suites de WAT-105/WAT-106/WAT-107 (`pnpm --filter @watchparty/api test`), nunca hacen una llamada de red real ni tocan Supabase real.
2. **Respuesta real de API-Football** — la única llamada real de este runbook, ejecutada una sola vez en la sección siguiente.
3. **Verificación de datos persistidos** — lectura directa en el Supabase **local** después de la corrida real, con las consultas de la sección anterior.

## Cómo repetir la validación respetando la cuota

`matches:sync` reserva cuota diaria persistente (UTC) antes de cada llamada — repetir esta validación el mismo día consume presupuesto real de la cuenta. Antes de repetir:

- Verificar el presupuesto restante consultando `provider_quota_ledger` (consulta de arriba) en vez de correr el comando "para ver qué pasa".
- Si hace falta repetir por un bloqueo (no por curiosidad), esperar al día siguiente (UTC) o confirmar que queda presupuesto suficiente.
- Nunca correr el comando en un loop ni más de una vez en la misma corrida de validación.

## Si la cuenta o la cobertura bloquea la ejecución

Si `matches:sync` no puede completarse por causas del proveedor (cuenta sin acceso, cobertura no disponible, cuota ya agotada por otra causa), documentar en la sección de evidencia:

- el motivo exacto (código de salida, mensaje sanitizado del resumen);
- si es un bloqueo de cobertura/cuenta, no reintentar en loop — reintentar recién cuando se resuelva la causa (por ejemplo, al día siguiente si es cuota, o tras confirmar acceso si es la cuenta);
- dejar constancia de que no se completó una importación real, sin fabricar evidencia que no ocurrió.

---

## Hallazgos y fixes durante esta validación

Esta corrida real encontró tres bugs reales, ninguno detectable con los tests unitarios existentes (corren contra un cliente/DB falsos). Los tres se arreglaron en esta misma rama:

1. **`upsert_match_fixture` no podía crearse** (`20260912130000_upsert_match_fixture_returns_insert_flag.sql`): intentaba cambiar el tipo de retorno de la función con `CREATE OR REPLACE FUNCTION`, algo que Postgres no permite (error `42P13`). Se corrigió agregando un `DROP FUNCTION` antes, en el mismo archivo de migración (nunca se había podido aplicar exitosamente en ningún entorno, así que no había riesgo de romper un estado ya aplicado).
2. **`reserve_provider_quota_unit` fallaba al ejecutarse** (`20260912120000_provider_quota_ledger.sql`): el `RETURNS TABLE(reserved boolean, reserved_count integer)` crea automáticamente una variable `reserved_count` en PL/pgSQL, que quedaba ambigua contra la columna de la tabla en `SET reserved_count = reserved_count + 1` (error `42702`). Se arregló con una migración nueva (`20260913120000_fix_reserve_provider_quota_unit_ambiguous_column.sql`) que recrea la función calificando la referencia (`provider_quota_ledger.reserved_count + 1`) — acá sí alcanzaba una migración nueva porque el `CREATE OR REPLACE` en sí no fallaba, solo la ejecución.
3. **El cliente de API-Football siempre mandaba `page`** (`api-football-client.ts`, WAT-105): la cuenta real rechaza ese parámetro en `/fixtures` con `"errors":{"page":"The Page field do not exist."}`. Confirmado con dos consultas de diagnóstico directas (`curl`, sin pasar por `matches:sync`): con `page=1` falla igual que el comando; sin `page`, devuelve los 28 fixtures esperados. Se corrigió para que el cliente solo mande `page` cuando es mayor a 1, preservando la paginación real para ventanas futuras con más de una página.

## Evidencia de la ejecución real

- **Fecha/hora UTC**: 2026-09-13 18:28 UTC (`last_success_at` en `provider_sync_state`).
- **Competición / temporada / ventana**: Liga Profesional Argentina (128) / 2023 / 2023-03-01 a 2023-03-14.
- **Páginas consultadas**: 1 de 1 (`paging.total: 1` — la ventana aprobada por B1.1 no pagina).
- **Fixture externo representativo (sanitizado)**: external_id `971418`, Union Santa Fe vs. Estudiantes L.P., 2023-03-03, estado `finished`.
- **Resumen (JSON) de la corrida exitosa**:
  ```json
  {
    "importados": 28,
    "actualizados": 0,
    "omitidos": [],
    "errores": [],
    "consultasRealizadas": 1,
    "consultasReservadas": 1,
    "presupuestoRestante": 77
  }
  ```
  Código de salida: `0`.
- **Cuota/límites observados**: `provider_quota_ledger` quedó en `reserved_count = 3` para `2026-09-13` (1 reserva de una prueba SQL directa sobre la función, más las 2 reservas de las dos ejecuciones reales de `matches:sync` — la fallida por el bug de `page` y la exitosa). Además de esas 2 ejecuciones del comando, se hicieron 2 llamadas reales adicionales por fuera de `matches:sync` (`curl` directo) para diagnosticar el bug del parámetro `page` — ninguna de las dos persistió datos ni pasó por el ledger, porque no pasaron por el código del comando.
- **Verificación en Supabase local**: `matches` y `teams` con filas `provider = 'api-football'` (28 partidos, equipos con nombres reales como "Boca Juniors", "River Plate", etc.), `provider_sync_state` con el lease liberado (`lease_owner`/`lease_token` en `NULL`) y `last_success_at` seteado.
