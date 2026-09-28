# HomeHoard

Inventario de casa **completamente local**. Anota dónde guardas cada cosa y encuéntrala por nombre, habitación, mueble o con una pregunta como «¿dónde tengo guardada la linterna Philips?».

Funciona sin cuenta ni servicios externos. La web guarda sus datos en este navegador; la app móvil usa SQLite en el dispositivo. Para pasar datos entre ambos se exporta e importa una copia JSON local.

> Spec técnico completo: [`HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md`](./HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md)

## Qué hace (ya implementado)

- **Mapa 2D** de la planta con habitaciones y muebles (SVG), zoom y navegación por toques.
- **Plano editable** ✏️: arrastra habitaciones y muebles para recolocarlos y tira de la esquina para redimensionar, con snap a rejilla.
- **Inventario jerárquico**: Vivienda › Planta › Habitación › Mueble (anidable: cajón dentro de armario) › Objeto.
- **Alta rápida** con foto, ubicación (autoseleccionada por contexto), tags, cantidad y favorito, con "Guardar y añadir otro" y **aviso de duplicados** ("ya tienes X en el salón").
- **Búsqueda inteligente**: sin acentos, multi-palabra, ordenada por relevancia; busca también en notas, etiquetas y ubicaciones. Con el buscador vacío verás **favoritos y recientes**.
- **Acciones rápidas**: mantén pulsado cualquier objeto (o toca ⋯) para cambiar cantidad, moverlo, marcarlo favorito o eliminarlo sin salir de la pantalla.
- **Eliminar con deshacer**: los borrados muestran un aviso con "Deshacer" (tombstones, nada se pierde por un despiste).
- **Ver todo** lo que hay en una habitación o en un mueble (incluyendo lo anidado).
- **Crear con tipo e icono**: habitaciones (tipo + color) y muebles (tipo) desde sheets visuales; editar y borrar con seguridad (un mueble borrado deja sus objetos sueltos en la habitación; una habitación solo se borra si está vacía).
- **Etiquetas gestionables**: renombra, cambia el color o borra desde Ajustes.
- **Estadísticas** del inventario y **copia de seguridad**: exporta/importa todo como JSON portable, con las fotos incrustadas (local, sin nube). Las copias antiguas sin fotos siguen siendo importables.
- **Etiquetas QR**: imprime una etiqueta desde cada mueble/caja u objeto; «Escanear etiqueta QR» en Buscar abre su ficha, incluso sin conexión. Las etiquetas incluyen nombre y ubicación. Si eliminas el registro, la etiqueta avisa de que ya no existe.
- Arranca **sin datos inventados**. La casa de ejemplo se carga solo si se elige expresamente. Una instalación anterior con la casa de ejemplo se identifica y puede vaciarse desde Inicio.

## Consultar el inventario con Faustus

1. En HomeHoard abierto en este ordenador, ve a **Ajustes → Actualizar Faustus ahora**. La copia de consulta **excluye las fotos** y se guarda en `data/faustus-inventory.json`.
2. Pregunta a Faustus «¿dónde tengo guardada la linterna Philips?». La herramienta `home_find_item` devuelve la ruta completa y la fecha de la copia. Si no está en el inventario, responde que no lo encuentra.

Para una copia procedente del móvil, usa **Ajustes → Exportar copia** y cárgala en `http://127.0.0.1:5196/` en el ordenador. El puente se inicia con `python bridge/server.py` o desde Faustus.

Tras mover o añadir objetos, actualiza la copia. En móvil, transfiere el JSON al ordenador por el medio local que prefieras. El puente escucha solo en `127.0.0.1` y no sincroniza por internet.

## Arranque

Requisitos: Node 18+.

```bash
cd HomeHoard
npm install

# Web (navegador)
npm run web

# Móvil: abre en Expo Go (escanea el QR) o build nativo
npm start
npm run android
npm run ios
```

El lector QR usa `expo-camera`; tras instalar las dependencias hay que crear una nueva build nativa para incluir el permiso de cámara. La impresión usa el diálogo del sistema en móvil y la impresión del navegador en web.

## Cómo está montado

Reusa el stack Hoard (Expo + React Native + expo-router + TypeScript), sin la mitad online:

- **Datos:** una única interfaz `DataSource` (en `src/db/`) con dos implementaciones que Metro elige por plataforma:
  - **Nativo (iOS/Android):** `SqliteSource` sobre **expo-sqlite** en el dispositivo → `src/db/index.ts`.
  - **Web:** `MemorySource` en memoria, persistida en `localStorage` → `src/db/index.web.ts`.
  - Así expo-sqlite nunca entra en el bundle web (donde da problemas), como en WatchHoard.
- **Plano 2D:** `src/plan/FloorPlanView.tsx` con **react-native-svg** (idéntico en móvil y web), con modo edición (drag + resize con PanResponder, snap a rejilla).
- **Búsqueda:** `src/db/searchUtil.ts` — normalización sin acentos y ranking por relevancia, compartido por ambas fuentes de datos.
- **Pantallas:** `app/` (expo-router). Pestañas: Inicio · Plano · Buscar · Ajustes; más `room/`, `container/`, `item/`, y el modal `add`.
- **UI compartida:** `src/ui/` (incl. `ToastProvider` con deshacer). Formularios, sheets de creación, acciones rápidas y backup: `src/features/`.

### Estructura

```
HomeHoard/
  app/                     # rutas (expo-router)
    (tabs)/                # Inicio, Plano, Buscar, Ajustes
    room/[id].tsx          # habitación
    container/[id].tsx     # mueble (y sub-contenedores)
    item/[id].tsx          # objeto (editar/eliminar)
    add.tsx                # alta rápida (modal)
  src/
    db/                    # DataSource: types, schema, sqlite, memory, seed, provider
    plan/                  # plano 2D (SVG)
    features/              # ItemForm, LocationPicker, fotos
    ui/                    # componentes, tema, iconos, PromptProvider
```

## Notas y límites

- **Web** guarda en `localStorage` (suficiente para probar; en móvil los datos van a SQLite, más robusto). La cámara solo está en móvil; en web se usa la galería.
- La búsqueda se ejecuta en memoria sobre los datos ya decorados (`src/db/searchUtil.ts`): normaliza acentos, puntúa por relevancia (nombre > etiqueta > nota > ubicación) y es instantánea para inventarios personales. FTS5 queda como optimización si algún día hay decenas de miles de objetos.
- La **copia de seguridad JSON** versión 2 incluye las fotos en base64. Si una foto local falta, la exportación falla en vez de producir una copia incompleta. Las copias versión 1 se pueden importar, pero sus URI originales podrían no existir en otro dispositivo.

## Licencia

AGPL-3.0-or-later (como el resto de la familia Hoard).
