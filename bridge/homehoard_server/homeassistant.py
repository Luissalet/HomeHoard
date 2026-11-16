"""Home Assistant as a gateway: entities and states, service calls and the event bus.

The instance is reached with its REST API (``/api/states``, ``/api/services/<domain>/<service>``) and a long-lived
token, and its event bus over the WebSocket API (``/api/websocket``: ``auth`` then ``subscribe_events`` for
``state_changed``). Rules kept in ``<data>/homeassistant-rules.json`` say «when X changes to Y, notify / call Z»; the
notification goes through the family's notification facet (:mod:`hoard_link.fam_notify`), so the person is told the way
the hub decides (toast, ntfy, Telegram or mail, with its quiet hours and limits).

Standard library only: the WebSocket client is the small one below (RFC 6455 handshake, text frames, ping/pong, close).
"""
from __future__ import annotations

import base64
import json
import os
import socket
import ssl
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .hoard_link import fam_notify
from .hoard_link.atomic import write_text_atomic

TIMEOUT_S = 10.0
CACHE_S = 5.0
EVENTS_KEPT = 100
STATES = ("on", "off", "unavailable", "unknown")


class HaError(Exception):
    """Something Home Assistant (or the way to it) refused; ``code`` is what the tool layer reports."""

    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint


def normalize_url(value: str) -> str:
    """``http://homeassistant.local:8123/`` → ``http://homeassistant.local:8123``; refuses anything but http(s)."""
    url = str(value or "").strip().rstrip("/")
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HaError("invalid", "La dirección de Home Assistant debe empezar por http:// o https:// y llevar el equipo.")
    if parsed.username or parsed.password:
        raise HaError("invalid", "El token va aparte, no dentro de la dirección.")
    return url


# ---------------------------------------------------------------------- REST
class HaClient:
    """The REST API of one instance. ``opener`` is injectable so tests answer without a socket."""

    def __init__(self, url: str, token: str, *, timeout: float = TIMEOUT_S, opener: Optional[Callable[..., Any]] = None):
        self.url = normalize_url(url)
        self.token = str(token or "")
        self.timeout = timeout
        self._open = opener or urlopen

    def _call(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        if not self.url or not self.token:
            raise HaError("not_configured", "Falta la dirección o el token de Home Assistant.",
                          "Se ponen en Ajustes › Home Assistant.")
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(self.url + path, data=data, method=method,
                          headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with self._open(request, timeout=self.timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            if exc.code == 401:
                raise HaError("auth", "Home Assistant no acepta el token.", "Crea otro token de larga duración en tu perfil.") from exc
            if exc.code == 404:
                raise HaError("not_found", "Home Assistant no tiene esa entidad o ese servicio.") from exc
            raise HaError("error", f"Home Assistant respondió {exc.code}.") from exc
        except (URLError, OSError) as exc:
            raise HaError("unreachable", "No se llega a Home Assistant.", f"Comprueba la dirección y que esté encendido ({exc}).") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise HaError("error", "Home Assistant no devolvió JSON.") from exc

    def api_ok(self) -> dict[str, Any]:
        return self._call("GET", "/api/") or {}

    def states(self) -> list[dict[str, Any]]:
        value = self._call("GET", "/api/states")
        return value if isinstance(value, list) else []

    def state(self, entity_id: str) -> dict[str, Any]:
        value = self._call("GET", "/api/states/" + entity_id)
        return value if isinstance(value, dict) else {}

    def call_service(self, domain: str, service: str, data: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
        value = self._call("POST", f"/api/services/{domain}/{service}", data or {})
        return value if isinstance(value, list) else []


def entity_out(row: dict[str, Any]) -> dict[str, Any]:
    """One state as the app and the tools show it: id, domain, name, state and the useful attributes."""
    entity_id = str(row.get("entity_id") or "")
    attributes = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
    return {"entity_id": entity_id, "domain": entity_id.split(".", 1)[0], "name": attributes.get("friendly_name") or entity_id,
            "state": row.get("state"), "unit": attributes.get("unit_of_measurement"),
            "device_class": attributes.get("device_class"), "last_changed": row.get("last_changed"),
            "attributes": attributes}


# ---------------------------------------------------------------------- WebSocket
class WebSocket:
    """The smallest RFC 6455 client that Home Assistant's event bus needs: text frames, ping/pong and close."""

    def __init__(self, url: str, *, timeout: float = TIMEOUT_S):
        parsed = urlparse(url)
        if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
            raise HaError("invalid", "La dirección del bus debe empezar por ws:// o wss://.")
        self.secure = parsed.scheme == "wss"
        self.host = parsed.hostname
        self.port = parsed.port or (443 if self.secure else 80)
        self.path = (parsed.path or "/api/websocket") + (f"?{parsed.query}" if parsed.query else "")
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self._buffer = b""

    def connect(self) -> None:
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        if self.secure:
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host)
        self.sock = raw
        key = base64.b64encode(os.urandom(16)).decode()
        host = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
        handshake = (f"GET {self.path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        raw.sendall(handshake.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = raw.recv(4096)
            if not chunk:
                raise HaError("unreachable", "Home Assistant cerró la conexión del bus.")
            head += chunk
        head, _, rest = head.partition(b"\r\n\r\n")
        self._buffer = rest
        status = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in status + " ":
            raise HaError("unreachable", f"El bus de Home Assistant rechazó la conexión ({status}).")

    # ---------------------------------------------------------------- frames
    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.sock is None:
            raise HaError("unreachable", "El bus no está conectado.")
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += length.to_bytes(2, "big")
        else:
            header.append(0x80 | 127)
            header += length.to_bytes(8, "big")
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _read(self, size: int) -> bytes:
        while len(self._buffer) < size:
            if self.sock is None:
                raise HaError("unreachable", "El bus no está conectado.")
            chunk = self.sock.recv(65536)
            if not chunk:
                raise HaError("unreachable", "Home Assistant cerró el bus.")
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def recv_text(self) -> Optional[str]:
        """The next text message; ``None`` when the server closed the connection."""
        message = b""
        while True:
            first, second = self._read(2)
            fin, opcode = first & 0x80, first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = int.from_bytes(self._read(2), "big")
            elif length == 127:
                length = int.from_bytes(self._read(8), "big")
            payload = self._read(length) if length else b""
            if opcode == 0x8:                      # close
                return None
            if opcode == 0x9:                      # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:                      # pong
                continue
            message += payload
            if fin:
                return message.decode("utf-8", "replace")

    def close(self) -> None:
        try:
            if self.sock is not None:
                self._send_frame(0x8, b"")
        except (OSError, HaError):
            pass
        finally:
            try:
                if self.sock is not None:
                    self.sock.close()
            except OSError:
                pass
            self.sock = None


def bus_messages(url: str, token: str, *, timeout: float = TIMEOUT_S) -> Iterable[dict[str, Any]]:
    """Authenticate on the bus and yield every ``state_changed`` event until the connection ends."""
    parsed = urlparse(normalize_url(url))
    ws_url = ("wss://" if parsed.scheme == "https" else "ws://") + parsed.netloc + "/api/websocket"
    ws = WebSocket(ws_url, timeout=timeout)
    ws.connect()
    try:
        hello = json.loads(ws.recv_text() or "{}")
        if hello.get("type") != "auth_required":
            raise HaError("unreachable", "El bus de Home Assistant no pidió autenticación.")
        ws.send_text(json.dumps({"type": "auth", "access_token": token}))
        answer = json.loads(ws.recv_text() or "{}")
        if answer.get("type") != "auth_ok":
            raise HaError("auth", "Home Assistant no acepta el token en el bus.", str(answer.get("message") or ""))
        ws.send_text(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
        yield {"__connected__": True}          # the subscription is acknowledged: the bus is live from here on
        while True:
            raw = ws.recv_text()
            if raw is None:
                return
            message = json.loads(raw)
            if message.get("type") == "event":
                event = message.get("event") or {}
                if event.get("event_type") == "state_changed":
                    yield event.get("data") or {}
    finally:
        ws.close()


# ---------------------------------------------------------------------- rules
def _rule_id() -> str:
    return "r" + uuid.uuid4().hex[:8]


def clean_rule(values: dict[str, Any], base: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """One rule with its defaults; ``base`` keeps what the caller did not send (an update)."""
    rule = dict(base or {})
    rule.setdefault("id", _rule_id())
    rule.setdefault("enabled", True)
    rule.setdefault("cooldown_s", 60)
    rule.setdefault("fired", 0)
    rule.setdefault("last_fired_at", None)
    for key in ("name", "entity_id", "from_state", "to_state", "notify_title", "notify_body", "priority",
                "service_domain", "service_name"):
        if key in values:
            rule[key] = str(values[key] or "").strip()
    if "service_data" in values:
        data = values["service_data"]
        if data is not None and not isinstance(data, dict):
            raise HaError("invalid", "service_data es un objeto JSON.")
        rule["service_data"] = data or {}
    if "enabled" in values:
        if not isinstance(values["enabled"], bool):
            raise HaError("invalid", "enabled es true o false.")
        rule["enabled"] = values["enabled"]
    if "cooldown_s" in values:
        value = values["cooldown_s"]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise HaError("invalid", "cooldown_s son segundos, un entero de 0 en adelante.")
        rule["cooldown_s"] = value
    rule.setdefault("name", "")
    rule.setdefault("entity_id", "")
    rule.setdefault("from_state", "")
    rule.setdefault("to_state", "")
    rule.setdefault("notify_title", "")
    rule.setdefault("notify_body", "")
    rule.setdefault("priority", "normal")
    rule.setdefault("service_domain", "")
    rule.setdefault("service_name", "")
    rule.setdefault("service_data", {})
    if not rule["entity_id"]:
        raise HaError("invalid", "Falta la entidad que se vigila (entity_id).")
    if not (rule["notify_title"] or (rule["service_domain"] and rule["service_name"])):
        raise HaError("invalid", "Una regla avisa (notify_title) o llama a un servicio (service_domain y service_name).")
    if not rule["name"]:
        rule["name"] = f"{rule['entity_id']} → {rule['to_state'] or 'cualquier cambio'}"
    if rule["priority"] not in ("low", "normal", "high", "urgent"):
        raise HaError("invalid", "priority es low, normal, high o urgent.")
    return rule


def matches(rule: dict[str, Any], entity_id: str, old: str, new: str) -> bool:
    if not rule.get("enabled", True):
        return False
    pattern = str(rule.get("entity_id") or "")
    if pattern.endswith(".*"):
        if not entity_id.startswith(pattern[:-1]):
            return False
    elif pattern != entity_id:
        return False
    if rule.get("to_state") and new != rule["to_state"]:
        return False
    if rule.get("from_state") and old != rule["from_state"]:
        return False
    return True


# ---------------------------------------------------------------------- gateway
class Gateway:
    """The instance, its cached states, the bus thread and the rules. One per server process."""

    def __init__(self, paths: Any, settings: Callable[[], dict[str, Any]], *, clock: Callable[[], float] = time.time,
                 client_factory: Optional[Callable[[str, str], Any]] = None,
                 bus_factory: Optional[Callable[[str, str], Iterable[dict[str, Any]]]] = None,
                 notify: Optional[Callable[..., dict[str, Any]]] = None, emit: Optional[Callable[..., Any]] = None,
                 app_url: str = ""):
        self.paths = paths
        self.settings = settings
        self.clock = clock
        self.app_url = app_url.rstrip("/")
        self._client_factory = client_factory or (lambda url, token: HaClient(url, token))
        self._bus_factory = bus_factory or bus_messages
        self._notify = notify or fam_notify.notify
        self._emit = emit
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._states: tuple[float, list[dict[str, Any]]] = (0.0, [])
        self._events: list[dict[str, Any]] = []
        self.connected = False
        self.last_error = ""
        self.last_event: Optional[dict[str, Any]] = None
        self.last_notify: dict[str, Any] = {}
        self.rules: list[dict[str, Any]] = self._load_rules()

    # ---------------------------------------------------------------- config
    def config(self) -> Optional[dict[str, str]]:
        values = self.settings() or {}
        url = str(values.get("ha_url") or "").strip()
        token = str(values.get("ha_token") or "").strip()
        if not url or not token:
            return None
        return {"url": normalize_url(url), "token": token}

    def client(self) -> HaClient:
        cfg = self.config()
        if not cfg:
            raise HaError("not_configured", "Home Assistant no está configurado.",
                          "Pon la dirección y el token en Ajustes › Home Assistant.")
        return self._client_factory(cfg["url"], cfg["token"])

    # ---------------------------------------------------------------- rules file
    def _rules_path(self) -> Path:
        return Path(self.paths.data) / "homeassistant-rules.json"

    def _load_rules(self) -> list[dict[str, Any]]:
        try:
            value = json.loads(self._rules_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        rules = value.get("rules") if isinstance(value, dict) else value
        return [r for r in rules if isinstance(r, dict) and r.get("entity_id")] if isinstance(rules, list) else []

    def _save_rules(self) -> None:
        write_text_atomic(self._rules_path(), json.dumps({"rules": self.rules}, ensure_ascii=False, indent=1))

    # ---------------------------------------------------------------- states
    def entities(self, *, domain: str = "", q: str = "", limit: int = 200, offset: int = 0, force: bool = False) -> dict[str, Any]:
        at, cached = self._states
        if force or not cached or self.clock() - at > CACHE_S:
            cached = self.client().states()
            self._states = (self.clock(), cached)
        rows = [entity_out(r) for r in cached]
        if domain:
            rows = [r for r in rows if r["domain"] == domain]
        if q:
            needle = _fold(q)
            rows = [r for r in rows if needle in _fold(r["entity_id"]) or needle in _fold(r["name"])]
        rows.sort(key=lambda r: (r["domain"], r["name"].lower()))
        page = rows[offset: offset + limit]
        return {"entities": page, "total": len(rows), "offset": offset, "limit": limit, "has_more": offset + len(page) < len(rows)}

    def state(self, entity_id: str) -> dict[str, Any]:
        entity_id = str(entity_id or "").strip()
        if not entity_id or "." not in entity_id:
            raise HaError("invalid", "Se espera un entity_id como light.salon.")
        return entity_out(self.client().state(entity_id))

    def call_service(self, domain: str, service: str, data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        domain, service = str(domain or "").strip(), str(service or "").strip()
        if not domain or not service:
            raise HaError("invalid", "Faltan el dominio y el servicio (p. ej. light y turn_on).")
        changed = self.client().call_service(domain, service, data or {})
        self._states = (0.0, [])
        return {"ok": True, "service": f"{domain}.{service}", "changed": [entity_out(r) for r in changed], "count": len(changed)}

    # ---------------------------------------------------------------- rules
    def list_rules(self) -> list[dict[str, Any]]:
        return list(self.rules)

    def save_rule(self, values: dict[str, Any], rule_id: str = "") -> dict[str, Any]:
        with self._lock:
            if rule_id:
                found = next((r for r in self.rules if r.get("id") == rule_id), None)
                if found is None:
                    raise HaError("not_found", "Esa regla no existe.")
                rule = clean_rule(values, found)
            else:
                rule = clean_rule(values)
            self.rules = [r for r in self.rules if r.get("id") != rule["id"]] + [rule]
            self._save_rules()
        return rule

    def delete_rule(self, rule_id: str, confirm: bool = False) -> dict[str, Any]:
        if not confirm:
            raise HaError("confirm_required", "Borrar una regla necesita confirm=true.")
        with self._lock:
            before = len(self.rules)
            self.rules = [r for r in self.rules if r.get("id") != rule_id]
            if len(self.rules) == before:
                raise HaError("not_found", "Esa regla no existe.")
            self._save_rules()
        return {"ok": True, "deleted": rule_id}

    def events(self, limit: int = 50) -> list[dict[str, Any]]:
        return list(reversed(self._events[-limit:]))

    # ---------------------------------------------------------------- actions
    def fire(self, rule: dict[str, Any], *, old: str = "", new: str = "", entity_id: str = "") -> dict[str, Any]:
        """Run a rule's actions now: the notification through the hub and/or the service call."""
        entity_id = entity_id or str(rule.get("entity_id") or "")
        done: dict[str, Any] = {"rule": rule.get("id"), "notified": None, "service": None}
        if rule.get("notify_title") and (self.settings() or {}).get("ha_notify", True) is not False:
            title = str(rule["notify_title"])
            body = str(rule.get("notify_body") or "").strip() or f"{entity_id}: {old or '—'} → {new or '—'}"
            try:
                answer = self._notify(title, body, priority=str(rule.get("priority") or "normal"),
                                      url=(self.app_url + "/homeassistant") if self.app_url else "",
                                      group="homeassistant", dedupe_key=f"ha:{rule.get('id')}:{new}")
            except Exception as exc:  # noqa: BLE001 — the hub is a hint; the rule still runs
                answer = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            self.last_notify = answer if isinstance(answer, dict) else {"ok": bool(answer)}
            done["notified"] = self.last_notify
        if rule.get("service_domain") and rule.get("service_name"):
            try:
                done["service"] = self.call_service(rule["service_domain"], rule["service_name"], rule.get("service_data") or {})
            except HaError as exc:
                done["service"] = {"ok": False, "error": exc.message, "code": exc.code}
        with self._lock:
            rule["fired"] = int(rule.get("fired") or 0) + 1
            rule["last_fired_at"] = int(self.clock() * 1000)
            self._save_rules()
        if self._emit:
            try:
                self._emit("homehoard.homeassistant.rule", {"rule_id": rule.get("id"), "name": rule.get("name"),
                                                            "entity_id": entity_id, "from": old, "to": new})
            except Exception:  # noqa: BLE001 — the bus is a hint
                pass
        return done

    def handle_event(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """One ``state_changed`` payload: keep it, then run every rule that matches."""
        entity_id = str(data.get("entity_id") or "")
        old = (data.get("old_state") or {}).get("state")
        new = (data.get("new_state") or {}).get("state")
        if not entity_id:
            return []
        event = {"entity_id": entity_id, "from": old, "to": new, "at": int(self.clock() * 1000)}
        self._events = (self._events + [event])[-EVENTS_KEPT:]
        self.last_event = event
        fired: list[dict[str, Any]] = []
        now = self.clock()
        for rule in list(self.rules):
            if not matches(rule, entity_id, str(old), str(new)):
                continue
            cooldown = int(rule.get("cooldown_s") or 0)
            last = rule.get("last_fired_at")
            if cooldown and last and now * 1000 - int(last) < cooldown * 1000:
                continue
            fired.append(self.fire(rule, old=str(old), new=str(new), entity_id=entity_id))
        return fired

    # ---------------------------------------------------------------- thread
    def start(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="homehoard-homeassistant", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        backoff = 5.0
        while not self._stop.is_set():
            cfg = self.config()
            if not cfg:
                self.connected = False
                self._stop.wait(5.0)
                continue
            try:
                for data in self._bus_factory(cfg["url"], cfg["token"]):
                    self.connected = True
                    self.last_error = ""
                    backoff = 5.0
                    self.handle_event(data)
                    if self._stop.is_set():
                        break
            except Exception as exc:  # noqa: BLE001 — the bus reconnects; the reason is shown in the status
                self.last_error = f"{type(exc).__name__}: {exc}"
            finally:
                self.connected = False
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 60.0)

    # ---------------------------------------------------------------- status
    def status(self, *, probe: bool = False) -> dict[str, Any]:
        cfg = self.config()
        out: dict[str, Any] = {"configured": bool(cfg), "url": (cfg or {}).get("url", ""), "token_set": bool((cfg or {}).get("token")),
                               "connected": self.connected, "rules": len(self.rules), "last_event": self.last_event,
                               "last_error": self.last_error, "last_notify": self.last_notify,
                               "notify": (self.settings() or {}).get("ha_notify", True) is not False}
        if cfg and probe:
            try:
                info = self.client().api_ok()
                out.update({"reachable": True, "version": info.get("version"), "location_name": info.get("location_name"),
                            "message": info.get("message")})
                out["entities"] = len(self.client().states())
            except HaError as exc:
                out.update({"reachable": False, "error": exc.message, "code": exc.code, "hint": exc.hint})
        return out


def _fold(text: str) -> str:
    """Accent- and case-insensitive comparison, like the rest of the app's search."""
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", str(text or "").lower()) if unicodedata.category(c) != "Mn")