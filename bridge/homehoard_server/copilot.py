"""The Faustus copilot inside HomeHoard: thin glue around the vendored Hoard Link relay.

The transport (``/api/copilot/info``, ``/panel.js``, ``/proxy``, ``/launcher.js``: forced origin, allow-list, SSE streaming,
the Faustus token kept on the server) is ``hoard_link.copilot_stdlib.CopilotRelay``, which suits this plain ``http.server``
host. What lives here is only what is specific to HomeHoard:

* ``install`` builds the relay for this process (``None`` with ``HOARD_COPILOT=0``);
* ``inject`` adds the page-side script (``static/copilot.js``, which defines ``window.hoardCopilot``) and the shared launcher
  to the HTML pages the app serves;
* ``client_js`` serves that page-side script.

The routes sit behind the family guard of ``app.py`` (loopback Host, local Origin, Fetch Metadata) and need no token: the web
app does not have one either. Faustus is found through ``HOMEHOARD_FAUSTUS_URL`` / ``HOARD_FAUSTUS_URL``
(+ ``HOARD_FAUSTUS_TOKEN``) or the Hoard Link config.
"""
from __future__ import annotations

import os
from pathlib import Path

from .hoard_link.copilot import inject_launcher
from .hoard_link.copilot_stdlib import CopilotRelay

APP_ID = "homehoard"
APP_NAME = "HomeHoard"
CLIENT_PATH = "/copilot.js"
CLIENT_TAG = b'<script src="/copilot.js"></script>'
STATIC = Path(__file__).resolve().parent / "static"


def enabled() -> bool:
    return os.environ.get("HOARD_COPILOT", "1").strip().lower() not in ("0", "false", "no", "off")


def install(data_dir, urls=None, faustus_token=None):
    """The relay for this process, or ``None`` when ``HOARD_COPILOT=0``."""
    if not enabled():
        return None
    return CopilotRelay(APP_ID, data_dir, app_name=APP_NAME, faustus_urls=urls, token=faustus_token)


def client_js() -> bytes:
    return (STATIC / "copilot.js").read_bytes()


def inject(html: bytes) -> bytes:
    """``html`` with the page-side script and then the launcher before ``</body>``; unchanged when already there."""
    if b"/api/copilot/launcher.js" in html:
        return html
    at = html.lower().rfind(b"</body>")
    html = html + CLIENT_TAG if at < 0 else html[:at] + CLIENT_TAG + html[at:]
    return CopilotRelay.inject_html(html)
