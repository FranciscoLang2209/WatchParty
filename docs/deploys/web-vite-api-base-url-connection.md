# Conectar VITE_API_BASE_URL y redeploy de la web

## Resumen

Se configuró `VITE_API_BASE_URL` en el proyecto Vercel `watchparty-web` apuntando al dominio real
de la API, se redeployó producción, y se verificó en un navegador real (login incluido) que la web
consume la API desplegada y no accede directo a la Data API de Supabase.

## Datos del despliegue

- **Fecha de validación**: 2026-09-10
- **URL web**: `https://watch-party-web-cfeq.vercel.app`
- **URL API**: `https://watchparty-api-ten.vercel.app`
- **SHA desplegado (web, tras redeploy)**: `7789003`
- **SHA desplegado (API, sin cambios)**: `6206bbd`

## Variables configuradas

- `watchparty-web` → `VITE_API_BASE_URL=https://watchparty-api-ten.vercel.app` (Production, tipo Config —
  no es un secreto, Vite la incluye igual en el bundle público).
- `WEB_ORIGIN` en `watchparty-api` no cambió: ya apuntaba al origen correcto desde WAT-135.

## Incidente durante el despliegue (resuelto)

El primer redeploy (disparado desde el aviso automático de Vercel al guardar la variable) reutilizó un
build cacheado de **antes** de que existiera `VITE_API_BASE_URL`, produciendo una pantalla en blanco con
la excepción `Falta la variable de entorno VITE_API_BASE_URL` en consola. Se resolvió con un segundo
redeploy manual (`Deployments → "..." → Redeploy`) sin build cache, que sí incluyó la variable.

## Verificación en Network (navegador real, sesión autenticada)

| Pedido                       | URL                                             | Resultado                                                                                            |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Preflight `OPTIONS /matches` | `https://watchparty-api-ten.vercel.app/matches` | `204`, headers CORS correctos (`Allow-Origin`, `Allow-Methods: GET`, `Allow-Headers: Authorization`) |
| `GET /matches`               | `https://watchparty-api-ten.vercel.app/matches` | `304`, lista de partidos renderizada en Home sin pantalla en blanco                                  |

Ningún pedido salió hacia el dominio de Supabase (`*.supabase.co`) — la web solo lo usa para Auth
(login/registro), nunca para leer datos de partidos.

## 401 y CORS

El comportamiento de un 401 distinguido de un bloqueo CORS ya se validó a nivel HTTP en WAT-136
(headers CORS presentes junto al 401). No se reprodujo un caso de sesión vencida en esta sesión de
navegador, pero el mecanismo es el mismo verificado ahí.

## Rutas de perfil

No se verificaron: al momento de este ticket, "Perfil" existe solo como ítem de navegación deshabilitado
(`available: false`, "Próximamente"), sin pantalla ni ruta real implementada todavía.

## Rollback disponible

Si algo fallara, alcanza con revertir la variable `VITE_API_BASE_URL` (o volver a un deployment anterior
de `watchparty-web` desde la pestaña Deployments) y redeployar sin build cache.
