"""The Faustus copilot inside HomeHoard: a small same-origin relay, standard library only.

Hoard Link ships the relay for FastAPI and Node hosts; HomeHoard's server is a plain ``http.server`` one, so the same
four routes live here with the same behaviour:

* ``GET  /api/copilot/info``        the app, its stable data space id, where the panel comes from;
* ``GET  /api/copilot/panel.js``    the ``<faustus-chat>`` element, served by Faustus through this relay;
* ``POST /api/copilot/proxy``       every panel request (chat turns as Server-Sent Events, sessions, uploads); the Faustus
  token stays on the server, ``origin.app_id`` / ``data_space_id`` are forced and only the copilot paths of Faustus can
  be reached;
* ``GET  /api/copilot/launcher.js`` the floating "Faustus" button and side panel, added to the pages the app serves.

Like the rest of this server the routes sit behind the family guard (loopback Host, local Origin, Fetch Metadata) and
need no token: the web app does not have one either.

Faustus is found through ``HOMEHOARD_FAUSTUS_URL`` / ``HOARD_FAUSTUS_URL`` (+ ``HOARD_FAUSTUS_TOKEN``) or the Hoard Link
config, falling back to ``127.0.0.1:7000`` / ``7001``. ``HOARD_COPILOT=0`` turns the copilot off.
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import urllib.error
import urllib.request
import uuid
from email.message import Message
from email.parser import BytesHeaderParser
from pathlib import Path
from urllib.parse import urlsplit

APP_ID = "homehoard"
APP_NAME = "HomeHoard"
LAUNCHER_PATH = "/api/copilot/launcher.js"
CLIENT_PATH = "/copilot.js"
LAUNCHER_TAG = b'<script type="module" src="/api/copilot/launcher.js"></script>'
CLIENT_TAG = b'<script src="/copilot.js"></script>'
MAX_BODY = 64 * 1024 * 1024
STATIC = Path(__file__).resolve().parent / "static"
_FORWARD_UP = ("content-type", "x-odysseus-run-id", "x-faustus-idempotent-replay", "x-faustus-api-version")
_FORWARD_DOWN = ("x-faustus-client-version", "x-odysseus-run-id")


def enabled() -> bool:
    return os.environ.get("HOARD_COPILOT", "1").strip().lower() not in ("0", "false", "no", "off")


def launcher_js() -> bytes:
    """The browser launcher: the vendored Hoard Link's, else the copy that ships with the app."""
    try:
        from .hoard_link.copilot_launcher import LAUNCHER_JS
        if isinstance(LAUNCHER_JS, str) and LAUNCHER_JS.strip():
            return LAUNCHER_JS.encode("utf-8")
    except Exception:  # noqa: BLE001 - the vendored copy may predate the launcher
        pass
    return (STATIC / "copilot-launcher.js").read_bytes()


def client_js() -> bytes:
    return (STATIC / "copilot.js").read_bytes()


def inject(html: bytes) -> bytes:
    """``html`` with the page-side script and the launcher before ``</body>`` (or at the end); unchanged when already there."""
    if b"/api/copilot/launcher.js" in html:
        return html
    tags = CLIENT_TAG + LAUNCHER_TAG
    at = html.lower().rfind(b"</body>")
    if at < 0:
        return html + tags
    return html[:at] + tags + html[at:]


def multipart_context(body: bytes, content_type: str, origin: dict) -> bytes:
    """Replace only the ``context`` field of a multipart body; keep uploaded bytes and MIME framing exact."""
    header = Message()
    header["Content-Type"] = content_type
    boundary = header.get_param("boundary")
    if header.get_content_type() != "multipart/form-data" or not boundary:
        return body
    separators = list(re.finditer(rb"(?:^|\r\n)--" + re.escape(boundary.encode()) + rb"(?:--)?(?:\r\n|$)", body))
    replacements = []
    for start, end in zip(separators, separators[1:]):
        part = body[start.end():end.start()]
        split = part.find(b"\r\n\r\n")
        if split < 0:
            continue
        headers = BytesHeaderParser().parsebytes(part[:split] + b"\r\n\r\n")
        if headers.get_param("name", header="Content-Disposition") not in ("context", "hoard_context"):
            continue
        context = json.loads(part[split + 4:].decode("utf-8"))
        if isinstance(context, dict):
            context["origin"] = dict(context.get("origin") or {}, **origin)
            replacements.append((start.end() + split + 4, end.start(), json.dumps(context, ensure_ascii=False).encode("utf-8")))
    for start, end, replacement in reversed(replacements):
        body = body[:start] + replacement + body[end:]
    return body


def path_allowed(path) -> bool:
    """Only the copilot surface of Faustus is reachable through the relay."""
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        return False
    route = urlsplit(path).path
    if ".." in route.split("/") or "%2e" in route.lower() or "\\" in route:   # no walking out of the copilot surface
        return False
    return route.startswith(("/api/hoard-copilot/", "/api/chat/", "/api/session/", "/api/sessions/")) \
        or route in ("/api/chat_stream", "/api/session", "/api/sessions")


def faustus_config():
    env_url = os.environ.get("HOMEHOARD_FAUSTUS_URL") or os.environ.get("HOARD_FAUSTUS_URL")
    token = os.environ.get("HOARD_FAUSTUS_TOKEN") or None
    urls = [env_url] if env_url else []
    try:
        from .hoard_link.config import LinkConfig
        link = LinkConfig.load(app=APP_ID)
        urls = urls or list(link.faustus_urls)
        token = token or link.faustus_token
    except Exception:  # noqa: BLE001
        pass
    return urls or ["http://127.0.0.1:7000", "http://127.0.0.1:7001"], token


def space_id(data_dir) -> str:
    """One stable data space id per data folder, created once."""
    folder = Path(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "copilot-space-id"
    try:
        with open(path, "x", encoding="utf-8") as fh:
            fh.write(str(uuid.uuid4()))
    except FileExistsError:
        pass
    return path.read_text(encoding="utf-8").strip()


class Copilot:
    def __init__(self, data_dir, urls=None, faustus_token=None):
        self.space = space_id(data_dir)
        if urls is None:
            urls, found = faustus_config()
            faustus_token = faustus_token if faustus_token is not None else found
        self.urls = [u.rstrip("/") for u in urls if u]
        self.headers = {"Authorization": "Bearer " + faustus_token} if faustus_token else {}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # loopback: never through a proxy
        self.selected = None
        self._lock = threading.Lock()

    # ---- Faustus ----

    def locate(self) -> str:
        if self.selected:
            return self.selected
        for base in self.urls:
            try:
                req = urllib.request.Request(base + "/api/hoard-copilot/capabilities", headers=self.headers)
                with self.opener.open(req, timeout=3) as response:
                    if response.status == 200 and json.load(response).get("contract_version"):
                        with self._lock:
                            self.selected = base
                        return base
            except (OSError, ValueError, urllib.error.URLError):
                continue
        raise ConnectionError("Faustus copilot is unavailable on the configured endpoints")

    def _forward(self, h, path, method="GET", body=None, content_type="application/json", extra=None):
        try:
            base = self.locate()
        except ConnectionError as exc:
            return h._json(503, {"detail": str(exc)})
        req = urllib.request.Request(base + path, data=body, method=method,
                                     headers=dict(self.headers, **(extra or {}), **{"Content-Type": content_type}))
        try:
            upstream = self.opener.open(req, timeout=900)
        except urllib.error.HTTPError as exc:   # Faustus answered with an error status: pass it through untouched
            upstream = exc
        except (OSError, urllib.error.URLError):
            self.selected = None
            return h._json(503, {"detail": "Faustus copilot connection failed"})
        status = upstream.code if isinstance(upstream, urllib.error.HTTPError) else upstream.status
        h.send_response(status)
        for key, value in upstream.headers.items():
            if key.lower() in _FORWARD_UP:
                h.send_header(key, value)
        h.send_header("Cache-Control", "no-store")
        chunked = getattr(h, "protocol_version", "HTTP/1.0") == "HTTP/1.1"
        if chunked:
            h.send_header("Transfer-Encoding", "chunked")
        else:
            h.send_header("Connection", "close")
            h.close_connection = True
        h.end_headers()
        try:
            while True:
                chunk = upstream.read1(65536) if hasattr(upstream, "read1") else upstream.read(65536)
                if not chunk:
                    break
                h.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk) if chunked else chunk)
                h.wfile.flush()
            if chunked:
                h.wfile.write(b"0\r\n\r\n")
                h.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            h.close_connection = True   # the browser left (panel closed, turn cancelled)
        finally:
            upstream.close()

    # ---- routes ----

    def get(self, h, path):
        if path == "/api/copilot/info":
            try:
                base = self.locate()
            except ConnectionError as exc:
                return h._json(503, {"detail": str(exc)})
            return h._json(200, {"app_id": APP_ID, "app_name": APP_NAME, "data_space_id": self.space,
                                 "panel_url": "/api/copilot/panel.js", "server": "/", "tool_server_id": APP_ID,
                                 "settings_url": base + "/studio/settings"})
        if path == "/api/copilot/panel.js":
            return self._forward(h, "/api/hoard-copilot/panel.js")
        if path == LAUNCHER_PATH:
            h._send(200, launcher_js(), "application/javascript; charset=utf-8", {"Cache-Control": "no-cache"})
            return None
        return h._json(404, {"error": "No encontrado"})

    def proxy(self, h):
        try:
            length = int(h.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return h._json(413, {"detail": "Copilot request too large"})
            envelope = json.loads(h.rfile.read(length).decode("utf-8"))
            if not isinstance(envelope, dict):
                raise ValueError("not an object")
            path = envelope.get("path", "")
            if not path_allowed(path):
                raise ValueError("Unknown copilot operation")
            body = None
            origin = {"app_id": APP_ID, "data_space_id": self.space}
            if "raw_body" in envelope:
                body = base64.b64decode(envelope["raw_body"], validate=True)
                body = multipart_context(body, envelope.get("content_type", ""), origin)
            elif "body" in envelope:
                payload = envelope["body"]
                if isinstance(payload, dict):
                    for field in ("context", "hoard_context"):
                        if isinstance(payload.get(field), dict):
                            payload[field]["origin"] = dict(payload[field].get("origin") or {}, **origin)
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            extra = {k: v for k, v in (envelope.get("headers") or {}).items() if str(k).lower() in _FORWARD_DOWN}
            method = str(envelope.get("method", "GET")).upper()
            content_type = envelope.get("content_type", "application/json")
        except (ValueError, TypeError, AttributeError, UnicodeDecodeError):
            return h._json(400, {"detail": "Invalid copilot transport request"})
        return self._forward(h, path, method, body, content_type, extra)


def install(data_dir, urls=None, faustus_token=None):
    """The relay for this process, or ``None`` when ``HOARD_COPILOT=0``."""
    return Copilot(data_dir, urls, faustus_token) if enabled() else None
