"""Maintenance: the template catalogue (shared with the app), the next due date and the overdue / this month / upcoming
groups. Pure functions over plain dicts; ``today`` is always passed in. The same rules live in
``src/features/maintenance.ts``; ``tests/maintenance-cases.json`` keeps both in step."""
from __future__ import annotations

import calendar
import json
import re
import unicodedata
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any, Optional

from .config import ROOT

TEMPLATES_FILE = ROOT / "shared" / "maintenance-templates.json"
BASIS = ("law", "maker", "advice")
TARGET_KINDS = ("item", "container", "room", "home")
BASIS_LABEL = {"law": "Obligación legal", "maker": "Fabricante", "advice": "Recomendación"}


def fold(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


@lru_cache(maxsize=1)
def catalogue() -> dict[str, Any]:
    return json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))


def templates() -> list[dict[str, Any]]:
    return list(catalogue()["templates"])


def template(template_id: str) -> Optional[dict[str, Any]]:
    return next((t for t in templates() if t["id"] == template_id), None)


def template_source(t: dict[str, Any]) -> str:
    """What the UI and the tools show as the source of a template."""
    if t.get("basis") == "law":
        return t.get("legal_ref") or ""
    return catalogue().get("advice_source", "")


# ------------------------------------------------------------------ dates
def day_of(ms: Optional[float]) -> Optional[date]:
    if ms is None:
        return None
    return datetime.fromtimestamp(float(ms) / 1000).date()


def parse_day(value: Any) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def add_months(day: date, months: int) -> date:
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _step(base: date, task: dict[str, Any]) -> date:
    if task.get("every_days"):
        return base + timedelta(days=int(task["every_days"]))
    return add_months(base, int(task.get("every_months") or 12))


def compute_next_due(task: dict[str, Any]) -> Optional[str]:
    """Next due day (YYYY-MM-DD). A manual date wins; otherwise the last time it was done plus the interval, moved to the
    nearest occurrence of the anchor month when there is one. Never done: from the day it was created."""
    if task.get("next_due_manual") and parse_day(task.get("next_due")):
        return parse_day(task.get("next_due")).isoformat()
    last = day_of(task.get("last_done_at"))
    created = day_of(task.get("created_at")) or date.today()
    anchor = task.get("anchor_month")
    if anchor:
        anchor = int(anchor)
        if last is None:
            if created.month == anchor:
                return created.isoformat()
            return date(created.year if created.month < anchor else created.year + 1, anchor, 1).isoformat()
        target = _step(last, task)
        options = [date(y, anchor, 1) for y in (target.year - 1, target.year, target.year + 1)]
        options = [d for d in options if d > last]
        best = min(options, key=lambda d: (abs((d - target).days), d))
        return best.isoformat()
    if last is None:
        return created.isoformat()
    return _step(last, task).isoformat()


def group_of(next_due: Optional[str], today: date) -> str:
    """overdue | month (due by the end of this month) | upcoming | none."""
    day = parse_day(next_due)
    if day is None:
        return "none"
    if day < today:
        return "overdue"
    end = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    return "month" if day <= end else "upcoming"


def interval_text(task: dict[str, Any]) -> str:
    if task.get("every_days"):
        n = int(task["every_days"])
        return "cada día" if n == 1 else f"cada {n} días"
    n = int(task.get("every_months") or 12)
    text = "cada mes" if n == 1 else "cada año" if n == 12 else f"cada {n // 12} años" if n % 12 == 0 else f"cada {n} meses"
    if task.get("anchor_month"):
        text += f", en {MONTHS[int(task['anchor_month']) - 1]}"
    return text


MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


# ------------------------------------------------------------------ suggestions
def _words(text: str) -> str:
    return " " + re.sub(r"[^a-z0-9]+", " ", fold(text)) + " "


def suggest(name: str, kind: str = "", target_kind: str = "item", room_kind: str = "") -> list[dict[str, Any]]:
    """Templates whose words appear in the name or kind of a thing; for a room, also those for its kind."""
    hay = _words(f"{name} {kind}")
    out = []
    for t in templates():
        if target_kind not in t.get("target_kinds", []):
            continue
        hit = any(_words(m).strip() and _words(m) in hay for m in t.get("match", []))
        if not hit and target_kind == "room" and room_kind and room_kind in t.get("room_kinds", []):
            hit = True
        if hit:
            out.append(t)
    return out
