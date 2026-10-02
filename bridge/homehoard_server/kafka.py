"""The link with Kafka's Hoard (papers, warranties, manuals and reminders), always through the hub.

* :class:`KafkaLink` calls Kafka's tools with ``family.call`` and says plainly why it could not (hub down, Kafka down,
  Kafka too old for a tool).
* :class:`KafkaMirror` keeps one Kafka deadline per active maintenance task (``source="homehoard"``, the task id as the
  external key), retries while Kafka is unreachable, closes the deadline when a task is deleted, and tells the family bus
  about maintenance: ``homehoard.maintenance.due`` when a task becomes due and, once a day, ``homehoard.maintenance.upcoming``
  with the tasks due within 7 days."""
from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional

from . import maintenance as MT
from .family_link import family

SOURCE = "homehoard"
DUE_GRACE_DAYS = 2     # a task that became due up to this many days ago is still announced (the app may have been off); older ones are not
REASON_TEXT = {
    "hub_down": "El Hoard Hub no responde: abre el Hub para hablar con Kafka.",
    "app_down": "Kafka's Hoard no responde: ábrelo para ver tus papeles.",
    "app_unknown": "El Hub no conoce Kafka's Hoard.",
    "tool_missing": "Esta versión de Kafka's Hoard no tiene esa función: actualízala.",
    "kafka_outdated": "Kafka's Hoard necesita la versión 0.2 o posterior para guardar los avisos de mantenimiento.",
    "auth": "El Hub no acepta el token de HomeHoard.",
    "hoard_link_unavailable": "Falta la biblioteca de la familia (hoard_link/httpx) en este Python.",
    "error": "Kafka devolvió un error.",
}


def classify(r: dict[str, Any]) -> str:
    if r.get("ok"):
        return "ok"
    err = str(r.get("error") or "")
    status = r.get("status")
    if err == "hoard_link_unavailable":
        return "hoard_link_unavailable"
    if status is None:
        return "hub_down" if "hub not reachable" in err else "app_down"
    if status == 401:
        return "auth"
    low = err.lower()
    if status == 404:
        return "tool_missing" if "tool" in low else "app_unknown"
    if status in (502, 503, 504) or "not reachable" in low or "not running" in low:
        return "app_down"
    return "error"


class KafkaLink:
    def __init__(self, caller: Callable[..., dict[str, Any]] | None = None):
        self._call = caller or family.call

    def call(self, tool: str, arguments: Optional[dict[str, Any]] = None, timeout: float = 60.0) -> dict[str, Any]:
        try:
            r = self._call("kafka", tool, arguments or {}, timeout=timeout)
        except Exception as exc:  # noqa: BLE001 — the link never breaks the caller
            r = {"ok": False, "status": None, "error": f"{type(exc).__name__}: {exc}"}
        reason = classify(r if isinstance(r, dict) else {"ok": False, "error": "bad answer"})
        if reason == "ok":
            return {"ok": True, "result": r.get("result") if isinstance(r.get("result"), dict) else {"result": r.get("result")}}
        return {"ok": False, "reason": reason, "message": REASON_TEXT.get(reason, REASON_TEXT["error"]), "detail": str(r.get("error") or "")[:300]}


# ---------------------------------------------------------------------- maintenance mirror
def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _save_json(path: Path, value: Any) -> None:
    from .store import _atomic_write
    _atomic_write(path, json.dumps(value, ensure_ascii=False, indent=1))


def target_name(store: Any, task: dict[str, Any]) -> str:
    table = {"item": "items", "container": "containers", "room": "rooms", "home": "homes"}.get(task.get("target_kind") or "")
    row = store.get(table, task.get("target_id") or "") if table else None
    return (row or {}).get("name") or ""


def basis_text(task: dict[str, Any]) -> tuple[str, str]:
    """(basis, rule) sent to Kafka for a task: the norm for a legal one, else it says it is advice."""
    tpl = MT.template(task.get("template_id") or "") or {}
    basis = task.get("basis") or tpl.get("basis") or "advice"
    ref = (task.get("legal_ref") or "").strip()
    note = (task.get("notes") or "").strip()
    if basis == "law":
        text = ref or tpl.get("legal_ref") or "Obligación legal indicada en HomeHoard."
        if tpl.get("maker_note"):
            text += " " + tpl["maker_note"]
        return text, tpl.get("rule") or "Norma legal"
    if basis == "maker":
        return " ".join(x for x in ("Recomendación del fabricante.", ref, note) if x), "Fabricante"
    return " ".join(x for x in (MT.catalogue().get("advice_source", ""), tpl.get("note") or "", ref) if x), "Recomendación"


def remind_for(task: dict[str, Any]) -> list[int]:
    tpl = MT.template(task.get("template_id") or "") or {}
    if tpl.get("remind"):
        return list(tpl["remind"])
    return [30, 7, 0] if task.get("basis") == "law" else [7, 0]


class KafkaMirror:
    INTERVAL_S = 60.0

    def __init__(self, store: Any, link: KafkaLink, *, paths: Any, settings: Callable[[], dict[str, Any]], app_url: str = "",
                 clock: Callable[[], float] = time.time, emit: Callable[..., Any] | None = None):
        self.store, self.link, self.paths, self.settings = store, link, paths, settings
        self.app_url = app_url.rstrip("/")
        self.clock = clock
        self.emit = emit or family.emit
        self.lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.state = _load_json(paths.mirror, {"tasks": {}})
        self.state.setdefault("tasks", {})

    # ---------------------------------------------------------------- loop
    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="homehoard-kafka-mirror", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self, *_: Any) -> None:
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception as exc:  # noqa: BLE001
                self.state["last_error"] = f"{type(exc).__name__}: {exc}"
            self._wake.wait(self.INTERVAL_S)
            self._wake.clear()
            time.sleep(1.5)          # gather a burst of edits into one pass

    def today(self) -> date:
        return datetime.fromtimestamp(self.clock()).date()

    # ---------------------------------------------------------------- one pass
    def desired(self, task: dict[str, Any]) -> dict[str, Any]:
        name = target_name(self.store, task)
        basis, rule = basis_text(task)
        return {"title": f"Mantenimiento: {task.get('title') or 'tarea'}" + (f" ({name})" if name else ""),
                "date": task.get("next_due") or MT.compute_next_due(task), "kind": "custom", "remind": remind_for(task),
                "basis": basis, "rule": rule, "url": f"{self.app_url}/maintenance?task={task['id']}" if self.app_url else "",
                "source": SOURCE, "external_key": task["id"]}

    def run_once(self) -> dict[str, Any]:
        with self.lock:
            enabled = bool(self.settings().get("kafka_mirror", True))
            tasks = {t["id"]: t for t in self.store.tables()["maintenance_tasks"]}
            sent = closed = failed = 0
            outdated = False
            for tid, task in tasks.items():
                entry = self.state["tasks"].get(tid)
                active = task.get("deleted_at") is None and not task.get("paused") and enabled
                if not active:
                    if entry and entry.get("deadline_id") and not entry.get("closed"):
                        r = self.link.call("deadline_update_by_key", {"source": SOURCE, "external_key": tid, "state": "dismissed"}, timeout=30)
                        if r["ok"] or (r.get("reason") == "error" and "No deadline" in r.get("detail", "")):
                            entry.update(closed=True, ok=True, error="", ts=self.clock(), action="closed")
                            closed += 1
                        else:
                            entry.update(ok=False, error=r["message"], reason=r.get("reason"), ts=self.clock())
                            failed += 1
                    continue
                want = self.desired(task)
                digest = hashlib.sha1(json.dumps(want, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                if entry and entry.get("ok") and entry.get("digest") == digest and not entry.get("closed"):
                    continue
                if outdated:
                    continue
                r = self.link.call("deadline_add", want, timeout=30)
                entry = self.state["tasks"].setdefault(tid, {})
                if r["ok"] and "action" not in (r["result"] or {}):
                    # an older Kafka ignored the key and made a plain deadline: undo it and stop until Kafka is updated
                    did = ((r["result"] or {}).get("deadline") or {}).get("id")
                    if did:
                        self.link.call("deadline_delete", {"deadline": did, "confirm": True}, timeout=30)
                    entry.update(ok=False, reason="kafka_outdated", error=REASON_TEXT["kafka_outdated"], ts=self.clock())
                    outdated = True
                    failed += 1
                    continue
                if r["ok"]:
                    deadline = (r["result"] or {}).get("deadline") or {}
                    entry.update(ok=True, digest=digest, deadline_id=deadline.get("id"), date=want["date"], state=deadline.get("state"),
                                 action=(r["result"] or {}).get("action"), error="", reason="", ts=self.clock(), closed=False)
                    if deadline.get("id"):
                        self.store.set_silently("maintenance_tasks", tid, kafka_deadline_id=deadline["id"])
                    sent += 1
                else:
                    entry.update(ok=False, error=r["message"], reason=r.get("reason"), ts=self.clock())
                    failed += 1
            for tid in [t for t in self.state["tasks"] if t not in tasks]:
                self.state["tasks"].pop(tid, None)
            self.state.update(last_run=self.clock(), enabled=enabled)
            self._due_events(tasks)
            self._daily_due_event(tasks)
            _save_json(self.paths.mirror, self.state)
            return {"sent": sent, "closed": closed, "failed": failed, "enabled": enabled}

    def _daily_due_event(self, tasks: dict[str, dict[str, Any]]) -> None:
        today = self.today()
        if self.state.get("due_event_day") == today.isoformat():
            return
        horizon = (today + timedelta(days=7)).isoformat()
        due = [{"id": t["id"], "title": t.get("title"), "next_due": t.get("next_due")} for t in tasks.values()
               if t.get("deleted_at") is None and not t.get("paused") and t.get("next_due") and t["next_due"] <= horizon]
        if due:   # the day counts once something was announced; a task added later that day is still announced
            due.sort(key=lambda x: x["next_due"])
            self.emit("homehoard.maintenance.upcoming", {"count": len(due), "tasks": due[:20]})
            self.state["due_event_day"] = today.isoformat()

    def _due_events(self, tasks: dict[str, dict[str, Any]]) -> None:
        """``homehoard.maintenance.due {task_id, title, due, url, item_id}`` once for each task when it becomes due (its day is today, or
        up to ``DUE_GRACE_DAYS`` ago); a task whose date moves is announced again for the new date."""
        today = self.today()
        sent: dict[str, str] = self.state.setdefault("due_sent", {})
        for tid, task in tasks.items():
            day = MT.parse_day(task.get("next_due"))
            if task.get("deleted_at") is not None or task.get("paused") or day is None:
                continue
            late = (today - day).days
            if not 0 <= late <= DUE_GRACE_DAYS or sent.get(tid) == day.isoformat():
                continue
            name = target_name(self.store, task)
            title = (task.get("title") or "tarea") + (f" ({name})" if name else "")
            self.emit("homehoard.maintenance.due", {"task_id": tid, "title": title, "due": day.isoformat(),
                                                    "url": f"{self.app_url}/maintenance?task={tid}" if self.app_url else "",
                                                    "item_id": task.get("target_id") if task.get("target_kind") == "item" else ""})
            sent[tid] = day.isoformat()
        for tid in [t for t in sent if t not in tasks]:
            sent.pop(tid, None)

    # ---------------------------------------------------------------- status
    def status(self) -> dict[str, Any]:
        with self.lock:
            tasks = self.state.get("tasks", {})
            return {"enabled": bool(self.settings().get("kafka_mirror", True)), "last_run": self.state.get("last_run"),
                    "pending": sum(1 for e in tasks.values() if not e.get("ok")), "mirrored": sum(1 for e in tasks.values() if e.get("ok") and not e.get("closed")),
                    "tasks": {k: {f: e.get(f) for f in ("ok", "deadline_id", "date", "state", "action", "error", "reason", "ts", "closed")}
                              for k, e in tasks.items()},
                    "last_error": self.state.get("last_error")}
