# HomeHoard server HTTP API

`bridge/server.py` listens on `127.0.0.1:5196` (`HOMEHOARD_PORT`). Every request passes the family guard: loopback
`Host`, local `Origin`, no cross-site fetches, no form posts. The agent routes need `Authorization: Bearer <token>`
(`data/mcp-token`); the web app's own routes need none.

## The home

| Route | What it does |
|---|---|
| `GET /api/health`, `/api/status` | service, version, inventory status, store version / instance, whether the web export exists, Hoard Link block, `copilot` (true when the Faustus relay is on) |
| `GET /api/home` | the computer's copy of the home: `{instance, version, tables}` (households, homes, floors, rooms, containers, items, tags, itemTags, item_details, maintenance_tasks, maintenance_log, packing_kits) |
| `GET /api/home/version` | `{version, instance}`, cheap to poll |
| `POST /api/home/sync` | `{base_version, records, photos}`: merge the web app's changes (the most recent change of each record wins) and return the new state |
| `POST /api/home/item-patch` | `{id, patch}`: atomically change only submitted item fields on the current computer row; returns `{ok, state}`. Fields: `name`, `description`, `quantity`, `room_id`, `container_id`, `photo_uri`, `favorite`, `tagIds`; null and empty tag lists retain their clearing meaning. Photos use the existing data-image or stored-photo representation. |
| `POST /api/import` | import a JSON backup |
| `GET /photos/<id>` | an object's photo |
| `GET /importar` | the import page |
| `GET /api/settings`, `POST /api/settings` | `kafka_mirror` |
| `GET /api/kafka/status`, `POST /api/kafka/search`, `/api/kafka/upload`, `/api/kafka/mirror/run` | papers and reminders through the hub |
| `GET /api/maintenance/templates` | maintenance templates |
| `POST /api/ui/call` | `{tool, arguments}`: the web app runs a tool without the token |

## Agent

| Route | What it does |
|---|---|
| `GET /api/agent/tools` | the tool catalogue and instructions |
| `POST /api/agent/call` | `{name, arguments, caller?}`: run one tool (bearer token) |
| `GET /api/family/agenda?from&to&sphere` | maintenance tasks as agenda items (bearer token) |

## Faustus copilot (`/api/copilot/*`)

The vendored Hoard Link `CopilotRelay` (standard library), wired in by `bridge/homehoard_server/copilot.py`; absent with `HOARD_COPILOT=0`. Behind the same family
guard as everything above, no token (like the web app).

| Route | What it does |
|---|---|
| `GET /api/copilot/info` | `{app_id: "homehoard", app_name, data_space_id, panel_url, server, tool_server_id, settings_url}`; the data space id is stable (`data/copilot-space-id`); 503 when Faustus cannot be reached |
| `GET /api/copilot/panel.js` | the `<faustus-chat>` element, served by Faustus through the relay |
| `POST /api/copilot/proxy` | `{path, method, headers?, body? \| raw_body?, content_type?}` to Faustus; chat turns stream as Server-Sent Events (chunked); the Faustus token stays on the server, `origin.app_id` / `data_space_id` are forced; only `/api/hoard-copilot/`, `/api/chat/`, `/api/session(s)` and `/api/chat_stream` paths are allowed (no `..`, no encoded dots, no `//`), anything else answers 400 |
| `GET /api/copilot/launcher.js` | the floating button and side panel script |
| `GET /copilot.js` | the page script (`window.hoardCopilot`) |

Every HTML page the server serves (the web export, its single-page fallback, `/importar`) gets the page script and the
launcher added before `</body>`.

The page side is `window.hoardCopilot` (`bridge/homehoard_server/static/copilot.js`): `context(base)` returns `project`
(the home), `active_objects` (the open object, room or furniture, read from `GET /api/home`) and `view` (`page`,
`summary`, `view.editor`); `onTurnEnd(detail)` makes the app sync with the computer at once.

An unknown URL id with no computer or browser row has no active object. A verified row in the browser's persisted offline store may be sent with `unsynced: true`. The item form compares against its saved baseline, preserves dirty fields as native updates arrive, and sends only edited fields through the atomic patch route while online. A later edit during Save remains on screen for the next Save. Existing offline/local record synchronization stays available; the 19 native MCP tools retain their catalogue.
