# Decisión: canal de tiempo real para comentarios de sala

## Estado

Aceptada (WAT-152, dentro de WAT-145).

## Contexto

Los comentarios de sala se crean y listan por la API Node (`POST/GET /rooms/:roomId/comments`) y se
persisten en `room_comments`. Falta que quien está en la misma sala vea los comentarios nuevos sin
recargar.

Restricciones del proyecto:

- La API corre en Vercel como función serverless (`apps/api/src/app.ts` exporta la app Express).
- `room_comments` tiene RLS activado, sin policies y con `revoke all` a `anon` y `authenticated`: solo
  el backend con `service_role` la lee y escribe.
- La web usa Supabase únicamente para Auth (`apps/web/src/lib/supabase.ts`).
- WAT-152 no permite instalar dependencias nuevas.

## Opciones comparadas

### A. WebSocket servido por Node

La API mantendría conexiones abiertas y empujaría cada comentario nuevo a los clientes de la sala.

- Ventaja: la base sigue cerrada; toda lectura pasa por la API.
- Costo: las funciones serverless de Vercel no sostienen conexiones largas. Habría que sumar un
  servidor siempre encendido, una dependencia (`ws`) y un despliegue nuevo, todo fuera del alcance
  actual.

### B. Supabase Realtime (`postgres_changes`) desde la web

El navegador se suscribe a los `INSERT` de `room_comments` filtrados por `room_id=eq.<roomId>`.

- Ventaja: no requiere infraestructura ni dependencias nuevas (`@supabase/supabase-js` ya está).
- Costo: exige abrir lectura de la tabla al rol `authenticated` (ver "Migración requerida"), lo que
  rompe la regla de que la web no lee tablas directo.

## Decisión

Se adopta un esquema híbrido:

- **Crear y listar comentarios**: siguen por la API Node, sin cambios.
- **Recibir comentarios nuevos**: Supabase Realtime (opción B), con una suscripción por sala activa.

La opción A queda descartada por ahora por la restricción de Vercel serverless y la prohibición de
instalar dependencias.

## Migración requerida

Nueva migración (no se editan las anteriores):

1. `grant select on public.room_comments to authenticated`.
2. Policy de lectura para `authenticated`.
3. `alter publication supabase_realtime add table public.room_comments`.

Según la documentación de Supabase, Postgres Changes exige que la tabla esté en la publicación
`supabase_realtime` y que el rol tenga permiso de lectura vía RLS; el filtro `col=eq.valor` lo define
el cliente al suscribirse.

## Consecuencias y límites

- **Aislamiento entre salas**: las salas son públicas para usuarios autenticados, así que la policy
  no restringe por sala. El filtro `room_id` lo elige el cliente: separa suscripciones, pero no es una
  frontera de autorización.
- **Excepción a la regla "la web no lee tablas"**: `authenticated` podría leer `room_comments` también
  con `supabase.from(...)`. La web sigue sin hacerlo; la lectura y la escritura funcionales siguen
  por la API.
- **Escritura**: no cambia. `authenticated` sigue sin `INSERT`/`UPDATE`/`DELETE`.
- **Duplicados**: quien comenta recibe también su propio evento; la suscripción deduplica por `id`.
- **Escala**: Postgres Changes autoriza por suscriptor. Con muchas personas simultáneas en una misma
  sala habría que evaluar Broadcast (según la documentación de Supabase, a partir de unos ~3.000
  suscriptores simultáneos).
- **Remoto**: la migración se valida en local (`supabase db reset --local`). Aplicarla al proyecto
  remoto queda pendiente y sin ella Realtime no entrega eventos en producción.
- **Fuera de alcance de esta decisión**: eventos de reacciones, canal global, reintentos y estado de
  conexión (tickets aparte).
