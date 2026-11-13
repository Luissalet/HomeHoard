"""The HomeHoard server: the home, the web app, the agent tools and the family link on 127.0.0.1:5196."""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

import inventory

from . import APP_ID, SERVICE, VERSION
from . import config as C
from . import copilot as copilotmod
from . import tools as T
from . import agenda as AG
from . import house3d as H3
from .hoard_link import family, fam_refs
from .hoard_link.atomic import write_text_atomic
from .hoard_link.guard import _dock_origins, _url_origin
from .hoard_link.tokens import check_bearer, read_or_create_token, write_url
from .kafka import KafkaLink, KafkaMirror
from .pages import IMPORT_PAGE, NO_WEB_PAGE
from .store import HomeStore

LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
MAX_BODY = 20_000_000
MAX_SYNC_BODY = 80_000_000
UPLOAD_KINDS = ("invoice", "receipt", "warranty", "manual", "contract", "other", "")
DEFAULT_SETTINGS = {"kafka_mirror": True, **H3.DEFAULT_SETTINGS}
HOUSE3D_STATIC = Path(__file__).resolve().parent / "static" / "casa3d"
STATIC_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
                ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8"}


def host_of(value: Optional[str]) -> str:
    host = (value or "").strip().lower()
    if "://" in host:
        host = host.split("://", 1)[1]
    host = host.split("/", 1)[0]
    if host.startswith("["):
        end = host.find("]")
        return host if end == -1 else host[: end + 1]
    return host.split(":", 1)[0]


def docked(method: str, headers: Any) -> bool:
    """A framed GET navigation whose parent page is a known Faustus origin (the App Dock)."""
    lowered = {str(key).lower(): value for key, value in headers.items()}
    parent = _url_origin(lowered.get("referer", ""))
    return bool(parent) and parent in tuple(_dock_origins(method, lowered))


def check_request(method: str, headers: Any) -> Optional[str]:
    """The family guard: local Host, local Origin, no cross-site requests except navigations, no form posts."""
    if host_of(headers.get("Host")) not in LOCAL_HOSTS:
        return "Solo se admite acceso local."
    origin = headers.get("Origin")
    if origin and origin != "null" and host_of(origin) not in LOCAL_HOSTS:
        return "Origen no permitido"
    site, mode, dest = headers.get("Sec-Fetch-Site"), headers.get("Sec-Fetch-Mode"), headers.get("Sec-Fetch-Dest")
    if site == "cross-site" and (mode != "navigate" or dest in ("iframe", "frame", "embed", "object")) and not docked(method, headers):
        return "No se admiten peticiones de otros sitios."
    if mode == "navigate" and method.upper() not in SAFE_METHODS:
        return "No se admiten envíos de formularios."
    return None


def local_origin(origin: str) -> bool:
    try:
        parsed = urlparse(origin)
        return (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
                and parsed.port is not None and not parsed.username and not parsed.password
                and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


class App:
    """Everything one server process holds. Tests build one on a temporary folder with a fake clock and Kafka."""

    def __init__(self, data_dir: Optional[Path] = None, *, clock: Callable[[], float] = time.time, kafka_call: Optional[Callable[..., Any]] = None,
                 emit: Optional[Callable[..., Any]] = None, web_dir: Optional[Path] = None, port: Optional[int] = None, mirror: bool = True):
        self.paths = C.Paths(Path(data_dir) if data_dir else C.data_dir())
        self.paths.data.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.port = port or C.port()
        self.web = web_dir or C.web_dir()
        self.store = HomeStore(self.paths, clock)
        inventory.use_store(self.store)
        self.emit = emit or family.emit
        self.kafka = KafkaLink(kafka_call)
        self.mirror = KafkaMirror(self.store, self.kafka, paths=self.paths, settings=self.settings, app_url=f"http://127.0.0.1:{self.port}",
                                  clock=clock, emit=self.emit) if mirror else None
        self.ctx = T.Ctx(self.store, self.kafka, self.mirror, clock, self.emit, app_url=f"http://127.0.0.1:{self.port}")
        self.lock_announced = threading.Lock()
        self.ctx.announced = self._mark_announced
        self.ctx.settings = self.settings
        self.ctx.save_settings = self.set_settings
        self.ctx.exports_dir = self.paths.data / "exports"
        self._vulcan_probe: tuple[float, dict[str, Any]] = (0.0, {})
        self.token = read_or_create_token(self.paths.token)
        self.copilot = copilotmod.install(self.paths.data)   # the Faustus panel relay; None with HOARD_COPILOT=0
        self.store.listeners.append(self._changed)
        self._kafka_probe: tuple[float, dict[str, Any]] = (0.0, {})

    # ---------------------------------------------------------------- setup
    def _stored_settings(self) -> dict[str, Any]:
        try:
            values = json.loads(self.paths.settings.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            values = {}
        return {k: v for k, v in values.items() if k in DEFAULT_SETTINGS} if isinstance(values, dict) else {}

    def settings(self) -> dict[str, Any]:
        stored = self._stored_settings()
        return {**DEFAULT_SETTINGS, **stored, **H3.clean_settings(stored)}

    def set_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        stored = self._stored_settings()       # only what was chosen is written; the rest stays at its default
        for key, value in (values or {}).items():
            if key in ("kafka_mirror", "infer_doors"):
                if not isinstance(value, bool):
                    raise T.ToolError("invalid", f"{key} es true o false.")
            elif key == "wall_height_cm":
                low, high = H3.WALL_HEIGHT_RANGE
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                    raise T.ToolError("invalid", f"wall_height_cm va de {low} a {high} cm.")
                value = int(value)
            else:
                raise T.ToolError("invalid", f"Ajuste desconocido: {key}.")
            stored[key] = value
        write_text_atomic(self.paths.settings, json.dumps(stored, ensure_ascii=False))
        if self.mirror:
            self.mirror.wake()
        return self.settings()

    def vulcan_status(self, force: bool = False) -> dict[str, Any]:
        at, cached = self._vulcan_probe
        if force or not cached or self.clock() - at > 20:
            cached = T.vulcan_status(self.ctx)
            self._vulcan_probe = (self.clock(), cached)
        return cached

    def _announced(self) -> set[str]:
        try:
            return set(json.loads(self.paths.announced.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return set()

    def _mark_announced(self, item_id: str, ref: str) -> None:
        """The creation of this object was announced (by the tool or by the sync): never announce it twice."""
        with self.lock_announced:
            sent = self._announced()
            if f"{item_id}|{ref}" not in sent:
                sent.add(f"{item_id}|{ref}")
                write_text_atomic(self.paths.announced, json.dumps(sorted(sent)))

    def _announce_purchases(self, ids: list[str]) -> None:
        """An object the web form filed from a purchase (its card carries ``source_ref``) is announced once, like the tool does:
        ``homehoard.item.created`` and the link in the hub's graph."""
        sent = self._announced()
        for item_id in ids:
            card = self.store.get("item_details", item_id)
            item = self.store.get("items", item_id)
            ref = (card or {}).get("source_ref")
            if not card or card.get("deleted_at") is not None or not item or item.get("deleted_at") is not None or not ref:
                continue
            if f"{item_id}|{ref}" in sent:
                continue
            self._mark_announced(item_id, ref)
            self.emit("homehoard.item.created", {"item_id": item_id, "source_ref": ref})
            self.ctx.spawn(lambda i=item_id, r=ref, n=item.get("name") or "": (self.ctx.refs or fam_refs.link)(f"hoard://homehoard/item/{i}", r, "from_purchase", from_label=n))

    def _changed(self, event: dict[str, Any]) -> None:
        changed = event.get("changed") or {}
        if event.get("origin") == "app" and changed.get("item_details"):
            self._announce_purchases(changed["item_details"])
        if self.mirror and ("maintenance_tasks" in changed or "items" in changed or "rooms" in changed):
            self.mirror.wake()
        for log_id in changed.get("maintenance_log", []):
            log = self.store.get("maintenance_log", log_id)
            if not log or log.get("deleted_at") is not None or log.get("updated_at") != log.get("created_at", log.get("updated_at")):
                continue
            task = self.store.get("maintenance_tasks", log.get("task_id") or "") or {}
            self.emit("homehoard.maintenance.done", {"task_id": log.get("task_id"), "title": task.get("title"), "log_id": log_id,
                                                     "done_at": log.get("done_at")})

    def start_background(self) -> None:
        family.configure(APP_ID, str(self.paths.data))
        if self.mirror:
            self.mirror.start()

    # ---------------------------------------------------------------- views
    def health(self) -> dict[str, Any]:
        return {"service": SERVICE, "app": APP_ID, "version": VERSION, "ok": True, **inventory.status(), "store": self.store.info(),
                "web": (self.web / "index.html").is_file(), "hoard_link": family.health_block(), "copilot": self.copilot is not None}

    def kafka_status(self, force: bool = False) -> dict[str, Any]:
        at, cached = self._kafka_probe
        if force or not cached or self.clock() - at > 15:
            r = self.kafka.call("docs_list", {"limit": 1}, timeout=8)
            cached = {"reachable": r["ok"], **({} if r["ok"] else {"reason": r["reason"], "message": r["message"]})}
            self._kafka_probe = (self.clock(), cached)
        return {"kafka": cached, "mirror": self.mirror.status() if self.mirror else None, "settings": self.settings()}

    def kafka_search(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or "").strip()[:200]
        kind = str(args.get("kind") or "").strip()[:30]
        docs: dict[str, dict[str, Any]] = {}
        listed = self.kafka.call("docs_list", {k: v for k, v in (("text", query[:80]), ("kind", kind), ("limit", 30)) if v})
        if not listed["ok"]:
            return {"ok": False, "reason": listed["reason"], "message": listed["message"], "documents": []}
        for d in listed["result"].get("documents") or []:
            docs[d["id"]] = {k: d.get(k) for k in ("id", "title", "kind", "kind_label", "issuer", "issue_date", "item")}
        if len(query) >= 2:
            found = self.kafka.call("doc_search", {k: v for k, v in (("query", query), ("kind", kind), ("limit", 20)) if v})
            if found["ok"]:
                for h in found["result"].get("results") or []:
                    docs.setdefault(h["doc_id"], {"id": h["doc_id"], "title": h.get("title"), "kind": h.get("kind"), "issuer": h.get("issuer"),
                                                  "issue_date": h.get("issue_date"), "snippet": h.get("snippet"), "page": h.get("page")})
        return {"ok": True, "documents": list(docs.values())[:40]}

    def kafka_upload(self, args: dict[str, Any]) -> dict[str, Any]:
        item = T._resolve_item(self.ctx, str(args.get("item_id") or ""))
        kind = str(args.get("kind") or "")
        if kind not in UPLOAD_KINDS:
            raise T.ToolError("invalid", "Tipo de documento no válido.")
        name = re.sub(r"[^\w.\- ]+", "_", Path(str(args.get("filename") or "documento")).name).strip() or "documento"
        raw = str(args.get("data") or "")
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        try:
            content = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError) as exc:
            raise T.ToolError("invalid", "El archivo no llegó bien.") from exc
        if not content or len(content) > 40_000_000:
            raise T.ToolError("invalid", "El archivo está vacío o es demasiado grande (máximo 40 MB).")
        folder = self.paths.outbox
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{uuid.uuid4().hex[:8]}-{name}"
        path.write_bytes(content)
        try:
            r = self.kafka.call("doc_add_file", {"path": str(path.resolve()), **({"kind": kind} if kind else {}),
                                                 "item": (item.get("name") or "")[:160]}, timeout=180)
        finally:
            try:
                path.unlink()
            except OSError:
                pass
        if not r["ok"]:
            return {"ok": False, "reason": r["reason"], "message": r["message"], "detail": r.get("detail")}
        docs = r["result"].get("documents") or []
        ids = [d["id"] for d in docs if d.get("id")]
        details = T.details_of(self.ctx, item["id"])
        if ids:
            details = T.save_details(self.ctx, item["id"], {"kafka_doc_ids": details["kafka_doc_ids"] + [i for i in ids if i not in details["kafka_doc_ids"]]})
        return {"ok": True, "created": r["result"].get("created"), "duplicate_of": r["result"].get("duplicate_of"),
                "documents": [{k: d.get(k) for k in ("id", "title", "kind", "kind_label", "issuer", "issue_date")} for d in docs], "details": details}


# ======================================================================== HTTP
def make_handler(app: App) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "HomeHoard/" + VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet console
            return

        # ------------------------------------------------------------ responses
        def _cors(self) -> None:
            origin = self.headers.get("Origin", "")
            if local_origin(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _send(self, code: int, body: bytes, ctype: str, extra: Optional[dict[str, str]] = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self._cors()
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code: int, payload: Any) -> None:
            self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", {"Cache-Control": "no-store"})

        def _body(self, limit: int = MAX_BODY) -> Any:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > limit:
                raise T.ToolError("invalid", "El cuerpo de la petición está vacío o es demasiado grande.")
            try:
                return json.loads(self.rfile.read(length))
            except ValueError as exc:
                raise T.ToolError("invalid", "El cuerpo no es JSON válido.") from exc

        def _bearer_ok(self) -> bool:
            return check_bearer(self.headers.get("Authorization", ""), app.token)

        # ------------------------------------------------------------ verbs
        def do_OPTIONS(self) -> None:
            origin = self.headers.get("Origin", "")
            if not urlparse(self.path).path.startswith("/api/") or not local_origin(origin):
                self._json(403, {"error": "Origen no permitido"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_HEAD(self) -> None:
            self.do_GET()

        def do_GET(self) -> None:
            error = check_request("GET", self.headers)
            if error:
                self._json(403, {"error": error})
                return
            url = urlparse(self.path)
            path = url.path
            try:
                if app.copilot is not None and app.copilot.handle(self):   # the Faustus relay: info, panel, launcher
                    return
                if path in ("/api/status", "/api/health"):
                    self._json(200, app.health())
                elif path == copilotmod.CLIENT_PATH and app.copilot is not None:
                    self._send(200, copilotmod.client_js(), "application/javascript; charset=utf-8", {"Cache-Control": "no-cache"})
                elif path == "/api/home":
                    self._json(200, app.store.client_state())
                elif path == "/api/home/version":
                    self._json(200, app.store.info())
                elif path == "/api/family/agenda":
                    if not self._bearer_ok():
                        self._json(401, {"error": "Token no válido", "hint": "Usa el token de data/mcp-token."})
                        return
                    q = parse_qs(url.query)
                    one = lambda key: (q.get(key) or [""])[0]  # noqa: E731
                    self._json(200, AG.answer(lambda: app.ctx, one("from") or None, one("to") or None, one("sphere")))
                elif path == "/api/agent/tools":
                    self._json(200, {"app": APP_ID, "tools": T.catalog(), "instructions": T.INSTRUCTIONS})
                elif path == "/api/settings":
                    self._json(200, app.settings())
                elif path == "/api/kafka/status":
                    self._json(200, app.kafka_status(force="force" in parse_qs(url.query)))
                elif path == "/api/maintenance/templates":
                    self._json(200, T.t_maint_templates(app.ctx, {}))
                elif path == "/casa3d" or path.startswith("/casa3d/"):
                    self._house3d(path[len("/casa3d"):].lstrip("/"), parse_qs(url.query))
                elif path == "/api/house3d/scene":
                    home = (parse_qs(url.query).get("home") or [""])[0]
                    self._json(200, T.call(app.ctx, "home_3d_scene", {"detail": True, **({"home": home} if home else {})}))
                elif path == "/api/house3d/locate":
                    q = parse_qs(url.query)
                    query = (q.get("q") or q.get("query") or q.get("item") or [""])[0]
                    limit = (q.get("limit") or ["8"])[0]
                    self._json(200, T.call(app.ctx, "home_3d_locate", {"query": query, "limit": int(limit) if limit.isdigit() else 8}))
                elif path in ("/api/house3d/export.glb", "/api/house3d/export.obj"):
                    q = parse_qs(url.query)
                    items = (q.get("items") or [""])[0]
                    scale = (q.get("scale") or ["100"])[0]
                    built = T.export_bytes(app.ctx, path.rsplit(".", 1)[1], home=(q.get("home") or [""])[0],
                                           include_items=None if items == "" else items not in ("0", "false", "no"),
                                           scale=float(scale) if scale.replace(".", "", 1).isdigit() else 100.0)
                    self._send(200, built["data"], "model/gltf-binary" if built["name"].endswith(".glb") else "model/obj",
                               {"Content-Disposition": f'attachment; filename="{built["name"]}"', "Cache-Control": "no-store"})
                elif path == "/api/house3d/vulcan":
                    self._json(200, app.vulcan_status(force="force" in parse_qs(url.query)))
                elif path.startswith("/photos/"):
                    self._photo(path[len("/photos/"):])
                elif path == "/icon.png":
                    self._file(C.ROOT / "app-icon.png", cache=True)
                elif path in ("/importar", "/importar/"):
                    self._page(IMPORT_PAGE.encode("utf-8"))
                elif path.startswith("/api/"):
                    self._json(404, {"error": "No encontrado"})
                else:
                    self._web(path)
            except T.ToolError as exc:
                self._json(400, exc.to_dict())

        def do_POST(self) -> None:
            error = check_request("POST", self.headers)
            if error:
                self._json(403, {"error": error})
                return
            path = urlparse(self.path).path
            try:
                if app.copilot is not None and app.copilot.handle(self):   # the Faustus relay: proxy
                    return
                if path == "/api/home/sync":
                    body = self._body(MAX_SYNC_BODY)
                    if not isinstance(body, dict) or not isinstance(body.get("records", {}), dict):
                        raise T.ToolError("invalid", "Se espera {base_version, records, photos}.")
                    result = app.store.merge(body.get("records") or {}, body.get("photos") or {}, mode="sync", origin="app")
                    self._json(200, {"ok": True, **{k: result[k] for k in ("applied", "ignored", "invalid", "notes", "version", "instance")},
                                     "base_version": body.get("base_version"), "state": app.store.client_state()})
                elif path == "/api/home/item-patch":
                    body = self._body(MAX_SYNC_BODY)
                    if not isinstance(body, dict) or not isinstance(body.get("id"), str):
                        raise T.ToolError("invalid", "Se espera {id, patch}.")
                    self._json(200, {"ok": True, "state": app.store.patch_item(body["id"], body.get("patch"))})
                elif path == "/api/import":
                    self._json(200, inventory.save(self._body()))
                elif path == "/api/agent/call":
                    self._agent_call()
                elif path == "/api/ui/call":
                    body = self._body()
                    if not isinstance(body, dict):
                        raise T.ToolError("invalid", "Se espera {tool, arguments}.")
                    self._json(200, T.call(app.ctx, str(body.get("tool") or body.get("name") or ""), body.get("arguments")))
                elif path == "/api/settings":
                    self._json(200, app.set_settings(self._body()))
                elif path == "/api/house3d/export":
                    self._json(200, T.call(app.ctx, "home_3d_export", self._body()))
                elif path == "/api/house3d/openings":
                    self._json(200, T.call(app.ctx, "home_plan_openings", self._body()))
                elif path == "/api/kafka/search":
                    self._json(200, app.kafka_search(self._body()))
                elif path == "/api/kafka/upload":
                    self._json(200, app.kafka_upload(self._body(60_000_000)))
                elif path == "/api/kafka/mirror/run":
                    result = app.mirror.run_once() if app.mirror else {"enabled": False}
                    self._json(200, {**result, **app.kafka_status(force=True)})
                else:
                    self._json(404, {"error": "No encontrado"})
            except T.ToolError as exc:
                self._json(404 if exc.code == "unknown_tool" else 400, exc.to_dict())
            except ValueError as exc:
                self._json(400, {"error": str(exc)})

        def _agent_call(self) -> None:
            if not self._bearer_ok():
                self._json(401, {"error": "Token no válido", "hint": "Usa el token de data/mcp-token."})
                return
            body = self._body()
            name = str((body or {}).get("name") or (body or {}).get("tool") or "")
            started = time.monotonic()
            try:
                result = T.call(app.ctx, name, (body or {}).get("arguments"))
            except T.ToolError as exc:
                family.record_call(name, False, int((time.monotonic() - started) * 1000), caller=str((body or {}).get("caller") or ""), error=exc.message)
                raise
            family.record_call(name, True, int((time.monotonic() - started) * 1000), caller=str((body or {}).get("caller") or ""))
            self._json(200, result)

        # ------------------------------------------------------------ files
        def _file(self, path: Path, cache: bool = False) -> None:
            try:
                body = path.read_bytes()
            except OSError:
                self._json(404, {"error": "No encontrado"})
                return
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send(200, body, ctype, {"Cache-Control": "public, max-age=31536000, immutable" if cache else "no-cache"})

        def _page(self, body: bytes) -> None:
            """An HTML page of the app: with the Faustus launcher added when the copilot is on."""
            if app.copilot is not None:
                body = copilotmod.inject(body)
            self._send(200, body, "text/html; charset=utf-8", {"Cache-Control": "no-cache"})

        def _html_file(self, path: Path) -> None:
            try:
                self._page(path.read_bytes())
            except OSError:
                self._json(404, {"error": "No encontrado"})

        def _house3d(self, rel: str, query: dict[str, list[str]]) -> None:
            """The 3D view: its page (with the Faustus launcher unless it is embedded in the app) and its static files."""
            root = HOUSE3D_STATIC.resolve()
            target = (root / (rel or "index.html")).resolve()
            try:
                target.relative_to(root)
                body = target.read_bytes()
            except (ValueError, OSError):
                self._json(404, {"error": "No encontrado"})
                return
            if not rel:
                if app.copilot is not None and "embed" not in query:
                    body = copilotmod.inject(body)
                self._send(200, body, "text/html; charset=utf-8", {"Cache-Control": "no-cache"})
                return
            ctype = STATIC_TYPES.get(target.suffix.lower()) or "application/octet-stream"
            self._send(200, body, ctype, {"Cache-Control": "public, max-age=86400" if rel.startswith("vendor/") else "no-cache"})

        def _photo(self, name: str) -> None:
            item_id = re.sub(r"\.(jpg|png|webp)$", "", name)
            found = app.store.photo_file(item_id)
            if not found:
                self._json(404, {"error": "Foto no encontrada"})
                return
            self._file(found, cache=True)

        def _web(self, path: str) -> None:
            root = app.web
            index = root / "index.html"
            if not index.is_file():
                self._send(200, NO_WEB_PAGE.encode("utf-8"), "text/html; charset=utf-8")
                return
            rel = path.lstrip("/")
            target = (root / rel).resolve() if rel else index
            try:
                target.relative_to(root.resolve())
            except ValueError:
                self._json(404, {"error": "No encontrado"})
                return
            if rel and target.is_file():
                if target.suffix == ".html":
                    self._html_file(target)
                else:
                    self._file(target, cache="/_expo/static/" in path or "/assets/" in path)
            elif rel and (root / (rel + ".html")).is_file():
                self._html_file(root / (rel + ".html"))
            else:
                self._html_file(index)

    return Handler


def serve(app: Optional[App] = None, *, host: str = "127.0.0.1") -> None:
    app = app or App()
    server = ThreadingHTTPServer((host, app.port), make_handler(app))
    server.daemon_threads = True
    app.start_background()
    try:
        write_url(app.paths.data / "url", f"http://127.0.0.1:{app.port}")
    except OSError:
        pass
    print(f"HomeHoard: http://127.0.0.1:{app.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        if app.mirror:
            app.mirror.stop()
