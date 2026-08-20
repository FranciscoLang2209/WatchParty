# WatchParty

Aplicación web social para vivir cada partido de fútbol en tiempo real: salas por partido, comentarios, reacciones, calificaciones e historial personal.

## Prerrequisitos

- [Node.js 24.19.0](https://nodejs.org/) (gestionado vía [nvm](https://github.com/nvm-sh/nvm); ver `.nvmrc`)
- [pnpm 10.34.0](https://pnpm.io/) (gestionado vía Corepack)
- [Corepack](https://nodejs.org/api/corepack.html) habilitado (`corepack enable`)
- [Docker Desktop](https://docs.docker.com/desktop/) en ejecución (requerido por Supabase CLI para levantar el stack local)

## Instalación

```sh
nvm use
corepack use pnpm@10.34.0
pnpm install
```

## Validación local

Antes de abrir un Pull Request, correr:

```sh
pnpm validate
```

Este comando ejecuta, en orden: formato (`prettier --check`), lint (`eslint`), chequeo de tipos, tests y build de todos los paquetes del monorepo (`apps/*`).

También podés correr cada paso por separado:

```sh
pnpm format         # chequea formato
pnpm format:write   # corrige formato automáticamente
pnpm lint           # analiza el código con ESLint
pnpm typecheck      # chequea tipos de TypeScript
pnpm test           # corre los tests
pnpm build          # compila todas las apps
```

## Estructura

Monorepo gestionado con pnpm workspaces (`apps/*`).

- `apps/api`: backend (Node + Express + TypeScript). Ver [`apps/api/README.md`](./apps/api/README.md).
- `apps/web`: frontend (por agregar en un ticket posterior).

## Supabase (desarrollo local)

El proyecto usa la [Supabase CLI](https://supabase.com/docs/guides/local-development) para levantar un stack
local de Supabase (Postgres, Auth, Storage, Realtime, Studio) en contenedores Docker. No hay ningún proyecto
remoto vinculado: todo corre en tu máquina.

### Precondición

Docker Desktop debe estar abierto y con el motor en ejecución antes de iniciar el stack.

### Ciclo de uso

```sh
pnpm supabase:start   # levanta el stack local (puede tardar la primera vez por la descarga de imágenes)
pnpm supabase:status  # muestra el estado y las URLs de los servicios locales
pnpm supabase:stop    # detiene el stack
```

Al iniciar, la CLI expone Studio, la API REST/GraphQL, Auth y la base de datos en `127.0.0.1` con claves de
desarrollo predeterminadas (no son secretos reales; son las mismas para cualquier instancia local).

### Limitación de uso: sólo local

- El stack no está pensado para exponerse públicamente: todos los servicios bindean a `0.0.0.0` y Studio,
  `pg-meta` y analytics no tienen autenticación.
- No ejecutar `supabase link` ni commitear `project_ref`, claves ni credenciales de un proyecto remoto.
- `supabase/.temp` y los datos generados localmente no se versionan (ver `.gitignore`).

## Despliegue del frontend (Vercel)

Sólo se despliega `apps/web`. `apps/api` no forma parte del proyecto Vercel: no tiene funciones,
rutas, build commands ni Root Directory asociados.

### Configuración del proyecto

La configuración vive en los Project Settings de Vercel; el repositorio no incluye `vercel.json`.

| Ajuste            | Valor            |
| ----------------- | ---------------- |
| Project Name      | `watchparty-web` |
| Root Directory    | `apps/web`       |
| Framework Preset  | `Vite`           |
| Output Directory  | `dist`           |
| Node.js Version   | `24.x`           |
| Production Branch | `main`           |

### Ciclo de despliegue

El proyecto está conectado a GitHub y la rama de producción es `main`:

- **Preview**: cada pull request y cada commit fuera de `main` genera un despliegue de vista previa
  con su propia URL, para revisar los cambios antes de integrarlos.
- **Production**: cada merge a `main` publica la versión definitiva.

| Entorno    | URL                                     |
| ---------- | --------------------------------------- |
| Production | https://watch-party-web-cfeq.vercel.app |
| Preview    | se genera una por cada pull request     |

### Validación manual con la CLI

Opcional, para verificar el despliegue desde la máquina local. Ejecutar desde `apps/web`:

```sh
pnpm build
pnpm dlx vercel@latest link --yes --project watchparty-web
pnpm dlx vercel@latest deploy          # despliegue de preview
pnpm dlx vercel@latest deploy --prod   # despliegue de producción
```

`vercel link` crea un directorio `.vercel` con el estado local de la CLI. Está ignorado por Git
(`**/.vercel` en `.gitignore`) y no debe versionarse.
