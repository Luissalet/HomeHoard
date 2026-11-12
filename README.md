# HomeHoard

[Español](README.es.md)

A fully local home inventory: record where things live and find them by name, room, furniture or by asking Faustus "Where did I put the Philips flashlight?".

## What it is

HomeHoard keeps a hierarchy of Home > Floor > Room > Furniture > Item, with photos, tags, quantities, appliance data sheets, warranties and maintenance tasks. No account or cloud service is needed.

The computer holds the home. The HomeHoard server (`python bridge/server.py`, loopback only on `127.0.0.1:5196`) keeps the whole inventory and its photos, serves the web app and answers Faustus. The web app syncs with it and keeps an offline copy in the browser. The mobile app uses SQLite on the device and moves its data to the computer through a local JSON export. A detailed design (data model, 2D plan, UI) is in [`HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md`](HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md) (Spanish).

## What it does

**Inventory**
- Quick item entry with a photo, location chosen from context, tags, quantity and favourite flag; duplicate warnings and "save and add another".
- Accent-insensitive, multiword relevance search across names, notes, tags and locations; an empty search shows favourites and recent items.
- Quick quantity, move, favourite and delete actions; deletion is undoable (tombstones).
- Room and furniture views that include nested contents, inventory statistics and manageable tags.
- Printable QR labels for items and furniture, with an offline scanner that opens the matching record.
- Portable JSON backup with embedded photos; older backup versions remain importable.
- An empty first launch; a sample home loads only when you select it.

**Plan and 3D**
- Editable SVG floor plan with rooms and furniture: zoom, drag, corner resizing, grid snapping.
- 3D view of the home built from the saved plan (rooms, furniture, doors, windows). `home_3d_locate` focuses an inventory item and `home_3d_export` saves GLB or OBJ.

**Appliances, warranties and papers**
- Appliance card per object: brand, model, serial number, purchase date and shop, price, warranty end, manual link, consumables and spare parts, notes.
- Warranty overview (`/warranties`, `home_warranties`): filter expiring, active, expired or missing date, by horizon, reference date and room; shows days left, recorded source and full location. It reads the stored cards and never infers a legal term.
- Papers in Kafka's Hoard: link invoices, receipts, warranties and manuals to an object, see the warranty status with its basis and citation, upload papers, and search inside linked manuals with page citations.

**Maintenance**
- Tasks on an object, furniture, room or the home, every N days or months, optionally in a given month. A Mantenimiento tab (overdue, this month, upcoming, by place), mark done with date, note, cost and who, history, pause and fixed dates.
- Templates state their basis: legal duties name the norm (gas boiler servicing under the RITE regulation, gas installation review, air-conditioning inspection), everything else is presented as advice.
- Reminders through Kafka: with "Avisar mediante Kafka" on (default) each active task is kept as one Kafka deadline, moved when marked done and closed when deleted or paused; if Kafka or the hub is away the change is queued and retried.

**Packing lists and kits**
- Compare requested quantities with recorded stock (`home_check_list`): repeated ids are combined and shortages are shown with full locations. The check reads one snapshot and changes nothing.
- Saved reusable kits (`home_kits`), searchable by name and notes, which can be combined; the **Prepare a kit** page (`/kits`) edits them and checks stock. Temporary collection checkmarks never move stock. See [`docs/PACKING_LISTS.md`](docs/PACKING_LISTS.md) and [`docs/kits-search.md`](docs/kits-search.md).

**Purchases**
- `item_add_from_purchase` files something that was bought (shop, price, date, source reference, warranty paper) idempotently; without a matching place the object goes to a "Por colocar" room. The prefilled form `#/add?name=...` opens the add form with those values.

**Appearance**
- Dark theme by default with the family's palette; a light palette is available in Ajustes > Apariencia. The header shows whether the home is synced with the computer, offline or on the device.

## Run it

Requires Node.js 18 or newer for the app and Python 3.11+ for the server (standard library only; `pip install -r bridge/requirements.txt` adds `mcp` for the Faustus bridge).

```sh
npm install
npm run build:web
python bridge/server.py   # http://127.0.0.1:5196
npm run web     # browser, development; connects to the server when it runs
npm start       # Expo Go or native build
npm run android
npm run ios
```

| Variable | Purpose |
| --- | --- |
| `HOMEHOARD_DATA_DIR` | Data folder (default `data/`). |
| `HOMEHOARD_PORT` | Server port (default `5196`). |
| `HOMEHOARD_WEB_DIR` | Exported web app (default `bridge/web`). |
| `HOARD_HUB_URL` | Where the family hub is. |
| `HOMEHOARD_URL`, `HOMEHOARD_TOKEN_FILE`, `HOMEHOARD_BRIDGE_AUTOSTART` | MCP bridge: server URL, token file, and whether the bridge starts the server. |

The QR scanner uses `expo-camera`; adding its permission needs a new native build.

**How the computer holds the home**
- State lives in `data/home.json` (every record with `updated_at` and a `deleted_at` tombstone, atomic writes); photos are files in `data/photos/`. The access token (`data/mcp-token`) is created once and kept across restarts.
- `npm run build:web` exports the web app into `bridge/web/`, served at `/` with deep links.
- The web app loads the home from the server, keeps `localStorage` as an offline copy, pushes changes (debounced, retried) and polls for changes made by Faustus. Offline it says so and edits wait in the browser.
- Merge rule: per record the newest `updated_at` wins and a tombstone wins a tie. Photos become server files; the sample home is never sent.
- Backups from the phone are imported at `http://127.0.0.1:5196/importar` or in Settings > Import (versions 1 to 4, merged with the same rule; a backup without photos never deletes one).

## Connect to Faustus and the Hoard family

- **MCP bridge**: `bridge/mcp_server.py` is a stdio bridge that proxies every call to the server with the token in `data/mcp-token`, starts the server when needed, refreshes its tool list, and answers `outcome_unknown` when a write loses its connection so the assistant reads the state before repeating it. The server answers the family contract (`GET /api/agent/tools`, `POST /api/agent/call`). The API reference is in [`docs/API.md`](docs/API.md).
- **Tool groups**:

| Area | Tools |
| --- | --- |
| Find and read | `home_find_item`, `home_list_location`, `home_item_details`, `home_inventory_status` |
| Change | `home_add_item`, `item_add_from_purchase`, `home_update_item`, `home_move_item` |
| Packing | `home_check_list`, `home_kits` |
| Warranties and papers | `home_warranties`, `home_item_papers`, `home_manual_search` |
| Maintenance | `maintenance_list`, `maintenance_add`, `maintenance_done`, `maintenance_update`, `maintenance_delete` (`confirm=true`), `maintenance_templates` |
| Plan and 3D | `home_plan_openings`, `home_3d_scene`, `home_3d_locate`, `home_3d_export` |

- **Hub**: papers, manuals and reminders reach Kafka's Hoard through the hub and say plainly when the hub or Kafka is not available. Events: `homehoard.item.created`, `homehoard.maintenance.done`, `homehoard.maintenance.due` and a daily `homehoard.maintenance.upcoming`. The family agenda (`GET /api/family/agenda`) lists maintenance tasks as all-day items, overdue ones with high priority, each with a dedupe key so a hub shows a task once.
- **Copilot**: every page the server serves has a floating Faustus button. The assistant sees the object, room or furniture you have open (location, data sheet, maintenance tasks), the current page and any text typed and not saved. When a turn ends the page syncs at once and keeps what you typed. Conversation, model and tools live in Faustus; the phone app does not have the panel. The item form sends only the fields you edited, so an agent's concurrent changes are preserved.
- **Skills**: `household-inventory-and-maintenance` is offered to connecting agents.

## Architecture and checks

One `DataSource` interface has a mobile `expo-sqlite` implementation and a web implementation persisted to `localStorage` and synced with the server (`src/db/serverSync.ts`). Shared rules live in `src/db/` and `src/features/maintenanceCore.ts`; the server repeats them in `bridge/homehoard_server/`, and `tests/maintenance-cases.json` checks both sides. Maintenance templates live in `shared/maintenance-templates.json`. `bridge/homehoard_server/hoard_link/` is the vendored family library.

| Path | Contents |
| --- | --- |
| `app/`, `src/` | Expo / React Native app and web app |
| `bridge/` | Python server, MCP bridge and server tests |
| `shared/` | Maintenance templates |
| `docs/` | API, packing lists, kit search |
| `tests/` | Node tests |

```sh
npm test
npm run typecheck
python -m unittest discover -s bridge -p 'test_*.py'   # server
```

Limits: the phone stays local-only and moves data with JSON; papers, manuals and Kafka reminders need the computer, the hub and Kafka's Hoard; changes made to a mirrored deadline inside Kafka stay in Kafka; on an exact `updated_at` tie between two devices with different content each side keeps its own (tombstones excepted).

License: AGPL-3.0-or-later.
