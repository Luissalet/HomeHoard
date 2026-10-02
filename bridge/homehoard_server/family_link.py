"""The vendored family library (``hoard_link``), or a stand-in that says why it is missing.

``hoard_link`` needs ``httpx`` at import time. The server is otherwise standard library: when the library cannot be
imported the inventory keeps working and every family feature answers ``{"ok": False, "error": "hoard_link_unavailable"}``."""
from __future__ import annotations

from typing import Any, Optional

try:
    from .hoard_link import family as _family  # noqa: F401
    IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # noqa: BLE001
    _family = None
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


class _Missing:
    """Same calls as ``hoard_link.family``; nothing leaves the computer."""

    def configure(self, *a: Any, **k: Any) -> dict[str, Any]:
        return {"enabled": False}

    def emit(self, *a: Any, **k: Any) -> bool:
        return False

    def call(self, app: str, tool: str, arguments: Any = None, **k: Any) -> dict[str, Any]:
        return {"ok": False, "app": app, "tool": tool, "status": None, "error": "hoard_link_unavailable", "detail": IMPORT_ERROR}

    def record_call(self, *a: Any, **k: Any) -> None:
        return None

    def health_block(self) -> dict[str, Any]:
        return {"version": None, "family": None, "events": False, "app": None, "hub": None, "error": IMPORT_ERROR}


family: Any = _family if _family is not None else _Missing()
