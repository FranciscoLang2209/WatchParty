# Runbook: comando de sincronización manual de partidos (WAT-107)

Este runbook documenta el uso del comando `matches:sync`, sus códigos de salida y su resumen. La validación real contra la cuenta de API-Football (B1.4) todavía no corrió — ver la sección "Estado de la validación" al final.

## Qué hace

`matches:sync` sincroniza, en una única ejecución, los fixtures del proveedor seleccionado hacia Supabase. No es un endpoint HTTP: lo dispara una persona o el workflow `Matches sync`. El proveedor se elige con `MATCHES_SYNC_PROVIDER` (una sola fuente por corrida; nunca consulta ambos):

| Valor                             | Qué importa                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `football-data-org` (por defecto) | Premier League (código `PL`, id externo `2021`), temporada verificada `2026` (año de inicio según el proveedor, no el año calendario). Ventana móvil de la agenda: desde las 00:00 UTC de ayer hasta las 00:00 UTC del día posterior a los próximos siete días (fin exclusivo). El filtro externo `dateTo` es el séptimo día, inclusivo. |
| `api-football`                    | La ventana histórica aprobada por B1.1 (Liga Profesional Argentina, ID externo `128`, temporada `2023`, rango `2023-03-01` a `2023-03-14`).                                                                                                                                                                                              |

Al cerrar el intento se guarda el resumen (importados, actualizados, omitidos, errores y consultas) en `provider_sync_state`.

## Cómo ejecutarlo

```sh
pnpm --filter @watchparty/api matches:sync
```

Requiere, en el entorno del backend (`apps/api/.env`, nunca comiteado):

- Con `football-data-org` (por defecto): `FOOTBALL_DATA_ORG_BASE_URL`, `FOOTBALL_DATA_ORG_API_KEY`.
- Con `MATCHES_SYNC_PROVIDER=api-football`: `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY`.
- Siempre: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — mismas variables que ya requiere el resto de la API para persistencia.

Las credenciales del proveedor las carga exclusivamente este comando (ninguna ruta HTTP, el arranque de la API, los tests ni `pnpm validate` las tocan).

## Ejecución programada (WAT-185)

El workflow `Matches sync` corre `pnpm --filter @watchparty/api matches:sync` todos los días a las 06:17 UTC (03:17 Argentina) y también con `workflow_dispatch` (Actions → Matches sync → Run workflow). GitHub no garantiza puntualidad exacta del schedule.

- Las corridas del workflow se serializan (`concurrency` con `cancel-in-progress: false`): una nueva espera a la que está en curso. El lease en base sigue siendo la segunda barrera.
- El código de salida del comando se propaga tal cual: cualquier valor distinto de `0` deja la corrida en rojo.
- Secrets de repositorio requeridos: `FOOTBALL_DATA_ORG_BASE_URL` y `FOOTBALL_DATA_ORG_API_KEY` (proveedor por defecto), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` y `WEB_ORIGIN` (las dos últimas solo porque `config/env.ts` las exige al importarse). Para usar API-Football desde el workflow, definir la variable de repositorio `MATCHES_SYNC_PROVIDER=api-football` y cargar también `API_FOOTBALL_BASE_URL` y `API_FOOTBALL_KEY`. Su carga es parte de OPS-03/OPS-04.

## Configuración de producción y preflight (WAT-186)

Al arrancar, `matches:sync` valida todo el entorno (Supabase y el proveedor seleccionado) antes de crear clientes, consultar al proveedor o escribir en la base. Si falta o es inválida alguna variable, sale con código `2` y un mensaje que las lista todas juntas, sin mostrar nunca sus valores.

- El preflight verifica que cada variable esté presente (no vacía ni solo espacios) y que las URLs sean http(s) válidas. **No prueba que las credenciales funcionen**: una clave con formato válido pero equivocada falla recién cuando el proveedor o Supabase la rechazan (código `1`).
- Solo se exigen las variables del proveedor elegido con `MATCHES_SYNC_PROVIDER`. Las credenciales de Supabase y las del proveedor son independientes.

### Secrets de producción

Se cargan como secrets de repositorio (Settings → Secrets and variables → Actions → Secrets). Nunca como valores literales en el workflow.

| Secret                                      | Qué es                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SUPABASE_URL`                              | URL del proyecto Supabase que usa la API publicada.                                |
| `SUPABASE_SERVICE_ROLE_KEY`                 | Clave `service_role` del mismo proyecto. Salta RLS: solo backend.                  |
| `SUPABASE_ANON_KEY`                         | Solo porque `config/env.ts` la exige al importarse; la sincronización no la usa.   |
| `WEB_ORIGIN`                                | Ídem: origen del frontend publicado, exigido por `config/env.ts`.                  |
| `FOOTBALL_DATA_ORG_BASE_URL`                | Proveedor por defecto: base URL de football-data.org.                              |
| `FOOTBALL_DATA_ORG_API_KEY`                 | Token de la cuenta Free verificada en WAT-180.                                     |
| `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY` | Solo si se define la variable de repositorio `MATCHES_SYNC_PROVIDER=api-football`. |

Reglas:

- Ninguna de estas claves puede llamarse `VITE_*` ni llegar al bundle del frontend (un test del repo lo verifica).
- No existe un endpoint HTTP que dispare importaciones: el único disparador es el comando, desde una persona o el workflow.
- Una vez cargados los secrets, el workflow se activa creando la variable de repositorio `MATCHES_SYNC_ENABLED=true`.

## Códigos de salida

| Código | Significado                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`    | Ejecución completa: se procesaron todas las páginas de la ventana sin errores de página ni de persistencia.                                                                                                                                                        |
| `1`    | Ejecución parcial: cuota diaria agotada (propia o informada por el proveedor), error de proveedor (HTTP no exitoso, timeout tras el reintento permitido, cuerpo/paginación inválidos) o error de persistencia. No se borra ni reemplaza ningún dato ya persistido. |
| `2`    | Configuración inválida (falta la configuración del proveedor seleccionado, o `MATCHES_SYNC_PROVIDER` tiene un valor desconocido) o no se pudo adquirir el lease de sincronización (ya hay otra ejecución en curso).                                                |

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
