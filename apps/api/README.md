# @watchparty/api

Backend de WatchParty: servicio Node + Express + TypeScript.

## Requisitos

Ver los prerrequisitos generales en el [README de la raíz](../../README.md) (Node 24.19.0, pnpm 10.34.0).

## Scripts

Desde la raíz del monorepo, usando `--filter`:

```sh
pnpm --filter @watchparty/api dev         # levanta el servidor en modo desarrollo (reinicia con cada cambio)
pnpm --filter @watchparty/api build       # compila TypeScript a dist/
pnpm --filter @watchparty/api start       # corre el servidor ya compilado (dist/server.js)
pnpm --filter @watchparty/api lint        # analiza el código con ESLint
pnpm --filter @watchparty/api typecheck   # chequea tipos sin compilar
pnpm --filter @watchparty/api test        # corre los tests
```

## Variables de entorno

- `PORT` (opcional): puerto en el que escucha el servidor. Por defecto, `3000`.

## Endpoints

### `GET /health`

Chequeo de salud del servicio. No requiere autenticación ni parámetros.

**Respuesta:**

- Status: `200 OK`
- Body:

```json
{ "status": "ok" }
```

**Ejemplo:**

```sh
curl -i http://localhost:3000/health
```

## Smoke test local: Auth → Partidos

Script que verifica de punta a punta la cadena Supabase Auth → API, sin mocks:
registra un usuario temporal contra Supabase, obtiene un access token real y
valida que `GET /matches` y `GET /matches/:matchId` respondan según lo
esperado (200 listado, 200 detalle existente, 404 detalle inexistente, 401
sin token).

**No corre en CI** — necesita Docker, Supabase local y la API levantada al
mismo tiempo.

### Precondiciones

1. Docker Desktop corriendo.
2. Supabase local levantado: `pnpm supabase:start` (desde la raíz del repo).
3. `apps/api/.env` configurado con `SUPABASE_URL` y `SUPABASE_ANON_KEY`
   (los valores locales salen de `pnpm supabase:status`) y `WEB_ORIGIN`.
4. La API corriendo: `pnpm --filter @watchparty/api dev`.

### Ejecución

Con las precondiciones de arriba cumplidas, desde la raíz del repo:

```sh
pnpm --filter @watchparty/api smoke:auth-matches
```

Cada corrida crea un usuario temporal distinto — no se reutiliza ni se
versiona ningún usuario, contraseña o token real. El script termina con
código de salida distinto de 0 si algún chequeo falla.
