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
