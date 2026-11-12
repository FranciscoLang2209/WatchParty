# Fecha FIFA: partidos de selecciones en agenda, detalle y sala

Diagnóstico del reporte del PM: WatchParty no muestra partidos de selecciones durante la fecha FIFA
de la semana del 2026-11-12. Documenta qué se verificó, qué quedó pendiente, las opciones para la
decisión de PM/PO y la contingencia de demo.

> **Esta PR es un avance de diagnóstico.** No acredita que la agenda actual de selecciones esté
> resuelta, y la comprobación en producción sigue pendiente (ver «Comprobación en producción»).

**Estado: bloqueado por cobertura del plan.** Con la cuenta vigente, ningún torneo de selecciones
accesible tiene partidos en la ventana. No se corrigió nada en el flujo porque el flujo no es la
causa, y este issue **no se cierra como corregido** hasta que haya cobertura actual o una decisión.

## Qué se verificó con la cuenta

Comando nuevo y de solo lectura, `matches:probe-coverage`. Consulta a football-data.org con la
cuenta del equipo, no escribe en la base y su informe no incluye la clave ni encabezados (ver
«Cómo repetir la comprobación»).

Corrida del **2026-11-12 15:23 UTC**, plan de la cuenta `TIER_ONE` (Free), ventana
**2026-11-12 a 2026-11-19**:

| Código | Competición           | Plan exigido | Temporada vigente       | Resultado                          |
| ------ | --------------------- | ------------ | ----------------------- | ---------------------------------- |
| `EC`   | European Championship | `TIER_ONE`   | 2024-06-14 → 2024-07-14 | HTTP 200, 0 partidos en la ventana |
| `WC`   | FIFA World Cup        | `TIER_ONE`   | 2026-06-11 → 2026-07-19 | HTTP 200, 0 partidos en la ventana |

Conclusiones que sí se sostienen con esta evidencia:

- Entre los torneos de selecciones, la cuenta **sólo ve `WC` y `EC`**: son los únicos que el
  proveedor listó para ella.
- Los dos responden 200 y **no tienen partidos esta semana**, porque ya terminaron: el Mundial 2026
  cerró el 2026-07-19 y la Eurocopa 2024, el 2024-07-14.
- La fecha FIFA de esta semana (amistosos, Nations League, eliminatorias) **no está en ninguna
  competición que la cuenta pueda leer**.

## Referencia pública del proveedor (no es evidencia de la cuenta)

La [tabla de cobertura](https://www.football-data.org/coverage), consultada el 2026-11-12, marca que
UEFA Nations League, las eliminatorias del Mundial (UEFA, CONMEBOL, CAF, AFC, CONCACAF), las
eliminatorias de la Eurocopa, la Copa América y la Copa Africana de Naciones están únicamente en el
**Tier 4 (199 € por mes)**. Los amistosos internacionales no figuran en la tabla. Sólo el Mundial y
la Eurocopa están en el plan Free.

Esto orienta la decisión pero no prueba qué puede leer la cuenta: lo que vale es la tabla de arriba.

## Tramo afectado

Se siguió el camino del dato, del proveedor a la pantalla:

| Tramo                        | Estado                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cobertura del proveedor      | **Es la causa.** La cuenta no accede a ningún torneo de selecciones con partidos esta semana.                                                                                                                                                                                                                                                              |
| Sincronización diaria        | Consulta sólo `PL`, `CL`, `PD` y `SA` (`DAILY_FOOTBALL_DATA_ORG_COMPETITIONS`). No hay selecciones porque no hay una edición vigente accesible; agregar `WC` o `EC` no traería nada hoy.                                                                                                                                                                   |
| Ventana de fechas            | La agenda muestra desde las 00:00 UTC de ayer hasta el día posterior a los próximos **catorce** días (16 días en total). Se amplió de siete a catorce para que, en una semana de fecha FIFA con la agenda de clubes vacía, se vean los partidos de la semana siguiente. Funciona como está documentada; un partido dentro de la ventana no queda excluido. |
| API y filtros de la interfaz | No filtran por tipo de equipo ni de competición: un partido de selecciones persistido se listaría igual que uno de clubes.                                                                                                                                                                                                                                 |
| Datos de producción          | **Pendiente de comprobar** en producción (ver «Comprobación en producción»).                                                                                                                                                                                                                                                                               |

La agenda de clubes también viene vacía esta semana por la misma fecha FIFA (corrida del
2026-11-10 en `football-data-org-pilot-5000.md`): no es un fallo, los clubes no juegan.

## Opciones para PM/PO

No se contrata ni se cambia de proveedor dentro de este issue. Las alternativas, con el esfuerzo del
equipo estimado y el costo según la tabla pública (a confirmar con el proveedor antes de decidir):

| Opción                                             | Qué da                                                                      | Esfuerzo (estimado)                                                                                                                                       | Costo                   |
| -------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **A.** Ampliar a Tier 4 de football-data.org       | Nations League y eliminatorias en el mismo proveedor y el mismo importador. | Bajo: agregar los códigos al sync diario, verificar acceso con el sondeo y repetir sincronización sin duplicados. El cupo diario pasa de 4 a más pedidos. | 199 € por mes (público) |
| **B.** Otro proveedor                              | Cobertura distinta, posiblemente amistosos.                                 | Alto: nueva integración, normalización y pruebas. Sin decisión previa no se hace.                                                                         | A relevar               |
| **C.** Demo con partidos históricos de selecciones | Recorrido completo y ensayable, sin agenda actual.                          | Ninguno: ya existe (ver contingencia).                                                                                                                    | Sin costo               |

Con la opción A, el cambio de código es acotado y cae en el flujo existente; lo que falta es la
decisión de gasto. La contingencia **no sustituye** a la A ni a la B: permite ensayar la demo, no
acredita que la agenda actual quedó resuelta.

## Contingencia de demo con un partido histórico

Sólo con lo que ya está cargado: no se mueve ningún partido a hoy ni se lo presenta como en vivo.
Se mostrará con su fecha y su estado reales.

Candidato: la **final de la Eurocopa 2024** (España–Inglaterra, 2024-07-14), si el lote histórico
`EC:2024` está cargado en el entorno de la demo. Cualquier otro partido de `WC` o `EC` sirve.

Pasos desde la interfaz, sin SQL, terminal ni cambios de código:

1. Iniciar sesión y abrir **Buscar**.
2. Escribir el nombre del equipo tal como figura en el proveedor, en inglés (por ejemplo `Spain`).
3. Abrir la tarjeta del partido elegido: el detalle queda en una dirección del estilo
   `/matches/<id>`. Copiar esa dirección de la barra del navegador: es el **enlace directo**.
4. En el detalle, usar **Entrar a la sala** para llegar a la sala del mismo partido.

Registro de la comprobación (completar al verificarla en el entorno de la demo):

| Dato                            | Valor                    |
| ------------------------------- | ------------------------ |
| Partido (equipos y competición) | _pendiente de comprobar_ |
| Fecha y estado mostrados        | _pendiente de comprobar_ |
| Enlace directo al detalle       | _pendiente de comprobar_ |
| Versión desplegada y URL        | _pendiente de comprobar_ |
| Quién lo comprobó y cuándo      | _pendiente de comprobar_ |

## Cómo repetir la comprobación

Desde la raíz del repositorio, con las variables `FOOTBALL_DATA_ORG_BASE_URL` y
`FOOTBALL_DATA_ORG_API_KEY` definidas (en `apps/api/.env` o en el entorno; **no se pegan en ningún
ticket**):

```sh
pnpm --filter @watchparty/api matches:probe-coverage
```

- Hace un pedido a `/v4/competitions` y uno por cada torneo de selecciones que el plan de la cuenta
  alcanza. Con el plan Free son tres pedidos, dentro del límite de 10 por minuto. No usa la cuota
  diaria persistente de la sincronización ni escribe en Supabase.
- `PROBE_DATE_FROM` y `PROBE_DATE_TO` (`YYYY-MM-DD`) cambian la ventana; por defecto es hoy y los
  catorce días siguientes. `PROBE_ACCOUNT_PLAN` (por defecto `TIER_ONE`) indica el plan de la cuenta:
  si se amplía, hay que cambiarlo para que el sondeo consulte los torneos nuevos.
- Un 200 cuyo cuerpo no es una lista de partidos (por ejemplo, HTML en vez de JSON) se informa como
  **respuesta inválida, sin conclusión**: nunca como cero partidos. Lo mismo vale para la lista de
  competiciones. Un informe con alguna consulta ilegible sale con error, porque no prueba falta de
  cobertura.
- Códigos de salida: 0 informe completo (aunque no haya cobertura), 1 el proveedor no respondió,
  respondió algo que no se puede leer o alguna consulta quedó sin conclusión, 2 configuración inválida.
- `PROBE_PERSISTED=true` agrega los partidos **persistidos** en la ventana de la agenda, con la misma
  consulta que usa la API. Lee la base a la que apunta `SUPABASE_URL` (solo lectura), así que exige
  confirmarla con `PROBE_ENV_LABEL` y `PROBE_EXPECTED_SUPABASE_HOST` (el host que se espera): sin eso
  no corre.

Si se amplía el plan, se vuelve a correr y se compara con la tabla de arriba antes de tocar el sync.

## Comprobación en producción

**Pendiente.** Hay que comprobar el entorno que se va a usar para la demo y contrastar cuatro cosas
sobre la misma ventana. Hasta entonces, nada de lo siguiente se da por verificado.

Datos del entorno (completar al comprobar):

| Dato                                            | Valor       |
| ----------------------------------------------- | ----------- |
| URL de la web                                   | _pendiente_ |
| URL de la API                                   | _pendiente_ |
| Versión: identificador de despliegue o commit   | _pendiente_ |
| Fecha y hora (UTC) de la comprobación           | _pendiente_ |
| Ventana y filtros (estado y fecha) de la agenda | _pendiente_ |

Qué se pudo comprobar desde afuera, sin sesión ni credenciales de producción, el 2026-11-12 (16:30
UTC): la API de producción responde `200` en `/health` y `401` en `/matches` sin sesión, es decir,
está viva y exige autenticación. **No se pudo** leer la agenda, la base ni la versión desplegada: eso
necesita una sesión o el acceso administrativo del entorno.

Contraste a completar, con el mismo rango de fechas en las cuatro filas:

| Fuente                             | Cómo se obtiene                                                                                                               | Resultado   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Cobertura de la cuenta             | `matches:probe-coverage` (ver arriba). Ya medido el 2026-11-12: `WC` y `EC`, 200, 0 partidos.                                 | Ver tabla   |
| Partidos persistidos en la ventana | `PROBE_PERSISTED=true` con el acceso del entorno de producción, confirmando `PROBE_ENV_LABEL` y el host esperado.             | _pendiente_ |
| Respuesta de la API                | Con sesión iniciada en la web de producción, DevTools → Network → la petición `GET /matches`: cantidad de partidos devueltos. | _pendiente_ |
| Lo que muestra la interfaz         | Agenda (Salas) y detalle, sin filtros que excluyan partidos.                                                                  | _pendiente_ |

Cómo leer el contraste: si el proveedor devuelve 0, la base tiene 0 y la API devuelve 0, la causa es
la cobertura y coincide con este diagnóstico. Si el proveedor devolviera partidos que la base o la API
no tienen, el problema estaría en la sincronización o en la API y habría que corregir ese tramo.

## Decisión requerida de PM/PO

Con la evidencia actual (la cuenta no puede leer ningún torneo de selecciones con partidos esta
semana), la agenda actual de selecciones **no se puede resolver con código**. Hace falta que PM/PO
decida entre:

- **A.** Ampliar el plan de football-data.org (Tier 4, 199 € por mes según la tabla pública), con un
  cambio de código acotado una vez accesible.
- **B.** Evaluar otro proveedor, con una integración nueva.
- **C.** Ensayar la demo con la contingencia histórica, sabiendo que **no** muestra agenda actual.

Mientras no haya una decisión, este issue sigue **abierto y bloqueado**: no se cierra como corregido.

## Pendientes

- Completar la comprobación en producción (tabla de arriba) con URL, versión y fecha.
- Verificar el partido de contingencia y completar su tabla.
- Decisión de PM/PO sobre las opciones A, B o C.
- Retest de QA con persona, fecha y versión. No se declara cerrado mientras no haya cobertura
  actual o una decisión registrada.
