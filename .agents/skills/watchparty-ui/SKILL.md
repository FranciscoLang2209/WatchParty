---
name: watchparty-ui
description: Apply and preserve the WatchParty design system when creating, editing, refactoring, or reviewing frontend UI in this repository. Covers pages, components, layouts, navigation, responsive behavior, accessibility and themes.
---

# watchparty-ui

Guía para trabajar la interfaz de WatchParty de forma consistente. Aplica a cualquier tarea que cree, edite, refactorice o revise UI. **No** aplica a tareas exclusivamente de backend o infraestructura.

## Fuente de verdad

Los valores concretos de color, tipografía, radios, espaciado y componentes
viven en un único lugar: [`../../../DESIGN_SYSTEM.md`](../../../DESIGN_SYSTEM.md).
Este skill dice **cuándo** leerlo y **cómo** trabajar; no lo duplica.

Si este skill y `DESIGN_SYSTEM.md` se contradicen, manda `DESIGN_SYSTEM.md`.

## Dirección del producto

```text
Football × Social × Live
```

WatchParty se usa mientras hay un partido en curso: es la **segunda pantalla** de
alguien que está mirando fútbol. Debe sentirse moderno, deportivo, social, rápido
y limpio, y leerse de un vistazo sin competir con el partido.

Hay que evitar estética de apuestas o casino, gradientes excesivos, interfaces
recargadas de gaming, glassmorphism exagerado, sombras o glows grandes, emojis
como iconografía principal y ruido visual innecesario.

Como criterio rápido: **Sora** para títulos y valores destacados, **Inter** para
interfaz y texto general; el **verde** identifica marca, acciones principales y
selección; el **rojo** se reserva para LIVE, alertas y errores. Los valores
concretos están en `DESIGN_SYSTEM.md`.

## Antes de tocar la interfaz

1. Leer `DESIGN_SYSTEM.md`.
2. Releer el ticket asignado y delimitar su alcance exacto.
3. Inspeccionar la implementación actual de la pantalla o componente.
4. Buscar componentes existentes antes de crear uno nuevo.
5. Reutilizar tokens, primitives y patrones ya presentes.
6. Implementar únicamente lo pedido.
7. Verificar responsive y accesibilidad.
8. Ejecutar las validaciones correspondientes.

## Stack real

| Pieza      | Qué se usa                                                            |
| ---------- | --------------------------------------------------------------------- |
| Framework  | React + TypeScript sobre Vite                                         |
| Estilos    | Tailwind CSS v4, tokens semánticos en `apps/web/src/index.css`        |
| Primitives | shadcn/ui en `apps/web/src/components/ui/`                            |
| Iconos     | `lucide-react`                                                        |
| Ruteo      | React Router, con rutas privadas protegidas por el guard del proyecto |
| Sesión     | Supabase, **solo** para Auth                                          |

Ubicaciones dentro del monorepo:

```text
apps/web/src/components/ui/      primitives de shadcn/ui
apps/web/src/components/layout/  header, navegación, piezas de layout
apps/web/src/features/           pantallas y componentes por dominio
apps/web/src/layouts/            layouts de ruta
```

Usar siempre estas rutas completas: `components/ui` a secas es ambiguo en un
monorepo.

### Fuera del stack

No proponer ni introducir Next.js, `next/image`, `next/navigation`, App Router,
Server Components, Drizzle, estilos globales copiados de otro repositorio ni
dependencias ajenas al proyecto. Los datos de la aplicación se consumen desde la
Node API: no usar `supabase.from(...)` en la web.

## Precedencia

Ante cualquier duda, resolver en este orden:

1. Requerimientos explícitos del ticket.
2. Contratos y arquitectura ya aprobados en WatchParty.
3. `DESIGN_SYSTEM.md`.
4. Decisiones visuales del mockup de referencia.

## Alcance

> El sistema de diseño orienta **cómo** implementar el alcance solicitado, pero
> no autoriza a agregar funcionalidades, pantallas, rutas, datos, navegación o
> componentes que no estén incluidos en el ticket actual.

Si el mockup muestra algo que el ticket no pide o que todavía no tiene soporte
de backend, no implementarlo con datos falsos, no agregar botones inertes, no
crear rutas placeholder y no ampliar el alcance sin autorización. Una sección
que aún no existe se comunica como no disponible, con nombre accesible y
tooltip, sin romper la navegación.

## La referencia visual no es arquitectura

El mockup indica cómo se ve el producto, no cómo se construye. No copiar
componentes monolíticos, no portar estado local de navegación, no importar sus
dependencias, no reemplazar el router real, no reemplazar los providers
existentes y no crear una segunda paleta o un segundo sistema de componentes.

El destino activo de la navegación se deriva **de la URL** mediante el router,
nunca de un estado paralelo.

## Reutilizar antes de crear

Buscar un equivalente existente antes de escribir un componente nuevo,
especialmente para: botones, inputs, labels, cards, badges, tabs, header,
navegación inferior, formularios, estados de carga y error, tarjetas de partido
y resúmenes de partido.

Si falta una variante, extender el primitive existente en lugar de duplicar
markup o estilos.

## Responsive

Mobile-first, sin anchos fijos en píxeles para layouts. Las reglas completas
están en `DESIGN_SYSTEM.md`; lo que no se negocia:

- `w-full`, porcentajes, Flexbox, Grid, `minmax()` y tokens `max-w-*`.
- Nada de valores arbitrarios como `w-[420px]` o `max-w-[860px]`.
- `min-w-0` en hijos flexibles que puedan desbordar.
- Fijo solo para iconos, bordes, avatares y áreas táctiles mínimas.
- Reorganizar el contenido cuando cambia el espacio disponible, en lugar de
  encoger el layout de desktop.

Validar en **320, 390, 768, 1024, 1280 y 1440 px**, comprobando en cada uno:

- Ausencia de desplazamiento horizontal.
- Ausencia de contenido cortado o superpuesto.
- Comportamiento de nombres y textos extensos.
- Navegación mediante teclado.
- Áreas táctiles apropiadas.
- Estados que no dependan únicamente del color.
- Dark Mode y Light Mode.

Recordar que JSDOM no evalúa media queries: la visibilidad por breakpoint se
valida visualmente o con una prueba de navegador.

## Temas

Todo componente relevante funciona en Dark Mode y Light Mode usando los tokens
semánticos. Verificar superficies, cards, bordes, texto, texto atenuado,
botones, inputs, hover, selección, foco y sombras en ambos temas.

## Accesibilidad

Foco visible, contraste suficiente, botones y enlaces semánticos, nombres
accesibles independientes del placeholder, áreas táctiles de al menos
44 × 44 px y estados que no se distingan solo por color. Los errores se anuncian
en una región `aria-live` y las operaciones pendientes se comunican con
`aria-busy` y con el texto del control.

## Movimiento

Discreto: transiciones de ~150 ms y hovers sutiles. Respetar siempre
`prefers-reduced-motion`.

## Terminado

Una tarea de UI está lista cuando:

- Se implementó exactamente lo pedido, sin tocar áreas ajenas.
- Se respetó `DESIGN_SYSTEM.md` y se reutilizaron los componentes existentes.
- Funciona en Dark Mode y Light Mode.
- Funciona en mobile y en desktop, sin desplazamiento horizontal.
- Es operable por teclado y tiene foco visible.
- Las validaciones terminan en código 0:

```sh
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter web build
```

Ante la duda, inspeccionar la aplicación existente y el sistema de diseño antes
de inventar un patrón nuevo.
