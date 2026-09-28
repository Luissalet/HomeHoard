# HomeHoard

[Español](README.es.md)

A **fully local home inventory**. Record where things live and find them by name, room, furniture or a question to Faustus such as “Where did I put the Philips flashlight?” No account or cloud service is required. The web app stores data in this browser; the mobile app uses SQLite on the device. Move data between them with an explicit local JSON export and import.

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
- An empty first launch. A sample home loads only when explicitly selected.

## Ask Faustus about your home

1. In HomeHoard on this computer, choose **Settings → Update Faustus now**. This writes a photo-free query snapshot to `data/faustus-inventory.json`.
2. Ask Faustus where an item is. `home_find_item` returns its full location path and the snapshot date; an absent item is reported as absent.

After the first successful update, this browser sends later inventory changes to the local bridge automatically while it is open. If the bridge is closed, use **Update Faustus now** to see and resolve the connection error. For a mobile backup, export JSON from **Settings → Export backup**, then import it at `http://127.0.0.1:5196/` on the computer. Start that bridge with `python bridge/server.py` or from Faustus. Mobile transfers remain manual; the bridge listens only on `127.0.0.1`.

## Run

Requires Node.js 18 or newer.

```sh
npm install
npm run web     # browser
npm start       # Expo Go or native build
npm run android
npm run ios
```

The QR scanner uses `expo-camera`; adding its camera permission requires a new native build. Mobile uses the system print dialog; web uses browser printing.

## Architecture and checks

One `DataSource` interface has a mobile `expo-sqlite` implementation and a web memory implementation persisted to `localStorage`. Metro selects the platform entry point, keeping SQLite out of the web bundle. `react-native-svg` renders the floor plan on both platforms. Search and backup logic live under `src/db/` and `src/features/`.

```sh
npm test
npm run typecheck
python -m unittest discover -s bridge -p 'test_*.py'
```

License: AGPL-3.0-or-later.
