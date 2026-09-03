# WatchParty — Sistema de diseño

Fuente de verdad visual del producto. Cuando este documento y cualquier otra guía
se contradigan, manda este documento.

## Dirección visual

```text
Football × Social × Live
```

WatchParty acompaña un partido en vivo. La interfaz es la segunda pantalla de
alguien que está mirando fútbol: tiene que leerse de un vistazo, no competir con
el partido.

**Debe sentirse:** moderno, deportivo, social, rápido, limpio.

**Hay que evitar:** estética de apuestas o casino, gradientes excesivos,
interfaces recargadas de gaming, glassmorphism exagerado, sombras o glows
grandes, emojis como iconografía principal, ruido visual innecesario.

## Color

Los colores se consumen **siempre** por su token semántico, nunca por su valor
hexadecimal. Los valores viven en `apps/web/src/index.css`: en `:root` para el
tema claro y en `.dark` para el oscuro, expuestos a Tailwind mediante
`@theme inline`.

| Token                  | Claro     | Oscuro    | Uso                                     |
| ---------------------- | --------- | --------- | --------------------------------------- |
| `background`           | `#F4F7F5` | `#080D16` | Fondo de la aplicación                  |
| `foreground`           | `#111A15` | `#F8FAFC` | Texto principal                         |
| `card` / `popover`     | `#FFFFFF` | `#131D2C` | Superficies elevadas                    |
| `card-foreground`      | `#111A15` | `#F8FAFC` | Texto sobre superficies                 |
| `primary`              | `#00B443` | `#00B443` | Marca, acciones principales, selección  |
| `primary-foreground`   | `#08110A` | `#08110A` | Texto sobre verde                       |
| `secondary`            | `#031E3A` | `#031E3A` | Acciones secundarias, acentos profundos |
| `secondary-foreground` | `#F8FAFC` | `#F8FAFC` | Texto sobre azul profundo               |
| `muted` / `accent`     | `#EDF3EF` | `#192638` | Fondos sutiles, hover                   |
| `muted-foreground`     | `#526159` | `#94A3B8` | Texto secundario                        |
| `destructive`          | `#D9363E` | `#F04444` | Errores y acciones destructivas         |
| `live`                 | `#D9363E` | `#F04444` | Estado LIVE de un partido               |
| `border` / `input`     | `#D4DFD7` | `#253247` | Bordes y contornos de campos            |
| `ring`                 | `#00B443` | `#00B443` | Anillo de foco                          |

### Reglas de color

- **Verde** identifica la marca, las acciones principales, la selección y las
  calificaciones. No usarlo como color decorativo de relleno.
- **Rojo** se reserva para LIVE, alertas y errores. Si todo es rojo, nada avisa.
- El azul profundo `secondary` es un acento, no un fondo de página.
- Ningún estado puede distinguirse **solo** por color: acompañar con icono,
  texto, peso tipográfico o `aria-current`.
- Los colores de club, cuando existan, van subordinados a la paleta del producto.

### Reservados, todavía no implementados

`warning` (`#B96A00` claro / `#F59E0B` oscuro) e `info` (`#2563EB` claro /
`#3B82F6` oscuro) forman parte del sistema pero aún no tienen token en CSS.
Agregarlos recién cuando un ticket los necesite.

## Tipografía

| Familia | Token          | Pesos   | Uso                                             |
| ------- | -------------- | ------- | ----------------------------------------------- |
| Sora    | `font-display` | 600–700 | Títulos, marcadores, valores destacados         |
| Inter   | `font-sans`    | 400–800 | Interfaz, cuerpo, navegación, formularios, chat |

Ambas se declaran con fallback a la pila del sistema. No introducir familias
nuevas.

> **Estado:** Sora se carga desde Google Fonts en `apps/web/index.html` (pesos
> 600 y 700), así que `font-display` ya rinde con la familia real. Inter todavía
> no se carga: `font-sans` se resuelve a la pila del sistema hasta que un ticket
> la incorpore.

## Radios

| Token        | Valor | Uso                                             |
| ------------ | ----- | ----------------------------------------------- |
| `rounded-sm` | 8 px  | Chips, campos compactos, mensajes de error      |
| `rounded-md` | 12 px | Botones, inputs — es el radio base (`--radius`) |
| `rounded-lg` | 16 px | Cards, contenedores                             |
| `rounded-xl` | 20 px | Superficies grandes, hojas y modales            |

## Espaciado

Escala de 4 px. Los saltos habituales son **8, 12, 16, 24 y 32 px**, es decir las
utilidades `gap-2`, `gap-3`, `gap-4`, `gap-6` y `gap-8` de Tailwind. Preferir
`gap` sobre márgenes sueltos al distribuir hijos de un contenedor.

## Iconografía

`lucide-react` es el sistema de iconos. No pegar SVG sueltos duplicando un icono
que Lucide ya tiene, no mezclar librerías y no usar emojis como iconografía
principal. Tamaño por defecto 16 px dentro de botones; el área táctil mínima es
44 × 44 px.

## Componentes

Los primitives viven en `apps/web/src/components/ui/` y provienen de shadcn/ui.
Antes de crear un componente hay que buscar el equivalente existente y, si hace
falta, extender su variante.

| Carpeta                           | Contiene                              |
| --------------------------------- | ------------------------------------- |
| `apps/web/src/components/ui/`     | Primitives de shadcn/ui               |
| `apps/web/src/components/layout/` | Header, navegación y piezas de layout |
| `apps/web/src/features/`          | Pantallas y componentes por dominio   |
| `apps/web/src/layouts/`           | Layouts de ruta                       |

## Jerarquía de la información de fútbol

Cuando se muestre un partido, el orden de lectura es: competencia y estado →
equipos → marcador o horario → minuto en vivo → información social → acción
principal.

En pantallas densas, mobile **reorganiza** el contenido en secciones o pestañas.
Nunca se achica el layout de desktop sin repensarlo.

## Estados y foco

- El foco siempre es visible y usa `ring`. No eliminar el outline sin reemplazo.
- Todo control interactivo necesita nombre accesible, independiente del
  placeholder.
- Estados deshabilitados y "próximamente" se comunican con `aria-disabled`,
  texto y tooltip, no solo con opacidad.
- Transiciones de ~150 ms.

## Responsive

Enfoque **mobile-first**.

- Nada de anchos fijos en píxeles para páginas, formularios, cards, headers,
  navegaciones ni contenedores.
- Usar `w-full`, porcentajes, Flexbox, Grid, `minmax()` y los tokens `max-w-*`
  existentes.
- Prohibidos los valores arbitrarios como `w-[420px]` o `max-w-[860px]`.
- `min-w-0` en hijos flexibles que puedan desbordar.
- Dimensiones fijas permitidas **solo** para iconos, bordes, avatares y áreas
  táctiles mínimas.
- Nunca puede haber desplazamiento horizontal.

Validar como mínimo en **320, 390, 768, 1024, 1280 y 1440 px**.

El corte entre navegación móvil y de escritorio del producto está en **981 px**.

## Accesibilidad

Contraste legible en ambos temas, foco visible, botones y enlaces semánticos
(un enlace navega, un botón actúa), nombres accesibles, áreas táctiles cómodas,
texto legible en mobile y estados que no dependan únicamente del color.

## Movimiento

Movimiento discreto: transiciones de ~150 ms, hovers sutiles, indicador LIVE
contenido. Respetar siempre `prefers-reduced-motion`.
