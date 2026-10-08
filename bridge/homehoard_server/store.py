"""The home kept on this computer: every table in ``data/home.json`` and the photos as files in ``data/photos``.

Changes from the app, the phone backups and the agent tools all go through :meth:`HomeStore.merge`: record-level
last-writer-wins by ``updated_at`` (a tombstone wins a tie), atomic writes and a ``version`` that grows with every
change, so the app can tell cheaply whether something changed while it was away."""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from .bundle import LEGACY_TABLES, TABLES, normalize
from .config import Paths
from .hoard_link.atomic import write_bytes_atomic, write_text_atomic

STATE_FORMAT = "homehoard-state"
SCHEMA = 4
PHOTO_DATA = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$")
PHOTO_URL = re.compile(r"^(?:https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)?/photos/([A-Za-z0-9_.:-]+?)(?:\.(?:jpg|png|webp))?(?:\?.*)?$")
MAX_PHOTO_BYTES = 15_000_000
PHOTO_EXT = {"jpeg": "jpg", "png": "png", "webp": "webp"}


def _wins(new: dict[str, Any], old: dict[str, Any]) -> bool:
    """Last writer wins; on a tie a tombstone beats a live record and otherwise the record already kept stays."""
    a, b = int(new.get("updated_at") or 0), int(old.get("updated_at") or 0)
    if a != b:
        return a > b
    return new.get("deleted_at") is not None and old.get("deleted_at") is None


class HomeStore:
    def __init__(self, paths: Paths, clock: Callable[[], float] = time.time):
        self.paths = paths
        self.clock = clock
        self.lock = threading.RLock()
        self.listeners: list[Callable[[dict[str, Any]], None]] = []
        self.state = self._load()

    # ------------------------------------------------------------------ persistence
    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def _empty(self) -> dict[str, Any]:
        return {"format": STATE_FORMAT, "schema": SCHEMA, "instance": uuid.uuid4().hex, "version": 0, "updated_at": None,
                "tables": {t: {} for t in TABLES}}

    def _load(self) -> dict[str, Any]:
        path = self.paths.state
        if not path.exists():
            return self._empty()
        state = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or state.get("format") != STATE_FORMAT:
            raise ValueError(f"{path} is not a HomeHoard state file")
        state.setdefault("tables", {})
        for table in TABLES:
            rows = state["tables"].get(table) or {}
            if isinstance(rows, list):
                rows = {r["id"]: r for r in rows if isinstance(r, dict) and r.get("id")}
            state["tables"][table] = rows
        state["schema"] = SCHEMA
        return state

    def _save(self) -> None:
        write_text_atomic(self.paths.state, json.dumps(self.state, ensure_ascii=False, separators=(",", ":")))
        self._write_snapshot()

    def _write_snapshot(self) -> None:
        """Photo-free copy in the old snapshot format, for anything that still reads ``faustus-inventory.json``."""
        data = {t: [dict(r) for r in self.state["tables"][t].values()] for t in LEGACY_TABLES}
        for item in data["items"]:
            item["photo_uri"] = None
        snapshot = {"format": "homehoard-faustus-snapshot", "exported_at": self.state.get("updated_at"), "data": data}
        try:
            write_text_atomic(self.paths.snapshot, json.dumps(snapshot, ensure_ascii=False))
        except OSError:
            pass

    # ------------------------------------------------------------------ reading
    def info(self) -> dict[str, Any]:
        with self.lock:
            return {"version": self.state["version"], "instance": self.state["instance"], "updated_at": self.state.get("updated_at")}

    def tables(self) -> dict[str, list[dict[str, Any]]]:
        with self.lock:
            return {t: copy.deepcopy(list(rows.values())) for t, rows in self.state["tables"].items()}

    def client_state(self) -> dict[str, Any]:
        with self.lock:
            return {"format": STATE_FORMAT, "schema": SCHEMA, **self.info(), "tables": self.tables()}

    def get(self, table: str, rid: str) -> Optional[dict[str, Any]]:
        with self.lock:
            row = self.state["tables"][table].get(rid)
            return copy.deepcopy(row) if row else None

    def alive(self, table: str) -> list[dict[str, Any]]:
        with self.lock:
            return [copy.deepcopy(r) for r in self.state["tables"][table].values() if r.get("deleted_at") is None]

    def has_data(self) -> bool:
        with self.lock:
            return any(self.state["tables"][t] for t in ("homes", "items"))

    # ------------------------------------------------------------------ photos
    def photo_file(self, item_id: str) -> Optional[Path]:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", item_id or "") or ".." in item_id:
            return None
        for ext in PHOTO_EXT.values():
            path = self.paths.photos / f"{item_id}.{ext}"
            if path.is_file():
                return path
        return None

    def _write_photo(self, item_id: str, data_url: str) -> str:
        match = PHOTO_DATA.match(data_url or "")
        if not match:
            raise ValueError("Foto no válida: solo JPEG, PNG o WebP")
        raw = base64.b64decode(match.group(2))
        if len(raw) > MAX_PHOTO_BYTES:
            raise ValueError("La foto es demasiado grande")
        self._drop_photo(item_id)
        ext = PHOTO_EXT[match.group(1)]
        path = self.paths.photos / f"{item_id}.{ext}"
        write_bytes_atomic(path, raw)
        return f"/photos/{item_id}?v={hashlib.sha1(raw).hexdigest()[:10]}"

    def _drop_photo(self, item_id: str) -> None:
        for ext in PHOTO_EXT.values():
            try:
                (self.paths.photos / f"{item_id}.{ext}").unlink()
            except OSError:
                pass

    def _place_photo(self, rec: dict[str, Any], old: Optional[dict[str, Any]], payload: Optional[str], mode: str, notes: list[str]) -> None:
        rid = rec["id"]
        uri = rec.get("photo_uri")
        if not payload and isinstance(uri, str) and uri.startswith("data:"):
            payload = uri
        if payload:
            try:
                rec["photo_uri"] = self._write_photo(rid, payload)
            except (ValueError, OSError) as exc:
                rec["photo_uri"] = (old or {}).get("photo_uri")
                notes.append(f"{rid}: {exc}")
            return
        if uri is None:
            if mode == "import" and old and old.get("photo_uri"):
                rec["photo_uri"] = old["photo_uri"]      # a backup without photos never deletes one
            elif old and old.get("photo_uri"):
                self._drop_photo(rid)
            return
        found = PHOTO_URL.match(str(uri))
        if found and found.group(1) == rid and self.photo_file(rid):
            rec["photo_uri"] = "/photos/" + str(uri).split("/photos/", 1)[1]
            return
        # a path only the phone or another browser can open: keep what the computer has
        rec["photo_uri"] = (old or {}).get("photo_uri")
        if not rec["photo_uri"]:
            notes.append(f"{rid}: foto no disponible en este ordenador")

    # ------------------------------------------------------------------ writing
    def merge(self, records: dict[str, list[Any]], photos: Optional[dict[str, str]] = None, *, mode: str = "sync",
              origin: str = "app") -> dict[str, Any]:
        """Merge records (per table) with last-writer-wins. ``mode`` is ``sync`` (the app: a null photo removes it) or
        ``import`` (a backup: a missing photo never removes one). Returns what changed and the new version."""
        photos = photos or {}
        applied = ignored = invalid = 0
        changed: dict[str, list[str]] = {}
        notes: list[str] = []
        with self.lock:
            for table, rows in (records or {}).items():
                if table not in TABLES:
                    notes.append(f"tabla desconocida: {table}")
                    continue
                if not isinstance(rows, list):
                    invalid += 1
                    continue
                current = self.state["tables"][table]
                for row in rows:
                    rec = normalize(table, row)
                    if rec is None:
                        invalid += 1
                        continue
                    old = current.get(rec["id"])
                    if old is not None and not _wins(rec, old):
                        ignored += 1
                        continue
                    if table == "items":
                        self._place_photo(rec, old, photos.get(rec["id"]), mode, notes)
                    if table == "maintenance_tasks" and old and old.get("kafka_deadline_id") and not rec.get("kafka_deadline_id"):
                        rec["kafka_deadline_id"] = old["kafka_deadline_id"]
                    if old == rec:
                        ignored += 1
                        continue
                    current[rec["id"]] = rec
                    applied += 1
                    changed.setdefault(table, []).append(rec["id"])
            if applied:
                self.state["version"] += 1
                self.state["updated_at"] = self.now_ms()
                self._save()
            result = {"applied": applied, "ignored": ignored, "invalid": invalid, "changed": changed, "notes": notes, **self.info()}
        if applied:
            for listener in list(self.listeners):
                try:
                    listener({"changed": changed, "origin": origin})
                except Exception:  # noqa: BLE001 — a listener never breaks a write
                    pass
        return result

    def put(self, table: str, rec: dict[str, Any], *, origin: str = "tool") -> dict[str, Any]:
        """Write one record now (tools and server-side changes): its ``updated_at`` is now, or just after the stored one."""
        with self.lock:
            old = self.state["tables"][table].get(rec.get("id") or "")
            now = self.now_ms()
            rec = dict(rec)
            rec["updated_at"] = max(now, int((old or {}).get("updated_at") or 0) + 1)
            rec.setdefault("created_at", (old or {}).get("created_at") or now)
            rec.setdefault("deleted_at", None)
            self.merge({table: [rec]}, mode="sync", origin=origin)
            return copy.deepcopy(self.state["tables"][table][rec["id"]])

    def set_silently(self, table: str, rid: str, **fields: Any) -> None:
        """Server-managed fields (the Kafka deadline id): stored without a new ``updated_at`` so they never win over an
        edit made in the app at the same time."""
        with self.lock:
            row = self.state["tables"][table].get(rid)
            if row is None or all(row.get(k) == v for k, v in fields.items()):
                return
            row.update(fields)
            self._save()
