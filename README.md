# WatchParty

Aplicación web social para vivir cada partido de fútbol en tiempo real: salas por partido, comentarios, reacciones, calificaciones e historial personal.

## Prerrequisitos

- [Node.js 24.19.0](https://nodejs.org/) (gestionado vía [nvm](https://github.com/nvm-sh/nvm); ver `.nvmrc`)
- [pnpm 10.34.0](https://pnpm.io/) (gestionado vía Corepack)
- [Corepack](https://nodejs.org/api/corepack.html) habilitado (`corepack enable`)

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
