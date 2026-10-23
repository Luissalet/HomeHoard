---
name: HomeHoard
description: Sistema visual existente observado en Kits y equipo
colors:
  amber: "#e5913f"
  amber-ink: "#1b1713"
  warm-ground: "#1c1814"
  warm-surface: "#24201b"
  warm-raised: "#2f2a25"
  warm-border: "#433c35"
  warm-text: "#ece7e1"
  warm-muted: "#beb9b4"
  error: "#e0685c"
  success: "#6cbf8c"
  warning: "#d4a843"
typography:
  headline:
    fontFamily: "'Cinzel', 'Iowan Old Style', Charter, Georgia, 'Liberation Serif', 'Noto Serif', 'Times New Roman', serif"
    fontSize: "30px"
    fontWeight: 700
  title:
    fontFamily: "'Cinzel', 'Iowan Old Style', Charter, Georgia, 'Liberation Serif', 'Noto Serif', 'Times New Roman', serif"
    fontSize: "20px"
    fontWeight: 700
  body:
    fontSize: "13px"
    lineHeight: 1.4615384615
  item:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.5px"
rounded:
  sm: "8px"
  md: "12px"
  pill: "999px"
spacing:
  unit: "4px"
  field: "6px"
  compact: "8px"
  control: "12px"
  panel: "16px"
  page: "20px"
  columns: "24px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.sm}"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.warm-raised}"
    textColor: "{colors.warm-text}"
    rounded: "{rounded.sm}"
    height: "48px"
  input:
    backgroundColor: "{colors.warm-raised}"
    textColor: "{colors.warm-text}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  saved-kit-selected:
    backgroundColor: "{colors.warm-raised}"
    textColor: "{colors.warm-text}"
    rounded: "{rounded.sm}"
    padding: "12px"
  card:
    backgroundColor: "{colors.warm-surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  chip:
    backgroundColor: "{colors.warm-raised}"
    textColor: "{colors.warm-muted}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
---

# Design System: HomeHoard

## Overview

**Creative North Star: "El inventario cálido"**

Nombre descriptivo del mundo ya construido, no una dirección nueva elegida con el usuario. El fondo marrón oscuro, las superficies cálidas y los encabezados serif dan continuidad a HomeHoard. El ámbar distingue acciones y ubicaciones; los controles sans dejan que los nombres y las cantidades lleven la lectura.

Registro acotado a `app/kits.tsx`, sus primitivas compartidas y `src/theme.ts` en la fuente aprobada `ed9cc0d2c69067d8e70b2185db2eaaff4e159463` (tarea 1298, revisión 1). Las capturas web `desktop.png` (1280×900), `mobile.png`, `mobile-result.png` y `mobile-error.png` (390×900) de `D:/LocalAI/research-inbox/home-kit-search23/` concuerdan con estos valores. La tercera muestra la parte inferior del contenido. `PEER-REVIEW.md` contiene el veredicto independiente `ship`. Este documento no amplía ese veredicto a otras pantallas: la estrategia de Kits sigue en `.impeccable/surfaces/app-kits-tsx.md`.

**Key Characteristics:**
- Fondo oscuro cálido y superficies planas con bordes discretos.
- Encabezados serif; controles y datos en la tipografía sans de la plataforma.
- Ámbar para acciones principales y rutas de ubicación; texto explícito para los estados.

## Colors

La paleta oscura observada procede de `src/theme.ts`; los nombres descriptivos del frontmatter corresponden a sus roles existentes, sin cambiar los tokens de ejecución.

### Primary
- **Ámbar:** `accent` y `accent2`; fondo de la acción principal, iconos seleccionados y ruta de ubicación.
- **Tinta sobre ámbar:** `onAccent`; texto oscuro sobre la acción principal.

### Neutral
- **Fondo cálido:** `bg`; lienzo de Kits y cabecera del stack.
- **Superficie cálida:** `surface`; primitiva compartida Card, inspeccionada en fuente, sin convertir los paneles de Kits en tarjetas.
- **Superficie elevada cálida:** `surface2`; campos, acciones secundarias y fila de kit seleccionada.
- **Borde cálido:** `border`; contornos y separadores.
- **Texto cálido / texto atenuado:** `text` / `textDim`; nombres y títulos frente a ayuda, etiquetas y cantidades secundarias.

### Estados
- **Error:** `danger`; mensaje de fallo y texto de borrado en la acción local de Kits.
- **Éxito:** `good`; existencias suficientes y casilla de recogida marcada.
- **Aviso:** `warn`; desconexión, faltantes o comprobación incompleta, siempre explicados por texto.

El tema claro sigue disponible en Ajustes y definido en `src/theme.ts`; no se extrae ni se certifica aquí porque las cuatro capturas son oscuras. Las rampas del sidecar son muestras sintéticas para el panel, no nuevos tokens del producto ni colores autorizados para sustituir esta paleta.

## Typography

**Display Font:** no hay rol display independiente en Kits. **Body Font:** sans predeterminada de React Native Web; no se fija una familia de marca para controles. **Label/Mono Font:** las etiquetas usan la misma sans; no hay mono observado.

**Character:** serif de la pila declarada en el frontmatter para encabezados y sans para operar. La declaración de Cinzel como primera alternativa no prueba que esa fuente se haya descargado o resuelto en el navegador de las capturas.

### Hierarchy
- **Headline:** título de pantalla, según `headline`; sin altura de línea explícita en fuente.
- **Title:** secciones, según `title`; sin altura de línea explícita.
- **Body:** ayuda, según `body`, con altura de línea fuente de 19 px.
- **Item:** nombres, según `item`, con altura de línea de 21 px.
- **Label:** etiquetas de campo, según `label`, en mayúsculas.
- **Acción local:** 13 px y peso 600; **veredicto:** 16 px, peso 600 y altura de línea de 23 px.

## Layout

El ritmo compartido procede de `space(n) = n × 4`. Kits limita el contenido a 1100 px, lo centra y aplica 20 px de padding, 20 px de separación vertical y 56 px al final. Desde 850 px de ventana, biblioteca y editor forman dos columnas con 24 px de separación y biblioteca de 245 px; por debajo se apilan. Son reglas de esta superficie, no una plantilla universal para HomeHoard.

Las capturas verifican el apilado a 390 px y las columnas a 1280 px. Selección y resultado continúan dentro del ScrollView; no caben necesariamente en el primer viewport. Filas de selección, acciones y recogida permiten reflujo. Los botones locales tienen altura mínima de 48 px; los controles de icono y cantidad, mínimo de 44 px. `height` en los ejemplos del frontmatter representa la referencia mínima del botón, no una altura fija que recorte texto.

No hay evidencia de prueba nativa Android/iOS, teclado en vivo, nombres largos medidos ni contraste global; tampoco de otras anchuras, escalas de fuente o temas. La captura inválida histórica queda excluida. El aviso `config-build-path-unset` de context.mjs permanece como aviso de configuración; este paso no lo repara.

## Elevation & Depth

Kits es plano: profundidad por cambios de tono y separadores, sin sombras en sus paneles o acciones. La cabecera del stack desactiva su sombra. La primitiva FAB compartida sí tiene sombra en fuente, pero queda fuera de esta superficie y no se convierte en regla global. No hay transiciones temporizadas propias de Kits; pulsar una acción cambia la opacidad a 0.75 y deshabilitarla a 0.5. El desplazamiento hacia la comprobación se solicita sin animación.

## Shapes

Acciones y filas seleccionadas usan esquinas suaves pequeñas (`sm`); campos y Card compartida, medianas (`md`). Chip compartido usa cápsula (`pill`). El borde de las acciones locales es de 1 px; inputs, Card y filas separadoras usan `StyleSheet.hairlineWidth`, dependiente de plataforma. No se equipara ese valor a una constante universal de un píxel.

## Components

### Buttons

Acciones directas, con etiqueta completa. Las variantes locales comparten forma, borde y padding horizontal de 12 px. Primary usa ámbar y su tinta; secondary usa superficie elevada y texto normal. Borrar conserva la superficie secundaria y colorea el texto de error. El estado pulsado y el deshabilitado son los descritos en Elevation & Depth. No existe tratamiento hover propio ni anillo focus propio declarado en estas acciones; el navegador aporta sus affordances y este registro no certifica su cobertura por teclado.

### Inputs / Fields

Campo cálido, borde fino, padding del token `input` y texto de 16 px. Field coloca la etiqueta en mayúsculas con 6 px de separación. El placeholder comparte el tono atenuado. La captura muestra foco visible en búsqueda; no hay token de anillo explícito en el componente. Fallos de lista se presentan como texto de error y acción de reintento, conservando el editor. El sidecar mantiene el outline del navegador en sus ejemplos y no inventa un token de foco del producto.

### Navigation

La fila de kit abre el editor o actúa como casilla al combinar; icono de 20 px, altura mínima de 52 px y nombre/detalle jerarquizados. Selección añade superficie elevada e icono ámbar. No es un nuevo sistema de navegación global. Los controles Anteriores/Siguientes reutilizan acciones secundarias.

### Selección y recogida

La selección muestra cada nombre y su acción Quitar en una fila flexible. La recogida comienza tras un separador, con título serif, veredicto semántico y cantidades/ruta por objeto. La ruta usa ámbar; la marca temporal de recogida usa éxito. Estos son patrones existentes de Kits, no componentes nuevos añadidos por la documentación.

### Cards / Containers

La Card compartida inspeccionada en `src/ui/components.tsx` usa superficie cálida, borde fino, radio mediano y padding de 16 px; al pulsarla cambia opacidad a 0.7. Es un ejemplo de fuente, no una tarjeta presente en las capturas de Kits. Biblioteca y editor de Kits se separan mediante espacio.

### Chips

La primitiva compartida inspeccionada usa cápsula, borde de 1 px, texto 13 px/600 y padding de 6 px por 12 px. Seleccionada usa ámbar con tinta oscura. No aparece como filtro de Kits; su inclusión conserva la primitiva existente, sin proponer nuevos filtros.

## Do's and Don'ts

### Do:
- **Do** conservar los roles de color y la pareja serif/sans de la fuente existente al ampliar Kits.
- **Do** mantener los estados de selección y resultado legibles mediante texto además del color.
- **Do** conservar el reflujo y las alturas mínimas de las acciones locales al cambiar sus etiquetas.

### Don't:
- **Don't** extender la composición de Kits a otras pantallas como requisito global.
- **Don't** presentar rampas sintéticas o snippets del panel como nuevos tokens o código de producto.
- **Don't** presentar las capturas web de 390 px como validación Android/iOS o del tema claro.
