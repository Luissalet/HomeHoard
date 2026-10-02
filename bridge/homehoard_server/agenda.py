"""The family agenda: the maintenance tasks of the home, answered to the hub as ``GET /api/family/agenda``.

Items are ``kind: maintenance`` with the day the task is due (``next_due``). Paused and deleted tasks are not listed. A task that is
overdue is listed whatever the start of the window is (it is still waiting), with high priority; a task with a legal basis is high priority
too. Only tasks HomeHoard really holds are listed, with their norm or the word «Recomendación» in the detail."""
from __future__ import annotations

from datetime import date
from typing import Any, Callable, Optional

from . import maintenance as MT
from . import tools as T


def build_items(ctx: T.Ctx, date_from: date, date_to: date) -> list[dict[str, Any]]:
    p = T._paths(ctx)
    today = ctx.today()
    items: list[dict[str, Any]] = []
    for task in ctx.store.alive("maintenance_tasks"):
        day = MT.parse_day(task.get("next_due"))
        if task.get("paused") or day is None or day > date_to:
            continue
        overdue = day < today
        if day < date_from and not overdue:
            continue
        out = T._task_out(ctx, task, p)
        name = str(out["target"].get("name") or "")
        title = str(task.get("title") or "").strip()
        if not title:
            continue
        law = (task.get("basis") or "advice") == "law"
        rule = (out.get("legal_ref") if law else "") or out["basis_label"]
        items.append({"id": f"homehoard:maintenance:{task['id']}", "title": title + (f" ({name})" if name and MT.fold(name) not in MT.fold(title) else ""),
                      "start": day.isoformat(), "all_day": True, "kind": "maintenance", "priority": "high" if (overdue or law) else "normal",
                      "url": f"{ctx.app_url.rstrip('/')}/maintenance?task={task['id']}" if ctx.app_url else "",
                      "detail": f"{out['basis_label']}: {rule}"[:240] if law else f"{out['basis_label']} · {out['interval']}"[:240]})
    items.sort(key=lambda i: (i["start"], i["title"]))
    return items


def make_provider(get_ctx: Callable[[], Optional[T.Ctx]]) -> Callable[[date, date, str], list[dict[str, Any]]]:
    """``provider(date_from, date_to, sphere)`` for ``fam_agenda.answer``; ``sphere`` is ignored (HomeHoard has no spheres)."""
    def provider(date_from: date, date_to: date, sphere: str) -> list[dict[str, Any]]:
        ctx = get_ctx()
        return build_items(ctx, date_from, date_to) if ctx is not None else []
    return provider
