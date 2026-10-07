"""Stdio MCP bridge for HomeHoard: the family's ``CatalogBridge`` pointed at this app.

It never opens the home file: the tool list comes from ``GET /api/agent/tools`` and every call is proxied to the running server
(``POST /api/agent/call``) with the Bearer token from ``<data>/mcp-token``. When nothing answers, a short-lived launcher starts
``python -m homehoard_server`` and exits, so the server outlives the stdio MCP host. HOMEHOARD_BRIDGE_AUTOSTART=0 turns autostart
off. HOMEHOARD_URL, HOMEHOARD_PORT, HOMEHOARD_TOKEN,
HOMEHOARD_TOKEN_FILE and HOMEHOARD_DATA_DIR work as before.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from homehoard_server import APP_ID, SERVICE  # noqa: E402
from homehoard_server import config as C  # noqa: E402
from homehoard_server.hoard_link.bridge import CatalogBridge  # noqa: E402


class HomeHoardBridge(CatalogBridge):
    """The home's data folder is ``<repo>/data`` (or ``HOMEHOARD_DATA_DIR``), not a folder next to this file."""

    @property
    def data_dir(self) -> Path:
        return C.data_dir()


def make_bridge() -> CatalogBridge:
    return HomeHoardBridge(app=APP_ID, service=SERVICE, package="homehoard_server", default_port=C.DEFAULT_PORT, data_dir_env="HOMEHOARD_DATA_DIR",
                           title="HomeHoard", root=__file__, default_timeout=120.0)


def main() -> None:
    make_bridge().run_bridge()


if __name__ == "__main__":
    main()
