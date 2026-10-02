"""The agent tools. One catalogue serves ``/api/agent/*`` (Bearer token), ``/api/ui/call`` (the local app) and the stdio
MCP bridge. Writes go through the same merge as the app and return the new state."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable, Optional

import inventory

from . import maintenance as MT
from .bundle import link_id
from .kafka import KafkaLink, KafkaMirror

INSTRUCTIONS = """HomeHoard keeps the user's home on this computer: homes, floors, rooms, furniture (containers nested inside each other), objects with tags, an appliance card per object (brand, model, serial, purchase, warranty, spare parts, linked papers in Kafka's Hoard) and maintenance tasks with their legal basis or advice.
To answer «¿dónde está…?» use home_find_item; «¿qué hay en…?» home_list_location. Quote locations only from tool results; if an object is not found, say so. Write tools (home_add_item, home_update_item, home_move_item, home_item_details with set, maintenance_*) only when the user asks; deletes need confirm=true.
Maintenance: maintenance_list (overdue, this month, upcoming), maintenance_done, maintenance_add (from maintenance_templates or custom). Legal tasks carry their norm (RITE, RD 919/2006); the rest are advice and must be presented as such. Papers, warranties and manuals live in Kafka's Hoard: home_item_papers and home_manual_search reach it through the hub and say when it is not available."""


class ToolError(Exception):
    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.message, "code": self.code, **({"hint": self.hint} if self.hint else {})}


@dataclass
class Ctx:
    store: Any
    kafka: KafkaLink
    mirror: Optional[KafkaMirror]
    clock: Callable[[], float]
    emit: Callable[..., Any]

    def today(self) -> date:
        return datetime.fromtimestamp(self.clock()).date()

    def now_ms(self) -> int:
        return int(self.clock() * 1000)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    schema: dict[str, Any]
    read_only: bool
    run: Callable[[Ctx, dict[str, Any]], dict[str, Any]]
    destructive: bool = False


def _d(first: str, detail: str = "", synonyms: str = "") -> str:
    assert len(first) <= 110, first
    return "\n".join(x for x in (first, detail, ("Sinónimos: " + synonyms) if synonyms else "") if x)


def _obj(props: dict[str, Any], required: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


S = lambda desc, **kw: {"type": "string", "description": desc, **kw}  # noqa: E731
I = lambda desc, **kw: {"type": "integer", "description": desc, **kw}  # noqa: E731
N = lambda desc, **kw: {"type": ["number", "null"], "description": desc, **kw}  # noqa: E731
B = lambda desc: {"type": "boolean", "description": desc}  # noqa: E731
DATE = "YYYY-MM-DD"


# ====================================================================== helpers
def _arg(args: dict[str, Any], name: str, kind: type | tuple, default: Any = None, *, required: bool = False) -> Any:
    value = args.get(name, default)
    if value is None:
        if required:
            raise ToolError("invalid", f"Falta {name}.")
        return default
    if kind is int and isinstance(value, bool):
        raise ToolError("invalid", f"{name} debe ser un número entero.")
    if kind is float and isinstance(value, int) and not isinstance(value, bool):
        value = float(value)
    if not isinstance(value, kind):
        raise ToolError("invalid", f"{name} tiene un tipo no válido.")
    if isinstance(value, str):
        value = value.strip()
        if required and not value:
            raise ToolError("invalid", f"Falta {name}.")
    return value


def _day_arg(args: dict[str, Any], name: str) -> Optional[str]:
    value = args.get(name)
    if value in (None, ""):
        return None
    day = MT.parse_day(value)
    if day is None or len(str(value).strip()) != 10:
        raise ToolError("invalid", f"{name} debe ser una fecha {DATE}.")
    return day.isoformat()


def _paths(ctx: Ctx) -> dict[str, Any]:
    t = ctx.store.tables()
    alive = lambda name: {r["id"]: r for r in t[name] if r.get("deleted_at") is None}  # noqa: E731
    return {"homes": alive("homes"), "floors": alive("floors"), "rooms": alive("rooms"), "containers": alive("containers"),
            "items": alive("items"), "tags": alive("tags"), "links": [r for r in t["itemTags"] if r.get("deleted_at") is None], "all": t}


def _room_path(p: dict[str, Any], room: Optional[dict[str, Any]]) -> str:
    if not room:
        return ""
    floor = p["floors"].get(room.get("floor_id"))
    home = p["homes"].get(floor.get("home_id")) if floor else None
    return " › ".join(r["name"] for r in (home, floor, room) if r)


def _item_path(p: dict[str, Any], item: dict[str, Any]) -> str:
    parts = [_room_path(p, p["rooms"].get(item.get("room_id")))]
    chain, cid, seen = [], item.get("container_id"), set()
    while cid and cid not in seen:
        seen.add(cid)
        c = p["containers"].get(cid)
        if not c:
            break
        chain.insert(0, c["name"])
        cid = c.get("parent_container_id")
    return " › ".join(x for x in parts + chain if x)


def _item_tags(p: dict[str, Any], item_id: str) -> list[str]:
    return sorted(p["tags"][l["tag_id"]]["name"] for l in p["links"] if l["item_id"] == item_id and l["tag_id"] in p["tags"])


def _item_out(ctx: Ctx, item: dict[str, Any], p: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    p = p or _paths(ctx)
    return {"id": item["id"], "name": item.get("name"), "quantity": item.get("quantity", 1), "location": _item_path(p, item),
            "room_id": item.get("room_id"), "container_id": item.get("container_id"), "tags": _item_tags(p, item["id"]),
            "favorite": bool(item.get("favorite")), "note": item.get("description") or None, "updated_at": item.get("updated_at")}


def _resolve_item(ctx: Ctx, ref: str) -> dict[str, Any]:
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("invalid", "Indica el objeto (nombre o id).")
    item = ctx.store.get("items", ref)
    if item and item.get("deleted_at") is None:
        return item
    found = inventory.find(ref, 10)
    matches = found.get("matches") or []
    exact = [m for m in matches if MT.fold(m["name"]) == MT.fold(ref)]
    pick = exact if len(exact) == 1 else matches if len(matches) == 1 else []
    if len(pick) == 1:
        return ctx.store.get("items", pick[0]["id"])
    if not matches:
        # a whole question («¿está en garantía la lavadora?»): the object whose name matches most of its words
        votes: dict[str, int] = {}
        names: dict[str, dict[str, Any]] = {}
        for word in inventory.terms(ref):
            if len(word) < 3:
                continue
            for m in inventory.find(word, 20).get("matches") or []:
                if word in MT.fold(m["name"]):
                    votes[m["id"]] = votes.get(m["id"], 0) + 1
                    names[m["id"]] = m
        if votes:
            top = max(votes.values())
            best = [i for i, v in votes.items() if v == top]
            if len(best) == 1:
                return ctx.store.get("items", best[0])
            matches = [names[i] for i in best]
    if not matches:
        raise ToolError("not_found", f"No hay ningún objeto «{ref}» en HomeHoard.", "Busca con home_find_item o comprueba el nombre.")
    raise ToolError("ambiguous", f"Hay varios objetos que encajan con «{ref}».",
                    "Repite con el id: " + "; ".join(f"{m['id']} = {m['name']} ({m['location']})" for m in matches[:8]))


def _resolve_location(ctx: Ctx, ref: str) -> dict[str, Any]:
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("invalid", "Indica la ubicación (habitación, mueble o caja; nombre, ruta o id).")
    result = inventory.list_location(ref, 0, 1)
    if result["status"] == "found":
        return result["location"]
    if result["status"] == "ambiguous":
        raise ToolError("ambiguous", f"Hay varias ubicaciones llamadas «{ref}».",
                        "Repite con la ruta o el id: " + "; ".join(f"{l['id']} = {l['path']}" for l in result["locations"][:8]))
    raise ToolError("not_found", f"No hay ninguna habitación, mueble o caja «{ref}».", "Mira la estructura con home_list_location.")


def _resolve_target(ctx: Ctx, kind: str, ref: str) -> tuple[str, dict[str, Any]]:
    if kind == "item":
        return "item", _resolve_item(ctx, ref)
    if kind == "home":
        homes = ctx.store.alive("homes")
        row = next((h for h in homes if h["id"] == ref or MT.fold(h["name"]) == MT.fold(ref)), None) if ref else (homes[0] if len(homes) == 1 else None)
        if not row:
            raise ToolError("not_found", "No encuentro esa vivienda.", "Viviendas: " + ", ".join(h["name"] for h in homes))
        return "home", row
    loc = _resolve_location(ctx, ref)
    if kind == "room" and loc["kind"] != "room":
        raise ToolError("invalid", f"«{loc['path']}» es un mueble, no una habitación.")
    table = "rooms" if loc["kind"] == "room" else "containers"
    return loc["kind"], ctx.store.get(table, loc["id"])


def _household(ctx: Ctx) -> str:
    rows = sorted(ctx.store.alive("households"), key=lambda r: r.get("created_at") or 0)
    if rows:
        return rows[0]["id"]
    return ctx.store.put("households", {"id": str(uuid.uuid4()), "name": "Mi casa", "created_at": ctx.now_ms()})["id"]


def _set_tags(ctx: Ctx, item_id: str, names: list[str]) -> None:
    p = _paths(ctx)
    by_name = {MT.fold(t["name"]): t for t in p["tags"].values()}
    wanted: set[str] = set()
    for name in names:
        name = str(name).strip()[:60]
        if not name:
            continue
        tag = by_name.get(MT.fold(name))
        if tag is None:
            tag = ctx.store.put("tags", {"id": str(uuid.uuid4()), "household_id": _household(ctx), "name": name, "color": None})
            by_name[MT.fold(name)] = tag
        wanted.add(tag["id"])
    existing = {l["tag_id"]: l for l in ctx.store.tables()["itemTags"] if l["item_id"] == item_id}
    for tag_id in wanted:
        link = existing.get(tag_id)
        if link is None or link.get("deleted_at") is not None:
            ctx.store.put("itemTags", {"id": link_id(item_id, tag_id), "item_id": item_id, "tag_id": tag_id, "deleted_at": None})
    for tag_id, link in existing.items():
        if tag_id not in wanted and link.get("deleted_at") is None:
            ctx.store.put("itemTags", {**link, "deleted_at": ctx.now_ms()})


def _place(loc: dict[str, Any]) -> dict[str, Any]:
    return {"room_id": loc["room_id"], "container_id": loc["id"] if loc["kind"] == "container" else None}


# ====================================================================== inventory
def t_find(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    limit = _arg(a, "limit", int, 5)
    return inventory.find(_arg(a, "query", str, required=True), max(1, min(limit, 20)))


def t_status(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    s = inventory.status()
    tasks = [t for t in ctx.store.alive("maintenance_tasks")]
    today = ctx.today()
    groups = [MT.group_of(t.get("next_due"), today) for t in tasks]
    return {**s, "maintenance": {"tasks": len(tasks), "overdue": groups.count("overdue"), "this_month": groups.count("month")},
            "kafka_mirror": ctx.mirror.status() if ctx.mirror else None}


def t_list_location(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    try:
        return inventory.list_location(_arg(a, "location", str, ""), _arg(a, "offset", int, 0), _arg(a, "limit", int, 50))
    except ValueError as exc:
        raise ToolError("invalid", str(exc)) from exc


def t_add_item(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    name = _arg(a, "name", str, required=True)[:160]
    loc = _resolve_location(ctx, _arg(a, "location", str, required=True))
    qty = _arg(a, "quantity", int, 1)
    if qty < 0:
        raise ToolError("invalid", "La cantidad no puede ser negativa.")
    rec = {"id": str(uuid.uuid4()), "household_id": _household(ctx), "name": name, "description": _arg(a, "note", str, None) or None,
           "quantity": qty, **_place(loc), "photo_uri": None, "favorite": 1 if _arg(a, "favorite", bool, False) else 0, "created_at": ctx.now_ms()}
    item = ctx.store.put("items", rec)
    if a.get("tags"):
        _set_tags(ctx, item["id"], list(_arg(a, "tags", list, [])))
    ctx.emit("homehoard.item.added", {"id": item["id"], "title": name})
    return {"status": "added", "item": _item_out(ctx, ctx.store.get("items", item["id"]))}


def t_update_item(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    item = _resolve_item(ctx, _arg(a, "item", str, required=True))
    patch: dict[str, Any] = {}
    if a.get("name") is not None:
        patch["name"] = _arg(a, "name", str, required=True)[:160]
    if a.get("quantity") is not None:
        qty = _arg(a, "quantity", int)
        if qty < 0:
            raise ToolError("invalid", "La cantidad no puede ser negativa.")
        patch["quantity"] = qty
    if "note" in a:
        patch["description"] = (_arg(a, "note", str, "") or None)
    if a.get("favorite") is not None:
        patch["favorite"] = 1 if _arg(a, "favorite", bool) else 0
    if a.get("location"):
        patch.update(_place(_resolve_location(ctx, _arg(a, "location", str))))
    if patch:
        ctx.store.put("items", {**item, **patch})
    if a.get("tags") is not None:
        _set_tags(ctx, item["id"], list(_arg(a, "tags", list, [])))
    if not patch and a.get("tags") is None:
        raise ToolError("invalid", "No hay nada que cambiar.", "Pasa name, quantity, note, location, tags o favorite.")
    return {"status": "updated", "item": _item_out(ctx, ctx.store.get("items", item["id"]))}


def t_move_item(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    item = _resolve_item(ctx, _arg(a, "item", str, required=True))
    before = _item_out(ctx, item)["location"]
    loc = _resolve_location(ctx, _arg(a, "location", str, required=True))
    ctx.store.put("items", {**item, **_place(loc)})
    out = _item_out(ctx, ctx.store.get("items", item["id"]))
    return {"status": "moved", "from": before, "item": out}


# ====================================================================== appliance card
DETAIL_TEXT = ("brand", "model", "serial", "store", "manual_url", "notes")
DETAIL_FIELDS = DETAIL_TEXT + ("purchase_date", "price", "warranty_until", "warranty_source", "kafka_doc_ids", "consumables")


def details_of(ctx: Ctx, item_id: str) -> dict[str, Any]:
    row = ctx.store.get("item_details", item_id)
    if not row or row.get("deleted_at") is not None:
        return {"item_id": item_id, "exists": False, "kafka_doc_ids": [], "consumables": []}
    return {**{k: row.get(k) for k in DETAIL_FIELDS}, "item_id": item_id, "exists": True, "updated_at": row.get("updated_at"),
            "kafka_doc_ids": list(row.get("kafka_doc_ids") or []), "consumables": list(row.get("consumables") or [])}


def warranty_of(ctx: Ctx, details: dict[str, Any]) -> Optional[dict[str, Any]]:
    day = MT.parse_day(details.get("warranty_until"))
    if day is None:
        return None
    left = (day - ctx.today()).days
    return {"until": day.isoformat(), "active": left >= 0, "days_left": left, "source": details.get("warranty_source") or "manual"}


def _clean_consumables(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ToolError("invalid", "consumables debe ser una lista.")
    out = []
    for c in value[:50]:
        if not isinstance(c, dict) or not str(c.get("name") or "").strip():
            raise ToolError("invalid", "Cada consumible necesita name.")
        qty = c.get("qty")
        out.append({"name": str(c["name"]).strip()[:120], "spec": str(c.get("spec") or "").strip()[:160] or None,
                    "qty": int(qty) if isinstance(qty, (int, float)) and not isinstance(qty, bool) else None,
                    "last_bought": MT.parse_day(c.get("last_bought")).isoformat() if MT.parse_day(c.get("last_bought")) else None})
    return out


def save_details(ctx: Ctx, item_id: str, values: dict[str, Any]) -> dict[str, Any]:
    current = ctx.store.get("item_details", item_id) or {"id": item_id, "item_id": item_id, "created_at": ctx.now_ms()}
    rec = {**current, "deleted_at": None}
    for key, value in values.items():
        if key not in DETAIL_FIELDS:
            raise ToolError("invalid", f"Campo desconocido en la ficha: {key}.", "Campos: " + ", ".join(DETAIL_FIELDS))
        if key in DETAIL_TEXT:
            rec[key] = (str(value).strip()[:500] if value not in (None, "") else None)
        elif key in ("purchase_date", "warranty_until"):
            rec[key] = _day_arg({key: value}, key)
        elif key == "price":
            if value in (None, ""):
                rec[key] = None
            elif isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                rec[key] = float(value)
            else:
                raise ToolError("invalid", "price debe ser un número positivo.")
        elif key == "warranty_source":
            if value not in (None, "manual", "kafka"):
                raise ToolError("invalid", "warranty_source es manual o kafka.")
            rec[key] = value
        elif key == "kafka_doc_ids":
            if not isinstance(value, list):
                raise ToolError("invalid", "kafka_doc_ids debe ser una lista de ids d_….")
            rec[key] = list(dict.fromkeys(str(v).strip() for v in value if str(v).strip()))[:50]
        elif key == "consumables":
            rec[key] = _clean_consumables(value)
    if "warranty_until" in values and "warranty_source" not in values:
        rec["warranty_source"] = "manual" if rec.get("warranty_until") else None
    ctx.store.put("item_details", rec)
    return details_of(ctx, item_id)


def t_item_details(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    item = _resolve_item(ctx, _arg(a, "item", str, required=True))
    values = a.get("set")
    if values is not None:
        if not isinstance(values, dict) or not values:
            raise ToolError("invalid", "set debe ser un objeto con los campos de la ficha.")
        details = save_details(ctx, item["id"], values)
        status = "saved"
    else:
        details, status = details_of(ctx, item["id"]), "found"
    return {"status": status, "item": _item_out(ctx, item), "details": details, "warranty": warranty_of(ctx, details)}


# ====================================================================== papers and manuals (Kafka)
def papers_of(ctx: Ctx, item: dict[str, Any]) -> dict[str, Any]:
    details = details_of(ctx, item["id"])
    ids = details["kafka_doc_ids"]
    out: dict[str, Any] = {"item": _item_out(ctx, item), "doc_ids": ids, "documents": [], "warranty": warranty_of(ctx, details),
                           "kafka": {"ok": True}}
    if ids:
        r = ctx.kafka.call("docs_list", {"doc_ids": ids, "limit": 100})
        if r["ok"]:
            docs = r["result"].get("documents") or []
            out["documents"] = [{k: d.get(k) for k in ("id", "title", "kind", "kind_label", "issuer", "issue_date", "item", "state", "next_deadline")}
                                for d in docs]
            out["missing"] = r["result"].get("missing") or []
        else:
            out["kafka"] = {"ok": False, "reason": r["reason"], "message": r["message"]}
    # Kafka's warranty deadlines: by brand and model, by model, then by the object's name; linked papers first
    needles = list(dict.fromkeys(x.strip()[:120] for x in (" ".join(y for y in (details.get("brand"), details.get("model")) if y),
                                                           details.get("model") or "", item.get("name") or "") if x and x.strip()))
    rows: list[dict[str, Any]] = []
    for needle in needles if out["kafka"]["ok"] else []:
        w = ctx.kafka.call("warranty_check", {"text": needle, "include_expired": True})
        if not w["ok"]:
            out["kafka"] = {"ok": False, "reason": w["reason"], "message": w["message"]}
            break
        rows = w["result"].get("warranties") or []
        if rows:
            break
    if rows:
        linked = [x for x in rows if (x.get("document") or {}).get("id") in ids]
        b = (linked or rows)[0]
        out["kafka_warranty"] = {"until": b.get("ends"), "active": b.get("active"), "days_left": b.get("days_left"),
                                 "basis": b.get("basis"), "cite": b.get("cite"), "document": b.get("document"), "linked": bool(linked)}
    if out["warranty"] is None and out.get("kafka_warranty") and out["kafka_warranty"].get("until"):
        kw = out["kafka_warranty"]
        out["warranty"] = {"until": kw["until"], "active": kw["active"], "days_left": kw["days_left"], "source": "kafka"}
    return out


def t_item_papers(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    return papers_of(ctx, _resolve_item(ctx, _arg(a, "item", str, required=True)))


def t_manual_search(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    item = _resolve_item(ctx, _arg(a, "item", str, required=True))
    query = _arg(a, "query", str, required=True)
    if len(query) < 2:
        raise ToolError("invalid", "La búsqueda necesita al menos 2 letras.")
    ids = details_of(ctx, item["id"])["kafka_doc_ids"]
    if not ids:
        return {"status": "no_papers", "item": _item_out(ctx, item), "results": [],
                "message": "Este objeto no tiene papeles vinculados en Kafka. Vincula o sube su manual desde la ficha."}
    listed = ctx.kafka.call("docs_list", {"doc_ids": ids, "limit": 100})
    if not listed["ok"]:
        return {"status": "kafka_unavailable", "reason": listed["reason"], "message": listed["message"], "results": []}
    manuals = [d["id"] for d in listed["result"].get("documents") or [] if d.get("kind") == "manual"]
    scope = manuals or ids
    r = ctx.kafka.call("doc_search", {"query": query[:200], "doc_ids": scope, "limit": _arg(a, "limit", int, 8)})
    if not r["ok"]:
        return {"status": "kafka_unavailable", "reason": r["reason"], "message": r["message"], "results": []}
    results = r["result"].get("results") or []
    return {"status": "found" if results else "not_found", "item": _item_out(ctx, item), "searched": "manuals" if manuals else "all_papers",
            "documents": len(scope), "results": results,
            "message": None if results else "Los papeles vinculados no mencionan eso." if manuals else
            "No hay ningún manual vinculado; se ha buscado en el resto de papeles y no aparece."}


# ====================================================================== maintenance
def _task_out(ctx: Ctx, task: dict[str, Any], p: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    p = p or _paths(ctx)
    kind = task.get("target_kind")
    table = {"item": "items", "container": "containers", "room": "rooms", "home": "homes"}.get(kind or "", "")
    target = p.get(table, {}).get(task.get("target_id")) if table else None
    if target and kind == "item":
        where = _item_path(p, target)
    elif target and kind == "container":
        where = _item_path(p, {"room_id": target.get("room_id"), "container_id": target["id"]})
    elif target and kind == "room":
        where = _room_path(p, target)
    else:
        where = (target or {}).get("name")
    tpl = MT.template(task.get("template_id") or "")
    mirror = (ctx.mirror.status()["tasks"].get(task["id"]) if ctx.mirror else None) or {}
    return {"id": task["id"], "title": task.get("title"), "target": {"kind": kind, "id": task.get("target_id"), "name": (target or {}).get("name"),
                                                                       "path": where, "exists": target is not None},
            "interval": MT.interval_text(task), "every_days": task.get("every_days"), "every_months": task.get("every_months"),
            "anchor_month": task.get("anchor_month"), "next_due": task.get("next_due"), "next_due_manual": bool(task.get("next_due_manual")),
            "group": MT.group_of(task.get("next_due"), ctx.today()), "last_done_at": task.get("last_done_at"),
            "last_done": MT.day_of(task.get("last_done_at")).isoformat() if task.get("last_done_at") else None,
            "basis": task.get("basis") or "advice", "basis_label": MT.BASIS_LABEL.get(task.get("basis") or "advice"),
            "legal_ref": task.get("legal_ref") or (tpl or {}).get("legal_ref"), "notes": task.get("notes"), "template_id": task.get("template_id"),
            "paused": bool(task.get("paused")),
            "kafka": {"deadline_id": mirror.get("deadline_id") or task.get("kafka_deadline_id"), "ok": mirror.get("ok"), "error": mirror.get("error") or None}}


def _resolve_task(ctx: Ctx, ref: str) -> dict[str, Any]:
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("invalid", "Indica la tarea (id o título).")
    task = ctx.store.get("maintenance_tasks", ref)
    if task and task.get("deleted_at") is None:
        return task
    tasks = ctx.store.alive("maintenance_tasks")
    p = _paths(ctx)
    words = [w for w in MT.fold(ref).split() if len(w) > 2]
    def hay(t: dict[str, Any]) -> str:
        out = _task_out(ctx, t, p)
        return MT.fold(f"{t.get('title')} {out['target']['name'] or ''} {out['target']['path'] or ''}")
    hits = [t for t in tasks if words and all(w in hay(t) for w in words)]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise ToolError("not_found", f"No hay ninguna tarea de mantenimiento «{ref}».", "Lista las tareas con maintenance_list.")
    raise ToolError("ambiguous", f"Varias tareas encajan con «{ref}».", "Repite con el id: " + "; ".join(f"{t['id']} = {t.get('title')}" for t in hits[:8]))


def t_maint_list(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    which = _arg(a, "filter", str, "all")
    if which not in ("all", "overdue", "month", "due", "upcoming"):
        raise ToolError("invalid", "filter: all, overdue, month, due o upcoming.")
    days = _arg(a, "days", int, 30)
    target = _arg(a, "target", str, "")
    p = _paths(ctx)
    tasks = [_task_out(ctx, t, p) for t in ctx.store.alive("maintenance_tasks")]
    if target:
        needle = MT.fold(target)
        tasks = [t for t in tasks if t["target"]["id"] == target or needle in MT.fold(f"{t['target']['name'] or ''} {t['target']['path'] or ''} {t['title']}")]
    today = ctx.today()
    if which == "overdue":
        tasks = [t for t in tasks if t["group"] == "overdue"]
    elif which == "month":
        tasks = [t for t in tasks if t["group"] in ("overdue", "month")]
    elif which == "due":
        tasks = [t for t in tasks if t["next_due"] and (MT.parse_day(t["next_due"]) - today).days <= days]
    elif which == "upcoming":
        tasks = [t for t in tasks if t["group"] in ("month", "upcoming")]
    tasks.sort(key=lambda t: (t["next_due"] or "9999", t["title"] or ""))
    counts = {g: sum(1 for t in tasks if t["group"] == g) for g in ("overdue", "month", "upcoming")}
    return {"today": today.isoformat(), "filter": which, "count": len(tasks), "groups": counts, "tasks": tasks,
            "note": "Las tareas con basis law citan su norma; las demás son recomendaciones, no obligaciones."}


def _interval(a: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if a.get("every_days") is not None:
        d = _arg(a, "every_days", int)
        if not 1 <= d <= 3650:
            raise ToolError("invalid", "every_days entre 1 y 3650.")
        out.update(every_days=d, every_months=None)
    if a.get("every_months") is not None:
        m = _arg(a, "every_months", int)
        if not 1 <= m <= 240:
            raise ToolError("invalid", "every_months entre 1 y 240.")
        out.update(every_months=m, every_days=None)
    if "anchor_month" in a:
        m = a.get("anchor_month")
        if m is not None and (isinstance(m, bool) or not isinstance(m, int) or not 1 <= m <= 12):
            raise ToolError("invalid", "anchor_month es un mes de 1 a 12.")
        out["anchor_month"] = m
    if not (out.get("every_days") or out.get("every_months") or base.get("every_days") or base.get("every_months")):
        raise ToolError("invalid", "Indica cada cuánto: every_days o every_months.")
    return out


def _ms_of_day(day: Optional[str]) -> Optional[int]:
    if not day:
        return None
    d = MT.parse_day(day)
    return int(datetime(d.year, d.month, d.day, 12, 0).timestamp() * 1000)


def t_maint_add(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    tpl_id = _arg(a, "template_id", str, "")
    tpl = MT.template(tpl_id) if tpl_id else None
    if tpl_id and tpl is None:
        raise ToolError("not_found", f"No hay ninguna plantilla {tpl_id}.", "Mira maintenance_templates.")
    kind = _arg(a, "target_kind", str, "") or ("item" if tpl is None else tpl["target_kinds"][0])
    if kind not in MT.TARGET_KINDS:
        raise ToolError("invalid", "target_kind: item, container, room o home.")
    kind, target = _resolve_target(ctx, kind, _arg(a, "target", str, ""))
    base = {k: tpl.get(k) for k in ("every_days", "every_months", "anchor_month")} if tpl else {}
    task = {"id": str(uuid.uuid4()), "target_kind": kind, "target_id": target["id"],
            "title": _arg(a, "title", str, "") or (tpl or {}).get("title") or "", "every_days": base.get("every_days"),
            "every_months": base.get("every_months"), "anchor_month": base.get("anchor_month"), "notes": _arg(a, "notes", str, "") or (tpl or {}).get("note"),
            "basis": _arg(a, "basis", str, "") or (tpl or {}).get("basis") or "advice", "legal_ref": _arg(a, "legal_ref", str, "") or (tpl or {}).get("legal_ref"),
            "template_id": tpl_id or None, "last_done_at": _ms_of_day(_day_arg(a, "last_done")), "next_due_manual": 0, "paused": 0,
            "kafka_deadline_id": None, "created_at": ctx.now_ms()}
    task.update(_interval(a, base))
    if not task["title"]:
        raise ToolError("invalid", "Falta el título de la tarea.")
    if task["basis"] not in MT.BASIS:
        raise ToolError("invalid", "basis: law, maker o advice.")
    if task["basis"] == "law" and not task["legal_ref"]:
        raise ToolError("invalid", "Una tarea legal necesita legal_ref con su norma.")
    manual = _day_arg(a, "next_due")
    if manual:
        task.update(next_due=manual, next_due_manual=1)
    task["next_due"] = MT.compute_next_due(task)
    saved = ctx.store.put("maintenance_tasks", task)
    if ctx.mirror:
        ctx.mirror.wake()
    return {"status": "added", "task": _task_out(ctx, saved)}


def t_maint_done(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    task = _resolve_task(ctx, _arg(a, "task", str, required=True))
    day = _day_arg(a, "done_at")
    done_ms = _ms_of_day(day) if day else ctx.now_ms()
    cost = a.get("cost")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, (int, float)) or cost < 0):
        raise ToolError("invalid", "cost debe ser un número positivo.")
    log = ctx.store.put("maintenance_log", {"id": str(uuid.uuid4()), "task_id": task["id"], "done_at": done_ms, "note": _arg(a, "note", str, "") or None,
                                            "cost": float(cost) if cost is not None else None, "who": _arg(a, "who", str, "") or None, "created_at": ctx.now_ms()})
    upd = {**task, "last_done_at": max(done_ms, int(task.get("last_done_at") or 0)), "next_due_manual": 0}
    upd["next_due"] = MT.compute_next_due(upd)
    saved = ctx.store.put("maintenance_tasks", upd)
    if ctx.mirror:
        ctx.mirror.wake()
    return {"status": "done", "task": _task_out(ctx, saved), "log": log}


def t_maint_update(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    task = _resolve_task(ctx, _arg(a, "task", str, required=True))
    upd = dict(task)
    if a.get("title"):
        upd["title"] = _arg(a, "title", str)[:160]
    for key in ("notes", "legal_ref"):
        if key in a:
            upd[key] = _arg(a, key, str, "") or None
    if a.get("basis"):
        if a["basis"] not in MT.BASIS:
            raise ToolError("invalid", "basis: law, maker o advice.")
        upd["basis"] = a["basis"]
    if upd.get("basis") == "law" and not upd.get("legal_ref"):
        raise ToolError("invalid", "Una tarea legal necesita legal_ref con su norma.")
    if a.get("paused") is not None:
        upd["paused"] = 1 if _arg(a, "paused", bool) else 0
    if any(k in a for k in ("every_days", "every_months", "anchor_month")):
        upd.update(_interval(a, task))
    if a.get("last_done"):
        upd["last_done_at"] = _ms_of_day(_day_arg(a, "last_done"))
    if "next_due" in a:
        manual = _day_arg(a, "next_due")
        upd.update(next_due=manual, next_due_manual=1 if manual else 0)
    upd["next_due"] = MT.compute_next_due(upd)
    saved = ctx.store.put("maintenance_tasks", upd)
    if ctx.mirror:
        ctx.mirror.wake()
    return {"status": "updated", "task": _task_out(ctx, saved)}


def t_maint_delete(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    task = _resolve_task(ctx, _arg(a, "task", str, required=True))
    if not _arg(a, "confirm", bool, False):
        raise ToolError("confirm_required", f"Borrar «{task.get('title')}» es definitivo.", "Repite con confirm=true si el usuario lo ha pedido.")
    ctx.store.put("maintenance_tasks", {**task, "deleted_at": ctx.now_ms()})
    if ctx.mirror:
        ctx.mirror.wake()
    return {"status": "deleted", "deleted": task["id"], "title": task.get("title")}


def t_maint_templates(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    rows = MT.templates()
    suggested: list[str] = []
    if a.get("item"):
        item = _resolve_item(ctx, _arg(a, "item", str))
        suggested = [t["id"] for t in MT.suggest(item.get("name") or "", target_kind="item")]
    elif a.get("text"):
        suggested = [t["id"] for kind in ("item", "room", "home") for t in MT.suggest(_arg(a, "text", str), target_kind=kind)]
    out = [{"id": t["id"], "title": t["title"], "basis": t["basis"], "basis_label": MT.BASIS_LABEL[t["basis"]], "interval": MT.interval_text(t),
            "every_months": t.get("every_months"), "anchor_month": t.get("anchor_month"), "target_kinds": t["target_kinds"],
            "source": MT.template_source(t), "rule": t.get("rule"), "note": t.get("note") or t.get("maker_note")} for t in rows]
    if suggested:
        order = {tid: i for i, tid in enumerate(dict.fromkeys(suggested))}
        out.sort(key=lambda t: order.get(t["id"], 99))
    return {"verified": MT.catalogue().get("verified"), "templates": out, "suggested": list(dict.fromkeys(suggested)),
            "note": "Solo las plantillas con basis law son obligaciones legales; el resto son recomendaciones."}


# ====================================================================== catalogue
ITEM = S("Object: its id or its name (a unique match).")
LOCATION = S("Room, piece of furniture or box: id, name or full path (e.g. «Dormitorio › Armario › Cajón rojo»).")
TASK = S("Maintenance task: its id, or words of its title and target (a unique match).")
DETAILS_SET = {"type": "object", "description": "Fields to save (only these change): brand, model, serial, purchase_date (YYYY-MM-DD), store, "
               "price, warranty_until (YYYY-MM-DD), warranty_source (manual|kafka), kafka_doc_ids (list, replaces), manual_url, notes, "
               "consumables (list of {name, spec, qty, last_bought}; replaces).", "additionalProperties": True}

TOOLS: list[Tool] = [
    Tool("home_find_item", _d("Find household objects by name, tag or location and give the full path. ¿Dónde está…? Buscar objeto.",
                              "Accepts Spanish questions and small spelling errors. If there is no match, say so; never invent a location. "
                              "exported_at is the time of the last change to the home on this computer.",
                              "¿dónde está…?, ¿dónde guardé…?, ¿dónde tengo…?, busca, encuentra, material eléctrico"),
         _obj({"query": S("What to look for, e.g. «linterna Philips»."), "limit": I("1–20", minimum=1, maximum=20)}, ("query",)), True, t_find),
    Tool("home_inventory_status", _d("Whether this computer holds the home, item count, last change, maintenance due. Estado del inventario.",
                                     synonyms="cuántos objetos tengo, está al día, estado de HomeHoard"), _obj({}), True, t_status),
    Tool("home_list_location", _d("List everything in a room, piece of furniture or box, nested included. ¿Qué hay en…? Contenido.",
                                  "Use a name, full path or id. If names are ambiguous, ask which one. Paginate with offset and limit; total_items is the full count.",
                                  "¿qué hay en la caja roja?, contenido del trastero, lista lo que hay en"),
         _obj({"location": LOCATION, "offset": I("Start at", minimum=0), "limit": I("1–100", minimum=1, maximum=100)}, ("location",)), True, t_list_location),
    Tool("home_add_item", _d("Add an object to a room or furniture (path, name or id), with quantity and tags. Guardar objeto nuevo.",
                             "Returns the new object with its full path. If the place is ambiguous nothing is written.",
                             "apunta que tengo, guarda en, añade al inventario, he metido en"),
         _obj({"name": S("Object name."), "location": LOCATION, "quantity": I("Units (default 1).", minimum=0), "note": S("Free text."),
               "tags": {"type": "array", "items": {"type": "string"}, "description": "Tag names; new ones are created."}, "favorite": B("Mark as favorite.")},
              ("name", "location")), False, t_add_item),
    Tool("home_update_item", _d("Change an object: name, quantity, note, place, tags, favorite. Editar un objeto del inventario.",
                                "Only the fields given change; tags replace the object's tags. Returns the new state.",
                                "cambia el nombre, ahora tengo 3, quita la etiqueta, marca como favorito"),
         _obj({"item": ITEM, "name": S("New name."), "quantity": I("Units.", minimum=0), "note": S("Free text (empty clears it)."), "location": LOCATION,
               "tags": {"type": "array", "items": {"type": "string"}}, "favorite": B("Favorite or not.")}, ("item",)), False, t_update_item),
    Tool("home_move_item", _d("Move an object to another room, piece of furniture or box. Mover o guardar un objeto en otro sitio.",
                              "Returns where it was and where it is now.",
                              "guarda la linterna en el cajón rojo, mueve, pon en, cambia de sitio, lo he llevado a"),
         _obj({"item": ITEM, "location": LOCATION}, ("item", "location")), False, t_move_item),
    Tool("home_item_details", _d("Get or fill an appliance's card: brand, model, serial, purchase, warranty, parts. Ficha del aparato.",
                                 "Without set it reads the card; with set it saves those fields and returns the card. Warranty dates come from the "
                                 "user or from Kafka (warranty_source).",
                                 "modelo de la lavadora, número de serie, cuándo la compré, qué filtro lleva, pilas del mando, ficha"),
         _obj({"item": ITEM, "set": DETAILS_SET}, ("item",)), False, t_item_details),
    Tool("home_item_papers", _d("Papers linked to an object in Kafka (invoice, warranty, manual) and warranty status. ¿Está en garantía?",
                                "Reads Kafka's Hoard through the hub; says why when it is not available. The warranty comes from the card or from "
                                "Kafka's warranty deadlines, with their basis and citation.",
                                "¿está en garantía la lavadora?, factura del frigorífico, papeles de, hasta cuándo dura la garantía"),
         _obj({"item": ITEM}, ("item",)), True, t_item_papers),
    Tool("home_manual_search", _d("Search inside the manuals linked to an appliance, with page citations. Buscar en el manual.",
                                  "Searches only the object's linked manuals in Kafka (all its papers when none is a manual). Quote only the snippets "
                                  "and cite them as [d_id · p. N].",
                                  "qué significa el error E21, cómo se limpia el filtro, dice el manual, instrucciones de"),
         _obj({"item": ITEM, "query": S("What to look for in the manual."), "limit": I("1–20", minimum=1, maximum=20)}, ("item", "query")), True, t_manual_search),
    Tool("maintenance_list", _d("Maintenance tasks: overdue, due this month, upcoming, per item or room. ¿Cuándo toca…? Mantenimiento.",
                                "filter: all, overdue, month (overdue + rest of this month), due (within days), upcoming. Each task says its basis: "
                                "law (with its norm), maker or advice.",
                                "¿cuándo toca revisar la caldera?, qué mantenimiento tengo pendiente, tareas de la casa, revisiones"),
         _obj({"filter": S("all | overdue | month | due | upcoming"), "days": I("For due: how many days ahead.", minimum=1, maximum=3650),
               "target": S("Only tasks of this object, room or home (name or id).")}), True, t_maint_list),
    Tool("maintenance_add", _d("Add a maintenance task from a template or custom (interval, legal basis). Añadir mantenimiento.",
                               "target_kind item|container|room|home and target (name, path or id). From a template the interval, basis and norm "
                               "come from it. last_done (YYYY-MM-DD) sets the last time; next_due fixes the date by hand.",
                               "recuérdame revisar la caldera, añade mantenimiento, cada 3 meses limpiar, purgar radiadores"),
         _obj({"template_id": S("Template id from maintenance_templates."), "target_kind": S("item | container | room | home"),
               "target": S("Object, furniture, room or home: id, name or path."), "title": S("Title (default: the template's)."),
               "every_days": I("Interval in days.", minimum=1), "every_months": I("Interval in months.", minimum=1),
               "anchor_month": I("Month 1–12 it should fall in (e.g. 10 for October).", minimum=1, maximum=12),
               "last_done": S(DATE), "next_due": S(DATE + " fixed by hand."), "basis": S("law | maker | advice"),
               "legal_ref": S("The norm for a legal task."), "notes": S("Notes.")}), False, t_maint_add),
    Tool("maintenance_done", _d("Mark a maintenance task done (note, cost, who); computes the next date. Marcar mantenimiento hecho.",
                                "Adds a log entry and moves the next date; the Kafka reminder moves with it.",
                                "ya he revisado la caldera, hecho, he limpiado el filtro, apunta que se hizo"),
         _obj({"task": TASK, "done_at": S(DATE + " (default today)."), "note": S("Note."), "cost": N("Cost in euros.", minimum=0),
               "who": S("Who did it (company or person).")}, ("task",)), False, t_maint_done),
    Tool("maintenance_update", _d("Change a maintenance task: title, interval, month, next date, notes, basis, pause. Editar mantenimiento.",
                                  "next_due fixes the date by hand (empty string returns to the computed date).",
                                  "cambia la frecuencia, aplaza, pausa, cada 6 meses, la próxima es el"),
         _obj({"task": TASK, "title": S("Title."), "every_days": I("Days.", minimum=1), "every_months": I("Months.", minimum=1),
               "anchor_month": {"type": ["integer", "null"], "minimum": 1, "maximum": 12, "description": "Month 1–12 or null."},
               "next_due": S(DATE + " or empty."), "last_done": S(DATE), "notes": S("Notes."), "basis": S("law | maker | advice"),
               "legal_ref": S("Norm."), "paused": B("Pause (no reminders).")}, ("task",)), False, t_maint_update),
    Tool("maintenance_delete", _d("Delete a maintenance task (confirm=true); its Kafka reminder is closed. Borrar mantenimiento.",
                                  synonyms="quita la tarea, ya no tengo, elimina el recordatorio"),
         _obj({"task": TASK, "confirm": B("Required.")}, ("task",)), False, t_maint_delete, destructive=True),
    Tool("maintenance_templates", _d("Maintenance templates with legal basis or advice; suggestions for an object. Plantillas de mantenimiento.",
                                     "Legal ones state their norm (RITE IT 3.3, RD 919/2006 ITC-ICG 07); the rest are advice. item or text sorts the "
                                     "suggestions first.",
                                     "qué mantenimiento necesita, cada cuánto se revisa, es obligatorio revisar"),
         _obj({"item": ITEM, "text": S("Words such as «caldera» or «baño».")}), True, t_maint_templates),
]
TOOLS_BY_NAME = {t.name: t for t in TOOLS}
assert len(TOOLS_BY_NAME) == len(TOOLS)


def catalog() -> list[dict[str, Any]]:
    return [{"name": t.name, "description": t.description, "inputSchema": t.schema,
             "annotations": {"readOnlyHint": t.read_only, "destructiveHint": t.destructive, "idempotentHint": t.read_only, "openWorldHint": False}}
            for t in TOOLS]


def call(ctx: Ctx, name: str, arguments: Optional[dict[str, Any]]) -> dict[str, Any]:
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise ToolError("unknown_tool", f"Unknown tool: {name}", "List them with GET /api/agent/tools.")
    if arguments is not None and not isinstance(arguments, dict):
        raise ToolError("invalid", "arguments must be an object.")
    args = dict(arguments or {})
    allowed = set(tool.schema.get("properties", {}))
    extra = sorted(set(args) - allowed)
    if extra:
        raise ToolError("invalid", f"Unknown arguments: {', '.join(extra)}.", "Allowed: " + ", ".join(sorted(allowed)))
    return tool.run(ctx, args)
