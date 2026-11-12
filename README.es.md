# HomeHoard

[English](README.md)

Inventario doméstico totalmente local: anota dónde está cada cosa y encuéntrala por nombre, habitación, mueble o preguntándole a Faustus «¿Dónde dejé la linterna Philips?».

## Qué es

HomeHoard guarda una jerarquía Casa > Planta > Habitación > Mueble > Objeto, con fotos, etiquetas, cantidades, fichas de electrodomésticos, garantías y tareas de mantenimiento. No necesita cuenta ni servicio en la nube.

El ordenador guarda la casa. El servidor de HomeHoard (`python bridge/server.py`, solo en loopback, `127.0.0.1:5196`) conserva todo el inventario y sus fotos, sirve la aplicación web y responde a Faustus. La aplicación web se sincroniza con él y mantiene una copia sin conexión en el navegador. La app móvil usa SQLite en el dispositivo y pasa sus datos al ordenador mediante una exportación JSON local. El diseño detallado (modelo de datos, plano 2D, interfaz) está en [`HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md`](HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md).

## Qué hace

**Inventario**
- Alta rápida de objetos con foto, ubicación elegida según el contexto, etiquetas, cantidad y marca de favorito; avisos de duplicados y «guardar y añadir otro».
- Búsqueda por relevancia, sin acentos y de varias palabras, en nombres, notas, etiquetas y ubicaciones; con la búsqueda vacía se muestran favoritos y recientes.
- Acciones rápidas de cantidad, mover, favorito y borrar; el borrado se puede deshacer (marcas de borrado).
- Vistas de habitación y mueble que incluyen el contenido anidado, estadísticas del inventario y etiquetas gestionables.
- Etiquetas QR imprimibles para objetos y muebles, con un lector sin conexión que abre el registro correspondiente.
- Copia de seguridad JSON portátil con las fotos incrustadas; las versiones antiguas siguen siendo importables.
- Primer arranque vacío; la casa de ejemplo solo se carga si la eliges.

**Plano y 3D**
- Plano SVG editable con habitaciones y muebles: zoom, arrastre, redimensionado por esquinas y ajuste a cuadrícula.
- Vista 3D de la casa construida a partir del plano guardado (habitaciones, muebles, puertas, ventanas). `home_3d_locate` enfoca un objeto del inventario y `home_3d_export` guarda GLB u OBJ.

**Electrodomésticos, garantías y papeles**
- Ficha de electrodoméstico por objeto: marca, modelo, número de serie, fecha y tienda de compra, precio, fin de garantía, enlace al manual, consumibles y recambios, notas.
- Resumen de garantías (`/warranties`, `home_warranties`): filtra por vencen pronto, vigentes, vencidas o sin fecha, por horizonte, fecha de referencia y habitación; muestra los días restantes, el origen registrado y la ubicación completa. Lee las fichas guardadas y nunca deduce un plazo legal.
- Papeles en Kafka's Hoard: enlaza facturas, recibos, garantías y manuales a un objeto, consulta el estado de la garantía con su base y cita, sube papeles y busca dentro de los manuales enlazados con citas de página.

**Mantenimiento**
- Tareas sobre un objeto, mueble, habitación o la casa, cada N días o meses, opcionalmente en un mes concreto. Pestaña Mantenimiento (vencidas, este mes, próximas, por lugar), marcar como hecha con fecha, nota, coste y quién, historial, pausa y fechas fijadas a mano.
- Las plantillas indican su base: las obligaciones legales citan la norma (revisión de la caldera de gas según el RITE, revisión de la instalación de gas, inspección del aire acondicionado) y el resto se presenta como recomendación.
- Avisos mediante Kafka: con «Avisar mediante Kafka» activado (por defecto) cada tarea activa se guarda como un plazo de Kafka, se mueve al marcarla como hecha y se cierra al borrarla o pausarla; si Kafka o el hub no están disponibles, el cambio queda en cola y se reintenta.

**Listas de equipaje y kits**
- Compara las cantidades pedidas con las existencias registradas (`home_check_list`): los ids repetidos se suman y las faltas se muestran con sus ubicaciones completas. La comprobación lee una instantánea y no cambia nada.
- Kits reutilizables guardados (`home_kits`), con búsqueda por nombre y notas, que se pueden combinar; la página **Preparar un kit** (`/kits`) los edita y comprueba las existencias. Las marcas temporales de recogida nunca mueven existencias. Véanse [`docs/PACKING_LISTS.md`](docs/PACKING_LISTS.md) y [`docs/kits-search.md`](docs/kits-search.md).

**Compras**
- `item_add_from_purchase` archiva de forma idempotente algo que se compró (tienda, precio, fecha, referencia de origen, papel de garantía); si no hay un lugar que coincida, el objeto va a una habitación «Por colocar». El formulario prerrellenado `#/add?name=...` abre el alta con esos valores.

**Apariencia**
- Tema oscuro por defecto con la paleta de la familia; hay una paleta clara en Ajustes > Apariencia. La cabecera indica si la casa está sincronizada con el ordenador, sin conexión o en el dispositivo.

## Cómo se ejecuta

Requiere Node.js 18 o posterior para la app y Python 3.11+ para el servidor (solo biblioteca estándar; `pip install -r bridge/requirements.txt` añade `mcp` para el puente de Faustus).

```sh
npm install
npm run build:web
python bridge/server.py   # http://127.0.0.1:5196
npm run web     # navegador, desarrollo; se conecta al servidor si está en marcha
npm start       # Expo Go o compilación nativa
npm run android
npm run ios
```

| Variable | Para qué sirve |
| --- | --- |
| `HOMEHOARD_DATA_DIR` | Carpeta de datos (por defecto `data/`). |
| `HOMEHOARD_PORT` | Puerto del servidor (por defecto `5196`). |
| `HOMEHOARD_WEB_DIR` | Aplicación web exportada (por defecto `bridge/web`). |
| `HOARD_HUB_URL` | Dónde está el hub de la familia. |
| `HOMEHOARD_URL`, `HOMEHOARD_TOKEN_FILE`, `HOMEHOARD_BRIDGE_AUTOSTART` | Puente MCP: URL del servidor, archivo del token y si el puente arranca el servidor. |

El lector de QR usa `expo-camera`; añadir su permiso exige una nueva compilación nativa.

**Cómo guarda el ordenador la casa**
- El estado vive en `data/home.json` (cada registro con `updated_at` y una marca `deleted_at` de borrado, escrituras atómicas); las fotos son archivos en `data/photos/`. El token de acceso (`data/mcp-token`) se crea una vez y se conserva entre arranques.
- `npm run build:web` exporta la aplicación web a `bridge/web/`, servida en `/` con enlaces profundos.
- La aplicación web carga la casa desde el servidor, conserva `localStorage` como copia sin conexión, envía los cambios (con retardo y reintentos) y consulta periódicamente los cambios hechos por Faustus. Sin conexión lo indica y las ediciones esperan en el navegador.
- Regla de fusión: por registro gana el `updated_at` más reciente y, en empate, gana la marca de borrado. Las fotos pasan a ser archivos del servidor; la casa de ejemplo nunca se envía.
- Las copias del móvil se importan en `http://127.0.0.1:5196/importar` o en Ajustes > Importar (versiones 1 a 4, fusionadas con la misma regla; una copia sin fotos nunca borra una).

## Conexión con Faustus y la familia Hoard

- **Puente MCP**: `bridge/mcp_server.py` es un puente por stdio que reenvía cada llamada al servidor con el token de `data/mcp-token`, arranca el servidor cuando hace falta, refresca su lista de herramientas y responde `outcome_unknown` si una escritura pierde la conexión, para que el asistente lea el estado antes de repetirla. El servidor atiende el contrato de la familia (`GET /api/agent/tools`, `POST /api/agent/call`). La referencia de la API está en [`docs/API.md`](docs/API.md).
- **Grupos de herramientas**:

| Área | Herramientas |
| --- | --- |
| Buscar y leer | `home_find_item`, `home_list_location`, `home_item_details`, `home_inventory_status` |
| Cambiar | `home_add_item`, `item_add_from_purchase`, `home_update_item`, `home_move_item` |
| Equipaje | `home_check_list`, `home_kits` |
| Garantías y papeles | `home_warranties`, `home_item_papers`, `home_manual_search` |
| Mantenimiento | `maintenance_list`, `maintenance_add`, `maintenance_done`, `maintenance_update`, `maintenance_delete` (`confirm=true`), `maintenance_templates` |
| Plano y 3D | `home_plan_openings`, `home_3d_scene`, `home_3d_locate`, `home_3d_export` |

- **Hub**: los papeles, manuales y avisos llegan a Kafka's Hoard por el hub y dicen con claridad cuando el hub o Kafka no están disponibles. Eventos: `homehoard.item.created`, `homehoard.maintenance.done`, `homehoard.maintenance.due` y un `homehoard.maintenance.upcoming` diario. La agenda familiar (`GET /api/family/agenda`) lista las tareas de mantenimiento como elementos de día completo, las vencidas con prioridad alta, cada una con una clave de deduplicación para que un hub muestre la tarea una sola vez.
- **Copiloto**: cada página que sirve el servidor tiene un botón flotante de Faustus. El asistente ve el objeto, habitación o mueble que tienes abierto (ubicación, ficha, tareas de mantenimiento), la página actual y el texto escrito sin guardar. Al terminar un turno la página se sincroniza de inmediato y conserva lo que habías escrito. La conversación, el modelo y las herramientas viven en Faustus; la app del móvil no tiene el panel. El formulario del objeto envía solo los campos que editaste, así que se respetan los cambios simultáneos de un agente.
- **Skills**: `household-inventory-and-maintenance` se ofrece a los agentes que se conectan.

## Arquitectura y comprobaciones

Una única interfaz `DataSource` tiene una implementación móvil con `expo-sqlite` y otra web persistida en `localStorage` y sincronizada con el servidor (`src/db/serverSync.ts`). Las reglas compartidas viven en `src/db/` y `src/features/maintenanceCore.ts`; el servidor las repite en `bridge/homehoard_server/`, y `tests/maintenance-cases.json` comprueba ambos lados. Las plantillas de mantenimiento están en `shared/maintenance-templates.json`. `bridge/homehoard_server/hoard_link/` es la biblioteca de la familia incluida tal cual.

| Ruta | Contenido |
| --- | --- |
| `app/`, `src/` | App Expo / React Native y aplicación web |
| `bridge/` | Servidor Python, puente MCP y pruebas del servidor |
| `shared/` | Plantillas de mantenimiento |
| `docs/` | API, listas de equipaje, búsqueda de kits |
| `tests/` | Pruebas de Node |

```sh
npm test
npm run typecheck
python -m unittest discover -s bridge -p 'test_*.py'   # servidor
```

Límites: el móvil sigue siendo solo local y pasa los datos con JSON; los papeles, manuales y avisos de Kafka necesitan el ordenador, el hub y Kafka's Hoard; los cambios hechos en Kafka sobre un plazo reflejado se quedan en Kafka; ante un empate exacto de `updated_at` entre dos dispositivos con contenido distinto, cada lado conserva el suyo (salvo las marcas de borrado).

Licencia: AGPL-3.0-or-later.
