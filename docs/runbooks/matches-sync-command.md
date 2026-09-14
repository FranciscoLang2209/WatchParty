# Runbook: comando de sincronización manual de partidos (WAT-107)

Este runbook documenta el uso del comando `matches:sync`, sus códigos de salida y su resumen. La validación real contra la cuenta de API-Football (B1.4) todavía no corrió — ver la sección "Estado de la validación" al final.

## Qué hace

`matches:sync` sincroniza, en una única ejecución manual, la ventana de fixtures aprobada por B1.1 (Liga Profesional Argentina, ID externo `128`, temporada `2023`, rango `2023-03-01` a `2023-03-14`) hacia Supabase. No es un cron, no es un endpoint HTTP y no se dispara automáticamente desde ningún lado: solo corre cuando alguien lo ejecuta a mano.

## Cómo ejecutarlo

```sh
pnpm --filter @watchparty/api matches:sync
```

Requiere, en el entorno del backend (`apps/api/.env`, nunca comiteado):

- `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY` — credenciales del proveedor, cargadas exclusivamente por este comando (ninguna ruta HTTP, el arranque de la API, los tests ni `pnpm validate` las tocan).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — mismas variables que ya requiere el resto de la API para persistencia.

## Códigos de salida

| Código | Significado                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`    | Ejecución completa: se procesaron todas las páginas de la ventana sin errores de página ni de persistencia.                                                                                                                                                        |
| `1`    | Ejecución parcial: cuota diaria agotada (propia o informada por el proveedor), error de proveedor (HTTP no exitoso, timeout tras el reintento permitido, cuerpo/paginación inválidos) o error de persistencia. No se borra ni reemplaza ningún dato ya persistido. |
| `2`    | Configuración inválida (falta `API_FOOTBALL_BASE_URL`/`API_FOOTBALL_KEY`) o no se pudo adquirir el lease de sincronización (ya hay otra ejecución en curso).                                                                                                       |

## Resumen impreso al finalizar (código 0 o 1)

```json
{
  "importados": 0,
  "actualizados": 0,
  "omitidos": [{ "reason": "invalid-kickoff-date", "count": 0 }],
  "errores": [{ "reason": "http-error", "count": 0 }],
  "consultasRealizadas": 0,
  "consultasReservadas": 0,
  "presupuestoRestante": 80
}
```

- `importados`/`actualizados` cuentan fixtures, no filas de equipos.
- `omitidos` y `errores` agrupan por motivo (valores fijos y ya sanitizados: nunca incluyen texto crudo del proveedor ni de Postgres).
- `consultasReservadas` es la cantidad de unidades de cuota diaria efectivamente reservadas en esta corrida (ledger persistente, compartido entre ejecuciones del mismo día UTC); `consultasRealizadas` es la cantidad de llamadas HTTP reales hechas al proveedor.
- `presupuestoRestante` es el presupuesto diario interno (80/día, o menor si la cuota real documentada por B1.1 es menor) menos lo ya reservado hoy.

## Política de cuota y reintentos (resumen operativo)

- Antes de cada página **y** de cada reintento se reserva una unidad persistente del ledger diario (UTC) antes de llamar al proveedor — una reserva cuenta aunque la solicitud termine en timeout.
- Si el proveedor informa, en los headers de una respuesta, un restante diario menor al presupuesto local, la ejecución se corta en ese valor menor.
- Límite por minuto: 10 solicitudes/minuto (Free plan, según B1.1). El comando espera automáticamente si hace falta.
- Reintento: solo ante timeout o HTTP 429, máximo un reintento por solicitud, usando `Retry-After` si el proveedor lo informó, o un backoff acotado fijo en caso contrario.
- Dos ejecuciones simultáneas del comando producen como máximo una consulta externa: la segunda no adquiere el lease y termina con código `2` sin llamar al proveedor.

## Estado de la validación

Esta corrida documentada es de diseño/tests con dobles falsos (cliente, store, lease y reloj fake) — ver `apps/api/src/modules/matches/application/sync-matches.test.ts`. Todavía no se ejecutó contra la cuenta real de API-Football ni contra un proyecto Supabase real desde este comando. Esa validación de punta a punta, con evidencia sanitizada real, es responsabilidad de B1.4.
