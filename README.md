# HomeHoard

[Español](README.es.md)

A **fully local home inventory**. Record where things live and find them by name, room, furniture or a question to Faustus such as “Where did I put the Philips flashlight?” No account or cloud service is required. **The computer holds the home**: the HomeHoard server (`python bridge/server.py`, loopback only on `127.0.0.1:5196`) keeps the whole inventory and its photos, serves the web app and answers Faustus. The web app syncs with it and keeps a copy in the browser so it keeps working offline. The mobile app uses SQLite on the device and moves its data to the computer with a local JSON export.

> Detailed design: [`HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md`](HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md) (Spanish).

## Features available now

- Editable SVG floor plan with rooms and furniture, zoom, drag, corner resizing and grid snapping.
- Nested Home › Floor › Room › Furniture › Item hierarchy, including drawers inside other furniture.
- Quick item entry with a photo, context-selected location, tags, quantity and favorite flag; duplicate warnings and “save and add another”.
- Accent-insensitive, multiword relevance search across names, notes, tags and locations. An empty search shows favorites and recent items.
- Quick quantity, move, favorite and delete actions; undoable deletion backed by tombstones.
- Room and furniture views that include nested contents, inventory statistics and manageable tags.
- Portable JSON backup with embedded photos. Old version 1 backups remain importable; version 2 fails if a local photo cannot be included rather than silently losing it.
- Printable QR labels for items and furniture, with an offline scanner that opens the matching record or reports that it no longer exists.
- **Appliance card** per object: brand, model, serial number, purchase date and shop, price, warranty end (typed or taken from Kafka), manual link, consumables and spare parts (name, spec such as «CR2032 ×2», quantity, last bought) and notes. Collapsible; shows only filled fields when not editing.
- **Papers in Kafka's Hoard**: link Kafka documents (invoice, receipt, warranty, manual) to an object, see their title, kind, date and the warranty status with its basis and citation, search Kafka to link one, upload an invoice or manual to Kafka (manuals with kind `manual`), and search inside the linked manuals with page citations.
- **Maintenance**: tasks on an object, piece of furniture, room or the home, every N days or months, optionally in a given month. A **Mantenimiento** tab (overdue, this month, upcoming, or by place), mark done with date, note, cost and who, history, pause, a date fixed by hand, and a maintenance block on item and room pages with template suggestions.
- **Templates with their basis** (checked 2026-10-02). Legal duties state their norm: gas boiler in a dwelling (≤ 70 kW) at least every 2 years by an authorised company (RITE, RD 1027/2007, IT 3.3; many makers ask for a yearly service); gas installation every 5 years (RD 919/2006, ITC-ICG 07); air conditioning or heat pump up to 12 kW every 4 years, 12–70 kW every 2 years (RITE IT 3.3). Everything else is presented as advice.
- **Reminders through Kafka**: with **Avisar mediante Kafka** on (default), each active task is kept as one Kafka deadline (stable key, no duplicates, the norm or «Recomendación» in its explanation); marking it done moves the deadline, deleting or pausing closes it; while Kafka or the hub is unreachable the change is queued and retried, and the tab says why.
- An empty first launch. A sample home loads only when explicitly selected.

## The computer holds the home

- `python bridge/server.py` (or `npm run server`, or from Faustus / the hub) serves `http://127.0.0.1:5196`. State lives in `data/home.json` (every record with `updated_at` and a `deleted_at` tombstone, atomic writes, a growing `version`); photos are files in `data/photos/`.
- `npm run build:web` exports the web app into `bridge/web/`, served at `/` with deep links. Without the export, `/` explains how to build it.
- The web app (served by the server, or on `localhost`/`127.0.0.1` while the server answers) loads `/api/home`, keeps `localStorage` as an offline copy, pushes changes to `/api/home/sync` (debounced, retried) and polls `/api/home/version` every few seconds to pick up changes made by Faustus. Offline it shows «Sin conexión con el ordenador»; edits wait in the browser. A browser with older local data uploads it the first time it finds the computer.
- **Merge rule**: per record, the newest `updated_at` wins; a tombstone wins a tie. Item-tag links have id `<item>:<tag>` and tombstones too. Photos become server files. The example house is never sent.
- **Import backups** (from the phone): `http://127.0.0.1:5196/importar`, or Settings → Import in the connected web app. Versions 1, 2 and 3 are accepted and merged with the same rule; a backup without photos never deletes one.
- **Update Faustus now** forces a sync. `data/faustus-inventory.json` (photo-free) is still written for compatibility; Faustus now reads the live home.

## Faustus and the family

`bridge/mcp_server.py` is the stdio MCP bridge: it proxies every call to the server with the token in `data/mcp-token` and starts the server when needed (`HOMEHOARD_BRIDGE_AUTOSTART=0` disables that). The server answers the family contract (`GET /api/agent/tools`, `POST /api/agent/call` with `Authorization: Bearer <token>`), emits events on the hub's bus and records each call.

Tools (15): `home_find_item`, `home_list_location`, `home_inventory_status`, `home_add_item`, `home_update_item`, `home_move_item`, `home_item_details`, `home_item_papers`, `home_manual_search`, `maintenance_list`, `maintenance_add`, `maintenance_done`, `maintenance_update`, `maintenance_delete` (`confirm=true`), `maintenance_templates`. Writes return the new state. Papers, manuals and reminders reach Kafka's Hoard through the hub (`family.call`) and say plainly when the hub or Kafka is not available.

Events: `homehoard.item.added`, `homehoard.maintenance.done`, and once a day `homehoard.maintenance.due` with the tasks due within 7 days.

## Run

Requires Node.js 18 or newer for the app and Python 3.11+ for the server (standard library; `pip install -r bridge/requirements.txt` adds `httpx` for the family link and `mcp` for the Faustus bridge).

```sh
npm install
npm run build:web
python bridge/server.py   # http://127.0.0.1:5196
npm run web     # browser (development; connects to the server when it is running)
npm start       # Expo Go or native build
npm run android
npm run ios
```

Environment: `HOMEHOARD_DATA_DIR` (default `data/`), `HOMEHOARD_PORT` (5196), `HOMEHOARD_WEB_DIR` (default `bridge/web`), `HOARD_HUB_URL`; for the MCP bridge `HOMEHOARD_URL`, `HOMEHOARD_TOKEN_FILE`, `HOMEHOARD_BRIDGE_AUTOSTART`. Server setting (`data/settings.json`, changed in the Mantenimiento tab): `kafka_mirror`.

The QR scanner uses `expo-camera`; adding its camera permission requires a new native build. Mobile uses the system print dialog; web uses browser printing.

## Architecture and checks

One `DataSource` interface has a mobile `expo-sqlite` implementation and a web memory implementation persisted to `localStorage` and synced with the server (`src/db/serverSync.ts`). Shared rules live in `src/db/records.ts` (tables, merge, bundles 1/2/3), `src/db/mutations.ts` and `src/features/maintenanceCore.ts`; the server repeats them in `bridge/homehoard_server/` and `tests/maintenance-cases.json` checks both sides. Templates live in `shared/maintenance-templates.json`. `bridge/homehoard_server/hoard_link/` is the vendored family library.

Limits: the phone stays local-only and moves data with JSON; papers, manuals and Kafka reminders need the computer, the hub and Kafka's Hoard 0.2+; changes made to a mirrored deadline inside Kafka stay in Kafka; on an exact `updated_at` tie between two devices with different content each side keeps its own (tombstones excepted).

```sh
npm test
npm run typecheck
python -m unittest discover -s bridge -p 'test_*.py'   # server: merge, photos, backups, tools, Kafka, HTTP
```

License: AGPL-3.0-or-later.
