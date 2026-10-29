# Estadísticas deportivas: cuota y alcance viable para el 30/10–05/11

Parte del relevamiento de [football-data-org-statistics-coverage.md](football-data-org-statistics-coverage.md),
hecho el 2026-10-28 con la cuenta Free actual y la Premier League. Este documento es la
recomendación: no define ni implementa endpoints, persistencia ni interfaz.

## Recomendación

**La cobertura actual no permite implementar estadísticas deportivas.** Posesión, remates, tiros al
arco, córners y faltas no llegan con el plan Free: el proveedor las ofrece solo en un complemento
de pago. No hay un alcance de implementación viable con datos reales para la semana próxima.

Alcance propuesto para el 30/10–05/11:

1. **No abrir tickets de endpoint, persistencia ni interfaz de estadísticas.** Sin datos reales
   cualquier implementación mostraría vacíos o, peor, ceros inventados.
2. **Una decisión, antes del 30/10, de quien administra la cuenta y el presupuesto (coordinada
   por Francisco): ¿se contrata el complemento de estadísticas?**
   - **Si no:** las estadísticas deportivas quedan fuera del alcance del producto con este
     proveedor, y las horas de la semana se reasignan a otro frente.
   - **Si sí:** el único trabajo de la semana es **una verificación de 1 h**, antes de planificar
     nada más (criterios abajo). La implementación se planifica después, con su propio ticket y
     solo con esa evidencia.

### Verificación posterior a la contratación (solo si se decide contratar)

- La cuenta acepta el complemento sobre el plan Free (la página de planes dice que se contrata
  «sobre un plan regular»; no está confirmado que el plan Free califique).
- El bloque `statistics` de `GET /v4/matches/{id}` trae, en un partido terminado de la Premier
  League, los cinco campos con valores: `ball_possession`, `shots`, `shots_on_goal`,
  `corner_kicks` y `fouls`.
- Si el listado `GET /v4/competitions/PL/matches` también las incluye o hace falta un pedido por
  partido (determina el costo de cuota).
- Los límites de pedidos de la cuenta con el complemento.
- Cómo llega un partido sin estadísticas (bloque ausente, campos en `null` o campos en `0`) para
  poder distinguir un `0` real de la falta de dato.

## Restricciones

| Métrica       | Campo del proveedor | Acceso con el plan Free                   |
| ------------- | ------------------- | ----------------------------------------- |
| Posesión      | `ball_possession`   | Restringido (complemento de estadísticas) |
| Remates       | `shots`             | Restringido (complemento de estadísticas) |
| Tiros al arco | `shots_on_goal`     | Restringido (complemento de estadísticas) |
| Córners       | `corner_kicks`      | Restringido (complemento de estadísticas) |
| Faltas        | `fouls`             | Restringido (complemento de estadísticas) |

- El complemento (_Statistic Add-On_) costaba EUR 15 por mes según la página de planes del
  proveedor el 2026-10-28; el precio puede cambiar y no se contrató.
- La respuesta del plan Free es `200` sin el bloque `statistics`, no un `403`: no avisa que el
  dato existe pero está bloqueado. Hay que tratar su ausencia como «sin dato», nunca como `0`.

## Cuota

| Concepto                     | Valor                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Límite del plan Free         | 10 pedidos por minuto (el encabezado informó 9 restantes tras el primero)      |
| Límite diario del proveedor  | No informado en los encabezados observados                                     |
| Presupuesto propio de la app | 80 pedidos por día y 10 por minuto (valor interno, no del proveedor)           |
| Consumo de la sincronización | 1 pedido por corrida (una consulta de la ventana de partidos), una vez por día |

La sincronización diaria usa 1 de los 80 pedidos del presupuesto propio, así que hay margen. Las
estadísticas no consumirían cuota hasta que existiera acceso a los datos.

Estimación, **sobre un supuesto sin verificar**: si las estadísticas llegaran solo en el detalle
de cada partido (`/v4/matches/{id}`), cada partido terminado costaría 1 pedido. La Premier League
tiene 20 equipos y 380 partidos por temporada, con unos 10 por jornada; un día cargado costaría
alrededor de 10 pedidos más el de la sincronización, unos 11 de los 80 diarios. El límite de 10
por minuto obligaría a espaciarlos. Sin el complemento no se puede saber si el listado ya las
incluye, así que esta cuenta queda sin confirmar.

## Campos utilizables hoy

Lo que llega en el detalle de un partido terminado con el plan Free (consulta del 2026-10-28):

| Campo                                                 | Estado con el plan Free                                               | Lo usa la app hoy |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| `id`, `utcDate`, `status`                             | Llega                                                                 | Sí                |
| `competition`, `season` (con su `id`)                 | Llega                                                                 | Sí                |
| `homeTeam` y `awayTeam` (`id`, `name`)                | Llega                                                                 | Sí                |
| `score.fullTime`                                      | Llega, con enteros al terminar el partido                             | Sí                |
| `score.halfTime`, `score.winner`, `duration`          | Llega                                                                 | No                |
| `matchday`, `stage`, `lastUpdated`, `area`            | Llega                                                                 | No                |
| `homeTeam` y `awayTeam` (`shortName`, `tla`, `crest`) | Llega                                                                 | No                |
| `referees`                                            | Llega, con un árbitro en el partido consultado                        | No                |
| `venue`                                               | Llega como `null` en el partido consultado: no es confiable           | No                |
| `odds`                                                | Restringido: el proveedor responde un mensaje para activar un paquete | No                |
| `statistics` (las cinco métricas)                     | Ausente: restringido por plan                                         | No                |

Ninguno de estos campos es una de las cinco métricas pedidas. Si el producto quisiera mostrar algo
con datos que sí llegan (por ejemplo el resultado al descanso, `score.halfTime`), sería otro
alcance: hoy no se guarda, así que requeriría una migración de base de datos, el normalizador, la
API y la interfaz. No se propone ni se estima aquí.

## Alcance y límites

- No se implementaron endpoints, persistencia, interfaz ni código; no se contrató ningún servicio.
- Los datos salen de consultas puntuales del 2026-10-28 (partidos terminados de la Premier League)
  y de la página de planes del proveedor de ese día.
- La cuota diaria del proveedor no se pudo observar: solo se vio el contador por minuto.
