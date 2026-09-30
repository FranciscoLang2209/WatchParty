# Runbook: validación de comentarios en tiempo real (dos sesiones)

Comprueba que un comentario publicado por una persona aparece sin recargar en otra sesión de la
misma sala, según la decisión de `docs/decisions/realtime-comments.md`: crear y listar por la API
Node, recibir por Supabase Realtime.

## Entorno

| Dato         | Valor                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| SHA validado | `abb40f7` (rama `feature/wat-145-conversacion-tiempo-real`)                                                |
| Fecha        | 2026-09-26                                                                                                 |
| Entorno      | Node 24.19.0, Supabase local (Docker), API `:3000`, web `:5173`                                            |
| Canal        | `room-comments:<roomId>`: `postgres_changes`, `INSERT` sobre `room_comments`, filtro `room_id=eq.<roomId>` |
| Sesiones     | dos usuarios de prueba locales: ventana normal (A) e incógnito (B)                                         |

Precondición: migración `20260924120000_room_comments_realtime.sql` aplicada con
`supabase db reset --local`.

## Cómo se ejecutó

Con `pnpm dev` levantado, se abrió `http://localhost:5173` en dos ventanas (una normal y una de
incógnito), se registró un usuario de prueba en cada una y ambas abrieron la misma sala desde
`/rooms/<roomId>`. No se tocó API-Football.

## Resultados

| #   | Escenario                                           | Resultado esperado                                          | Resultado                                                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Registro de dos usuarios y acceso en ambas ventanas | Ambos quedan con sesión                                     | OK                                                                    |
| 2   | Abrir la misma sala en B                            | B muestra la sala de A                                      | OK                                                                    |
| 3   | A comenta en la sala                                | El comentario se ve sin recargar, una sola vez, en A y en B | OK                                                                    |
| 4   | B comenta en la sala                                | A lo ve sin recargar                                        | OK                                                                    |
| 5   | Dos comentarios seguidos                            | Se ven los dos                                              | OK                                                                    |
| 6   | Otra sala abierta en una ventana                    | No muestra los comentarios de la sala de la otra ventana    | OK                                                                    |
| 7   | Consola del navegador                               | Sin errores                                                 | OK                                                                    |
| 8   | Network, filtro WS, pestaña Messages                | Conexión WebSocket activa que recibe mensajes al comentar   | OK: aparecen mensajes entrantes cada vez que se publica un comentario |

## Límites conocidos

- La migración solo está aplicada en local; en el proyecto remoto queda pendiente (`db push`).
- El aislamiento por sala lo da el filtro del cliente, no la policy (ver la decisión).
- No se probó carga ni reconexión tras una caída de red.
- No se inspeccionó el contenido de cada mensaje del WebSocket más allá de verificar que llegan
  al comentar.
