# HomeHoard

[English](README.md)

Inventario de casa **completamente local**. Anota dónde guardas cada cosa y encuéntrala por nombre, habitación, mueble o con una pregunta como «¿dónde tengo guardada la linterna Philips?».

Funciona sin cuenta ni servicios externos. **El ordenador guarda la casa**: el servidor de HomeHoard (`python bridge/server.py`, solo en `127.0.0.1:5196`) tiene el inventario completo y las fotos, sirve la web y responde a Faustus. La web se sincroniza con él y guarda una copia en el navegador para seguir funcionando sin conexión. La app móvil usa SQLite en el dispositivo y pasa sus datos al ordenador con una copia JSON local.

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
- **Ficha de cada aparato u objeto**: marca, modelo, número de serie, fecha y tienda de compra, precio, garantía (escrita a mano o tomada de Kafka), enlace al manual, consumibles y recambios («filtro campana 3x», «pilas CR2032 ×2», cantidad, última compra) y notas. Plegable; sin editar solo enseña lo que está relleno.
- **Papeles en Kafka's Hoard**: cada objeto puede vincular documentos de Kafka (factura, ticket, garantía, manual). La ficha enseña su título, tipo, fecha y el estado de la garantía con su base y la cita del documento; **Vincular documento** busca en Kafka y **Subir factura / manual** manda un archivo a Kafka (los manuales con el tipo `manual`) y lo vincula. **Manual** busca dentro de los manuales vinculados y devuelve fragmentos con la página.
- **Mantenimiento**: tareas sobre un objeto, mueble, habitación o la vivienda, cada cierto número de días o meses y, si se quiere, en un mes concreto (purgar radiadores en octubre). Pestaña **Mantenimiento** con vencidas, este mes y próximas (o agrupadas por sitio), **Hecho** con fecha, nota, coste y quién, historial, pausa y fecha fijada a mano. Bloque de mantenimiento en cada objeto y habitación con sugerencias según el nombre (caldera, aire, lavadora, lavavajillas, cafetera, campana, frigorífico, detector…) o el tipo de habitación.
- **Plantillas con su base**, revisadas el 02-10-2026. Obligaciones legales, con su norma: caldera de gas de vivienda (≤ 70 kW) **al menos cada 2 años** por empresa habilitada (RITE, RD 1027/2007, IT 3.3; muchos fabricantes piden revisión anual); instalación de gas **cada 5 años** (RD 919/2006, ITC-ICG 07; con gas de red avisa la distribuidora, con butano o propano la contratas tú); aire acondicionado o bomba de calor de vivienda: hasta 12 kW **cada 4 años**, de 12 a 70 kW **cada 2 años** (RITE IT 3.3). El resto son **recomendaciones** y se presentan como tales: purgar radiadores, filtros del split, filtro del lavavajillas, limpieza de la lavadora, descalcificar la cafetera, filtro de la campana, pilas del detector de humo, rejilla del frigorífico, desagües y sifones, juntas de silicona.
- **Avisos mediante Kafka**: con el ajuste **Avisar mediante Kafka** (activado por defecto), el ordenador refleja cada tarea activa como un plazo de Kafka («Mantenimiento: tarea (objeto)», con la norma o «Recomendación» en la explicación y una clave estable, sin duplicados). Marcar hecho mueve el plazo; borrar o pausar la tarea lo cierra. Si Kafka o el Hub no responden, queda en cola y se reintenta; la pestaña dice cuántos están en Kafka y cuántos pendientes y por qué. Kafka avisa por sus canales (aviso de Windows, bus de la familia, ntfy, Telegram, correo).
- **Tema oscuro de la familia Hoard** por defecto (fondo #1c1814, acento ámbar, títulos con serifa); la paleta clara anterior se elige en **Ajustes → Apariencia**. La cabecera de Inicio dice dónde está la casa: «Sincronizado con el ordenador», «Sin conexión con el ordenador» o, en el móvil, «En este dispositivo».
- Arranca **sin datos inventados**. La casa de ejemplo se carga solo si se elige expresamente. Una instalación anterior con la casa de ejemplo se identifica y puede vaciarse desde Inicio.

## El ordenador guarda la casa

- `python bridge/server.py` (o `npm run server`, o desde Faustus/Hub) arranca el servidor en `http://127.0.0.1:5196`. Guarda todo en `data/home.json` (cada registro con `updated_at` y lápida `deleted_at`, escrituras atómicas con la biblioteca de la familia y un `version` que crece) y las fotos como archivos en `data/photos/`. El token (`data/mcp-token`) se crea una vez y se conserva entre arranques; `data/url` guarda la dirección.
- `npm run build:web` exporta la web a `bridge/web/` y el servidor la sirve en `/` (con enlaces directos como `/item/<id>`). Sin exportar, `/` explica cómo hacerlo.
- La web, servida por él o abierta en `localhost`/`127.0.0.1` mientras él responde, carga la casa de `/api/home`, guarda una copia en `localStorage`, envía cada cambio a `/api/home/sync` (agrupado, con reintentos) y pregunta `/api/home/version` cada pocos segundos para ver lo que cambie Faustus. Sin conexión aparece «Sin conexión con el ordenador» y los cambios esperan en el navegador. La primera vez que un navegador con datos antiguos encuentra el ordenador, se los envía.
- **Combinación**: registro a registro gana el `updated_at` más reciente; en empate gana la lápida. Los vínculos objeto–etiqueta tienen id `<objeto>:<etiqueta>` y también lápidas. Las fotos pasan a archivos del ordenador. La casa de ejemplo nunca se envía; si el ordenador ya tiene una casa, la sustituye.
- **Importar copias** (por ejemplo, del móvil): `http://127.0.0.1:5196/importar`, o **Ajustes → Importar copia** en la web conectada. Se aceptan las versiones 1, 2 y 3 y se combinan con la misma regla; una copia sin fotos nunca borra las del ordenador.
- **Actualizar Faustus ahora** fuerza la sincronización y dice cuántos objetos tiene el ordenador. `data/faustus-inventory.json` (sin fotos) se sigue escribiendo por compatibilidad, pero Faustus ya lee la casa en vivo.

## Consultar y cambiar la casa con Faustus

`bridge/mcp_server.py` es el puente MCP por stdio (el puente de catálogo común de la familia): reenvía cada llamada al servidor con el token de `data/mcp-token`, arranca el servidor (`python -m homehoard_server`) si no responde (`HOMEHOARD_BRIDGE_AUTOSTART=0` lo evita), renueva la lista de herramientas cuando caduca, reenvía el detalle de los errores y responde `outcome_unknown` si una escritura pierde la conexión, para que el asistente mire el estado antes de repetirla. El servidor también responde al contrato de la familia (`GET /api/agent/tools`, `POST /api/agent/call` con `Authorization: Bearer <token>`), emite eventos al bus del Hub y registra cada llamada.

Herramientas (16):

- `home_find_item` — «¿dónde está la linterna?»: busca por nombre, etiqueta, nota o ubicación, con erratas, y devuelve la ruta completa. Si no está, lo dice.
- `home_list_location` — «¿qué hay en la caja roja?»: todo lo de una habitación, mueble o caja, anidado incluido, paginado; si el nombre es ambiguo pide la ruta o el id.
- `home_inventory_status` — si el ordenador tiene la casa, cuántos objetos, último cambio y tareas vencidas.
- `item_add_from_purchase` — registra algo que se ha comprado (nombre, precio, tienda, fecha, papel de garantía, origen) y lo coloca; sin sitio va a la habitación «Por colocar».
- `home_add_item`, `home_update_item`, `home_move_item` — «guarda la linterna en el cajón rojo»: alta, cambios (nombre, cantidad, nota, sitio, etiquetas, favorito) y mover. Devuelven el estado nuevo.
- `home_item_details` — leer o rellenar la ficha (`set`).
- `home_item_papers` — «¿está en garantía la lavadora?»: papeles vinculados en Kafka y la garantía con su base y cita.
- `home_manual_search` — «¿qué significa el error E21?»: busca en los manuales vinculados, con página.
- `maintenance_list` — «¿cuándo toca revisar la caldera?»: vencidas, este mes, próximas, por objeto o habitación.
- `maintenance_add`, `maintenance_done`, `maintenance_update`, `maintenance_delete` (`confirm=true`), `maintenance_templates`.

Eventos: `homehoard.item.created {item_id, source_ref}` (cada objeto nuevo; `home_add_item` sigue emitiendo `homehoard.item.added`), `homehoard.maintenance.done`, `homehoard.maintenance.due {task_id, title, due, url, item_id}` una vez por tarea cuando vence (su día, o hasta 2 días después si la app estaba apagada; si la fecha cambia se avisa de nuevo) y, una vez al día, `homehoard.maintenance.upcoming {count, tasks}` con las tareas de los próximos 7 días.

**Compras**: `item_add_from_purchase {name, source_ref?, price?, merchant?, date?, room?, place?, warranty_ref?}` devuelve `{ok, status, item_id, url}`. Tienda, precio, fecha de compra, `source_ref` (`hoard://app/tipo/id`) y `warranty_ref` van a la ficha del aparato (un papel de garantía `hoard://kafka/document/<id>` queda además vinculado como papel de Kafka). `room` y `place` admiten nombres o una ruta como «Cocina › Cajón rojo»; sin sitio, o si no coincide, el objeto va a la habitación **Por colocar**, que se crea al usarla (un `warning` dice por qué). La llamada es idempotente por `source_ref` y nombre, avisa al grafo del hub (`from_purchase`) y no pierde nunca una compra. Los objetos dados de alta en el formulario web con `source_ref` se anuncian igual, una sola vez.

**Formulario precargado**: la dirección `#/add?name=…&source_ref=…&price=…&merchant=…&date=…&room=…&place=…` (también `warranty_ref`) abre **Añadir objeto** con el nombre puesto, la habitación y el mueble elegidos si sus nombres coinciden, el aviso «Desde una compra» y la ficha guardada con el objeto. Los valores no válidos se ignoran.

**Agenda**: `GET /api/family/agenda?from&to&sphere` (token) lista las tareas de mantenimiento que vencen en el rango como elementos `kind: maintenance` de día completo; las vencidas se listan siempre (prioridad alta, igual que las legales); las pausadas y borradas no. Cada elemento lleva `dedupe_key: homehoard:<id de la tarea>`, la misma clave con la que el espejo de Kafka guarda ese plazo, para que un hub pueda mostrar la tarea una sola vez.

## Arranque

Requisitos: Node 18+ para la app; Python 3.11+ para el servidor (solo biblioteca estándar, incluida la biblioteca de la familia copiada; `pip install -r bridge/requirements.txt` añade `mcp` para el puente de Faustus y, opcionalmente, `httpx`).

```bash
cd HomeHoard
npm install

# El ordenador: exporta la web y arranca el servidor (http://127.0.0.1:5196)
npm run build:web
python bridge/server.py

# Web en modo desarrollo (se conecta al servidor si está abierto)
npm run web

# Móvil: abre en Expo Go (escanea el QR) o build nativo
npm start
npm run android
npm run ios
```

Variables: `HOMEHOARD_DATA_DIR` (carpeta de datos, por defecto `data/`), `HOMEHOARD_PORT` (5196), `HOMEHOARD_WEB_DIR` (por defecto `bridge/web`), `HOARD_HUB_URL` (Hub de la familia), y para el puente MCP `HOMEHOARD_URL`, `HOMEHOARD_TOKEN_FILE` y `HOMEHOARD_BRIDGE_AUTOSTART`. Ajuste del servidor (en `data/settings.json`, se cambia en la pestaña Mantenimiento): `kafka_mirror`.

El lector QR usa `expo-camera`; tras instalar las dependencias hay que crear una nueva build nativa para incluir el permiso de cámara. La impresión usa el diálogo del sistema en móvil y la impresión del navegador en web.

## Cómo está montado

Reusa el stack Hoard (Expo + React Native + expo-router + TypeScript), sin la mitad online:

- **Datos:** una única interfaz `DataSource` (en `src/db/`) con dos implementaciones que Metro elige por plataforma:
  - **Nativo (iOS/Android):** `SqliteSource` sobre **expo-sqlite** en el dispositivo → `src/db/index.ts`.
  - **Web:** `MemorySource` en memoria, persistida en `localStorage` y sincronizada con el ordenador (`src/db/serverSync.ts`) → `src/db/index.web.ts`.
  - Reglas comunes: `src/db/records.ts` (tablas, combinación y copias 1/2/3), `src/db/mutations.ts` (ficha y mantenimiento) y `src/features/maintenanceCore.ts` (próxima fecha, grupos, sugerencias), las mismas que el servidor; `tests/maintenance-cases.json` las comprueba en los dos lados.
- **Servidor:** `bridge/server.py` y `bridge/homehoard_server/` (Python estándar): `store.py` (casa y fotos), `bundle.py` (copias), `tools.py` (herramientas), `kafka.py` (papeles y avisos por Kafka a través del Hub), `maintenance.py`, `app.py` (HTTP y guardia local), `agenda.py` (agenda de la familia). `bridge/homehoard_server/hoard_link/` es la biblioteca de la familia, copiada tal cual. Plantillas en `shared/maintenance-templates.json`.
  - Así expo-sqlite nunca entra en el bundle web (donde da problemas), como en WatchHoard.
- **Plano 2D:** `src/plan/FloorPlanView.tsx` con **react-native-svg** (idéntico en móvil y web), con modo edición (drag + resize con PanResponder, snap a rejilla).
- **Búsqueda:** `src/db/searchUtil.ts` — normalización sin acentos y ranking por relevancia, compartido por ambas fuentes de datos.
- **Pantallas:** `app/` (expo-router). Pestañas: Inicio · Plano · Buscar · Mantenimiento · Ajustes; más `room/`, `container/`, `item/` (con Ficha, Papeles, Manual y Mantenimiento), y el modal `add`.
- **UI compartida:** `src/ui/` (incl. `ToastProvider` con deshacer). Formularios, sheets de creación, acciones rápidas y backup: `src/features/`.

### Estructura

```
HomeHoard/
  app/                     # rutas (expo-router)
    (tabs)/                # Inicio, Plano, Buscar, Mantenimiento, Ajustes
    room/[id].tsx          # habitación
    container/[id].tsx     # mueble (y sub-contenedores)
    item/[id].tsx          # objeto (editar/eliminar)
    add.tsx                # alta rápida (modal)
  src/
    db/                    # DataSource: types, schema, sqlite, memory, seed, provider
    plan/                  # plano 2D (SVG)
    features/              # ItemForm, LocationPicker, fotos
    ui/                    # componentes, tema, iconos, PromptProvider
  bridge/                  # servidor (server.py, mcp_server.py, homehoard_server/) y sus pruebas
  shared/                  # plantillas de mantenimiento (app y servidor)
  tests/                   # pruebas de Node
```

### Pruebas

```bash
npm test                 # Node: sincronización web, migraciones, copias, mantenimiento
npm run typecheck
python -m unittest discover -s bridge -p "test_*.py"   # servidor: combinación, fotos, copias, herramientas, Kafka, HTTP
```

## Notas y límites

- **Web** guarda su copia en `localStorage`; la casa de verdad está en el ordenador. La cámara solo está en móvil; en web se usa la galería.
- **Móvil**: sigue siendo solo local (SQLite) y pasa sus datos al ordenador con la copia JSON (versión 3 con fichas y mantenimiento). Papeles, manual y avisos por Kafka necesitan el ordenador; en el móvil la ficha lo dice. El servidor solo escucha en `127.0.0.1`, así que el móvil no se sincroniza solo.
- **Kafka**: los papeles, la garantía de Kafka, el manual y los avisos necesitan el Hoard Hub y Kafka's Hoard 0.2 o posterior; si falta alguno, HomeHoard lo dice y el resto funciona. Si alguien cambia o cierra el plazo en Kafka, ese cambio se queda en Kafka (el título, los avisos o la fecha que edites allí ganan hasta la siguiente ocurrencia), pero no vuelve a HomeHoard.
- En un empate exacto de `updated_at` entre dos dispositivos con contenido distinto, cada lado conserva el suyo (salvo lápidas); es improbable con marcas en milisegundos.
- La búsqueda se ejecuta en memoria sobre los datos ya decorados (`src/db/searchUtil.ts`): normaliza acentos, puntúa por relevancia (nombre > etiqueta > nota > ubicación) y es instantánea para inventarios personales. FTS5 queda como optimización si algún día hay decenas de miles de objetos.
- La **copia de seguridad JSON** (versión 3; antes 2) incluye las fotos en base64. Si una foto local falta, la exportación falla en vez de producir una copia incompleta. Las copias versión 1 se pueden importar, pero sus URI originales podrían no existir en otro dispositivo.

## Licencia

AGPL-3.0-or-later (como el resto de la familia Hoard).
