"""Shared pieces for the server tests: a temporary home, a fixed clock and a fake Kafka behind the hub."""
from __future__ import annotations

import tempfile
import threading
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from homehoard_server.app import App, make_handler

T0 = datetime(2026, 10, 2, 10, 0).timestamp()


class Clock:
    def __init__(self, t: float = T0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def rec(id: str, name: str = "", t: int = 1_000, **extra: Any) -> dict[str, Any]:
    return {"id": id, "name": name, "created_at": t, "updated_at": t, "deleted_at": None, **extra}


def sample_records(t: int = 1_000) -> dict[str, list[dict[str, Any]]]:
    """An invented flat: one floor, a kitchen and a storage room with nested boxes."""
    return {
        "households": [rec("hh", "Mi casa", t)],
        "homes": [rec("home", "Piso de prueba", t, household_id="hh", kind="flat")],
        "floors": [rec("floor", "Planta única", t, home_id="home", level_index=0)],
        "rooms": [rec("kitchen", "Cocina", t, floor_id="floor", kind="kitchen"), rec("storage", "Trastero", t, floor_id="floor", kind="storage"),
                  rec("bath", "Baño", t, floor_id="floor", kind="bathroom")],
        "containers": [rec("shelf", "Estantería", t, room_id="storage", parent_container_id=None),
                       rec("redbox", "Caja roja", t, room_id="storage", parent_container_id="shelf"),
                       rec("drawer", "Cajón rojo", t, room_id="kitchen", parent_container_id=None)],
        "items": [rec("torch", "Linterna Philips", t, household_id="hh", room_id="storage", container_id="redbox", quantity=1, photo_uri=None, favorite=0),
                  rec("washer", "Lavadora Demo", t, household_id="hh", room_id="kitchen", container_id=None, quantity=1, photo_uri=None, favorite=0),
                  rec("boiler", "Caldera de gas", t, household_id="hh", room_id="kitchen", container_id=None, quantity=1, photo_uri=None, favorite=0)],
        "tags": [rec("electric", "Material eléctrico", t, household_id="hh")],
        "itemTags": [{"item_id": "torch", "tag_id": "electric", "updated_at": t, "deleted_at": None}],
    }


class FakeKafka:
    """Answers like the hub proxy for Kafka's tools; ``down`` simulates the hub or Kafka being closed."""

    def __init__(self):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.down: str | None = None
        self.deadlines: dict[tuple[str, str], dict[str, Any]] = {}
        self.docs = {"d_manual": {"id": "d_manual", "title": "Manual lavadora", "kind": "manual", "issuer": "", "issue_date": ""},
                     "d_invoice": {"id": "d_invoice", "title": "Factura lavadora", "kind": "invoice", "issuer": "Tienda Demo", "issue_date": "2026-01-10"}}
        self.outdated = False
        self.files: list[dict[str, Any]] = []

    def __call__(self, app: str, tool: str, args: dict[str, Any], timeout: float = 0) -> dict[str, Any]:
        self.calls.append((tool, dict(args)))
        if self.down == "hub":
            return {"ok": False, "app": app, "tool": tool, "status": None, "error": "hub not reachable at http://127.0.0.1:8810"}
        if self.down == "kafka":
            return {"ok": False, "app": app, "tool": tool, "status": None, "error": "not reachable"}
        ok = lambda result: {"ok": True, "app": app, "tool": tool, "status": 200, "result": result}  # noqa: E731
        if tool == "deadline_add":
            key = (args.get("source"), args.get("external_key"))
            if self.outdated:
                return ok({"deadline": {"id": f"t_plain{len(self.calls)}", "state": "open"}})
            existing = self.deadlines.get(key)
            dl = {"id": existing["id"] if existing else f"t_{len(self.deadlines) + 1}", "date": args["date"], "title": args["title"], "state": "open",
                  "basis": args.get("basis"), "rule": args.get("rule"), "remind": args.get("remind")}
            self.deadlines[key] = dl
            return ok({"deadline": dl, "action": "updated" if existing else "created"})
        if tool == "deadline_update_by_key":
            key = (args["source"], args["external_key"])
            if key not in self.deadlines:
                return {"ok": False, "app": app, "tool": tool, "status": 400, "error": "No deadline"}
            self.deadlines[key]["state"] = args.get("state", "open")
            return ok({"deadline": self.deadlines[key], "action": "closed"})
        if tool == "deadline_delete":
            return ok({"deleted": args["deadline"]})
        if tool == "docs_list":
            ids = args.get("doc_ids")
            docs = [d for d in self.docs.values() if ids is None or d["id"] in ids]
            if args.get("text"):
                docs = [d for d in docs if args["text"].lower() in d["title"].lower()]
            return ok({"documents": docs[: args.get("limit", 50)], "count": len(docs), "missing": [i for i in (ids or []) if i not in self.docs]})
        if tool == "doc_search":
            scope = args.get("doc_ids") or list(self.docs)
            hits = [{"doc_id": "d_manual", "title": "Manual lavadora", "page": 2, "kind": "manual", "snippet": "Código **E21**: el agua no se evacua",
                     "cite": "[d_manual · p. 2]"}] if "e21" in args["query"].lower() and "d_manual" in scope else []
            return ok({"query": args["query"], "results": hits, "count": len(hits)})
        if tool == "warranty_check":
            rows = [{"deadline": "t_w", "title": "Fin de garantía: Lavadora", "ends": "2029-01-10", "days_left": 831, "active": True,
                     "document": {"id": "d_invoice", "title": "Factura lavadora"}, "basis": "RDL 7/2021: 3 años", "cite": "[d_invoice · p. 1]"}]
            return ok({"warranties": rows if "lavadora" in args["text"].lower() else [], "count": 1})
        if tool == "doc_add_file":
            path = Path(args["path"])
            self.files.append({"name": path.name, "bytes": path.read_bytes(), "kind": args.get("kind"), "item": args.get("item")})
            doc = {"id": "d_new", "title": path.stem, "kind": args.get("kind") or "other", "issuer": "", "issue_date": ""}
            self.docs["d_new"] = doc
            return ok({"created": True, "documents": [doc]})
        return {"ok": False, "app": app, "tool": tool, "status": 404, "error": f"Unknown tool: {tool}"}


def make_app(tmp: str, **kw: Any) -> tuple[App, Clock, FakeKafka, list]:
    clock = Clock()
    kafka = FakeKafka()
    events: list = []
    app = App(Path(tmp) / "data", clock=clock, kafka_call=kafka, emit=lambda t, d=None, **k: events.append((t, d)),
              web_dir=Path(tmp) / "web", port=5196, **kw)
    return app, clock, kafka, events


class Running:
    """The HTTP server on a free port for the duration of a test."""

    def __init__(self, app: App):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.httpd.server_port}"

    def __exit__(self, *exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


def tempdir() -> tempfile.TemporaryDirectory:
    return tempfile.TemporaryDirectory()
