"""Where things live. Everything is under the data folder (``HOMEHOARD_DATA_DIR``, default ``<repo>/data``)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent.parent
ROOT = BRIDGE.parent
DEFAULT_PORT = 5196


@dataclass(frozen=True)
class Paths:
    data: Path

    @property
    def state(self) -> Path:
        return self.data / "home.json"

    @property
    def photos(self) -> Path:
        return self.data / "photos"

    @property
    def token(self) -> Path:
        return self.data / "mcp-token"

    @property
    def snapshot(self) -> Path:
        return self.data / "faustus-inventory.json"

    @property
    def settings(self) -> Path:
        return self.data / "settings.json"

    @property
    def mirror(self) -> Path:
        return self.data / "kafka-mirror.json"

    @property
    def outbox(self) -> Path:
        return self.data / "kafka-outbox"


def data_dir() -> Path:
    return Path(os.environ.get("HOMEHOARD_DATA_DIR") or ROOT / "data").expanduser().resolve()


def web_dir() -> Path:
    """The exported web app (``npm run build:web``)."""
    return Path(os.environ.get("HOMEHOARD_WEB_DIR") or BRIDGE / "web").expanduser().resolve()


def port() -> int:
    try:
        return int(os.environ.get("HOMEHOARD_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT
