"""HomeHoard server: keeps the home on this computer and serves the web app, the import page (/importar), the agent
tools and the family link on http://127.0.0.1:5196 (loopback only).

    python bridge/server.py            # HOMEHOARD_DATA_DIR, HOMEHOARD_PORT and HOMEHOARD_WEB_DIR change the defaults
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from homehoard_server.app import App, check_request, local_origin, make_handler, serve  # noqa: E402,F401
from homehoard_server.config import DEFAULT_PORT as PORT  # noqa: E402,F401


def main() -> None:
    serve()


if __name__ == "__main__":
    main()
