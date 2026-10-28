# Runbook: verificación de calificaciones (WAT-216)

Verifica el frente de calificaciones del plan 15–22/10/2026 (WAT-211 a WAT-215): persistencia, edición, agregado sin votantes duplicados, rechazos del servidor y aislamiento entre usuarios. Los datos sintéticos se crean solo en el entorno local; nada de esto se corre contra producción (el script aborta si `SUPABASE_URL` no apunta a `127.0.0.1` o `localhost`).

## SHA validado

| Dato    | Valor                                       |
| ------- | ------------------------------------------- |
| SHA     | `38f574c` (`main`) + los cambios de WAT-216 |
| Fecha   | 2026-10-27                                  |
| Entorno | Node 24, pnpm, macOS, Supabase local        |

## 1. Recorrido integrado contra la API local

Precondiciones: Supabase local levantado con las migraciones aplicadas y la API en `:3000` (`pnpm --filter @watchparty/api dev`).

```sh
pnpm --filter @watchparty/api verify:match-rating-journey
```

Crea dos usuarios temporales y siete partidos propios (3 finalizados, 1 programado, 1 en vivo, 1 postergado, 1 cancelado) con `service_role`, como el backend. No depende del seed. Al terminar borra notas, vistos, partidos, equipos y usuarios que creó.

| Criterio | Chequeo                                                                                                 | Resultado |
| -------- | ------------------------------------------------------------------------------------------------------- | --------- |
| (a)      | Antes de calificar, `GET` devuelve `{ rating: null }`; partido sin votos: `{ average: null, count: 0 }` | OK        |
| (a)      | `PUT { rating: 4 }` responde 200; al recargar y en una sesión nueva la nota persiste                    | OK        |
| (a)      | Base: una sola fila por usuario y partido                                                               | OK        |
| (a)      | Repetir el mismo `PUT` no duplica el voto                                                               | OK        |
| (a)      | Dos votantes (4 y 2): `{ average: 3, count: 2 }`                                                        | OK        |
| (a)      | Editar a 5 desde otra sesión: la original ve 5; `{ average: 3.5, count: 2 }` (no suma votantes)         | OK        |
| (a)      | Base: tras editar siguen 2 filas, `created_at` no cambia, `updated_at` no retrocede                     | OK        |
| (a)      | El resumen expone solo `average` y `count`                                                              | OK        |
| (b)      | Notas `0`, `6`, `-1`, `3.5`, `"4"`, `null`, `true`, sin campo y JSON roto: 400; la nota no cambia       | OK        |
| (b)      | Programado, en vivo, postergado y cancelado (vistos): 409 y sin fila creada                             | OK        |
| (b)      | Finalizado no visto, o con el visto deshecho: 409 y sin fila                                            | OK        |
| (b)      | Partido inexistente: 404 (nota, resumen y `PUT`); id mal formado: 400                                   | OK        |
| (b)      | Sin sesión o con token inválido: 401                                                                    | OK        |
| (b)      | B no ve la nota de A; `userId` en query, body o header se ignora y la escritura cae en la fila de B     | OK        |
| (b)      | No existen rutas para leer o escribir la nota de otro usuario (404)                                     | OK        |
| (b)      | El resumen es común a todos y lo de un partido no toca el de otro                                       | OK        |

## 2. Pasada manual en la web local

Web en `http://localhost:5173` contra la API y el Supabase locales, con dos cuentas de prueba locales (A y B) y un partido finalizado (en `supabase/seed.sql`, `a333…`, o uno que se pase a `finished` con SQL local).

| Paso | Acción                                                         | Esperado                                                                 | Resultado   |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| 1    | A abre el detalle del partido finalizado y lo marca como visto | Aparece el selector de nota y el resumen de la comunidad                 | _pendiente_ |
| 2    | A elige 4                                                      | «Calificación guardada»; el resumen pasa a 4 con 1 voto                  | _pendiente_ |
| 3    | A recarga la página                                            | La nota 4 sigue marcada                                                  | _pendiente_ |
| 4    | A cambia a 5                                                   | Nota 5; el resumen sigue en 1 voto                                       | _pendiente_ |
| 5    | A cierra sesión; B inicia sesión, marca el partido como visto  | B ve el selector sin nota propia; el resumen muestra la de A             | _pendiente_ |
| 6    | B elige 2                                                      | Resumen 3,5 con 2 votos; la nota de A no cambió al volver a entrar con A | _pendiente_ |
| 7    | B abre un partido programado / en vivo                         | No se ofrece calificar                                                   | _pendiente_ |

Capturas: sin tokens, emails ni host; recortar la barra del navegador.

## 3. Observaciones

_Completar al ejecutar. Solo las de este frente; lo ajeno se deriva a su ticket._

## Limitaciones conocidas

- La elegibilidad (finalizado y visto) se comprueba y después se escribe, sin transacción (ver `MatchRatingService`). El script no prueba esa carrera.
- Con un único voto el promedio coincide con ese voto (WAT-214); es una decisión de producto, no de este ticket.
