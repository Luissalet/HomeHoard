"""The agent tools. One catalogue serves ``/api/agent/*`` (Bearer token), ``/api/ui/call`` (the local app) and the stdio
MCP bridge. Writes go through the same merge as the app and return the new state."""
from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional

import inventory

from . import house3d as H3
from . import house3d_export as HX
from . import maintenance as MT
from .bundle import link_id
from .hoard_link import fam_refs, family
from .hoard_link.atomic import write_bytes_atomic
from .kafka import KafkaLink, KafkaMirror

INSTRUCTIONS = """HomeHoard keeps the user's home on this computer: homes, floors, rooms, furniture (containers nested inside each other), objects with tags, an appliance card per object (brand, model, serial, purchase, warranty, spare parts, linked papers in Kafka's Hoard) and maintenance tasks with their legal basis or advice.
To answer «¿dónde está…?» use home_find_item; «¿qué hay en…?» home_list_location. Quote locations only from tool results; if an object is not found, say so. Write tools (home_add_item, home_update_item, home_move_item, home_item_details with set, maintenance_*) only when the user asks; deletes need confirm=true.
To prepare a packing list or kit, find the objects first, then home_check_list with their IDs and requested quantities. Repeated IDs are added together; this checks current stock and locations, without reserving or moving anything. Missing IDs and unknown stock leave totals incomplete.
Reusable kits: home_kits saves a named definition (full list of IDs and quantities), lists/reads it, or deletes it on request. home_check_list(kit=ID_or_name) checks one saved definition; kits=[ID_or_name,...] combines up to 50 saved kits against the same stock, summing shared objects and counting each resolved kit only once. Saving a kit never changes stock; identical repeated saves are unchanged.
Use home_warranties for a dated overview of warranties approaching expiry, already expired, or unknown. It reads recorded local card dates, not current Kafka documents or inferred legal periods.
Purchases: item_add_from_purchase files a bought thing (name, price, shop, date, warranty paper, where it came from) in a room or furniture, or in the «Por colocar» room when the place is not known. It is idempotent by source_ref and name.
The house in 3D is built from the 2D plan, never drawn again: home_3d_scene describes it (rooms, walls, doors, windows, furniture, where each object sits, what is overdue), home_3d_locate answers «¿dónde está…?» with the spot in the house and a link that opens the 3D view looking at the object, home_3d_export writes it as GLB (or OBJ, and files it in Vulcan's Hoard with send_to_vulcan). home_plan_openings lists, adds or removes the doors and windows of a room's wall and sets the wall height; without real doors, two rooms that touch get a supposed one.
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
    app_url: str = ""
    refs: Optional[Callable[..., Any]] = None                           # tell the hub two records are the same thing (default: the family library)
    background: Optional[Callable[[Callable[[], Any]], None]] = None    # run a fire-and-forget hint (default: a daemon thread)
    announced: Optional[Callable[[str, str], None]] = None              # note that an object's creation was announced (the sync does not repeat it)
    settings: Optional[Callable[[], dict[str, Any]]] = None             # the server settings (wall height, supposed doors)
    save_settings: Optional[Callable[[dict[str, Any]], dict[str, Any]]] = None
    exports_dir: Optional[Path] = None                                  # where exported files are written (<data>/exports)
    family_call: Optional[Callable[..., dict[str, Any]]] = None         # call a tool of another Hoard through the hub (default: the family library)

    def spawn(self, fn: Callable[[], Any]) -> None:
        def safe() -> None:
            try:
                fn()
            except Exception:  # noqa: BLE001 - hints to the hub; the home is the truth
                pass
        if self.background is not None:
            self.background(safe)
        else:
            threading.Thread(target=safe, name="homehoard-hint", daemon=True).start()

    def item_url(self, item_id: str) -> str:
        return f"{self.app_url.rstrip('/')}/item/{item_id}"

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


def _kit_requirements(requests: list[Any]) -> dict[str, int]:
    if not 1 <= len(requests) <= 100:
        raise ToolError("invalid", "requests debe contener entre 1 y 100 objetos {item_id, quantity}.")
    required: dict[str, int] = {}
    for request in requests:
        if not isinstance(request, dict) or set(request) != {"item_id", "quantity"}:
            raise ToolError("invalid", "Cada petición debe contener solo item_id y quantity.")
        item_id = _arg(request, "item_id", str, required=True)
        quantity = _arg(request, "quantity", int, required=True)
        if quantity <= 0:
            raise ToolError("invalid", "quantity debe ser un entero positivo; quita de la lista lo que ya no necesites.")
        required[item_id] = required.get(item_id, 0) + quantity
    return required


def _kit(ctx: Ctx, ref: str, *, deleted: bool = False) -> dict[str, Any]:
    row = ctx.store.get("packing_kits", ref)
    if row and (deleted or row.get("deleted_at") is None):
        return row
    found = [r for r in ctx.store.alive("packing_kits") if MT.fold(r.get("name", "")) == MT.fold(ref)]
    if len(found) == 1:
        return found[0]
    if len(found) > 1:
        raise ToolError("ambiguous", "Hay varios kits con ese nombre; indica su id.")
    raise ToolError("not_found", f"No existe el kit «{ref}».")


def t_kits(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    action = _arg(a, "action", str, "list")
    with ctx.store.lock:
        if action == "list":
            query = _arg(a, "q", str, "")
            offset, limit = _arg(a, "offset", int, 0), _arg(a, "limit", int, 50)
            if len(query) > 200 or offset < 0 or not 1 <= limit <= 50:
                raise ToolError("invalid", "q admite hasta 200 caracteres; offset debe ser positivo o cero y limit entre 1 y 50.")
            all_kits = ctx.store.alive("packing_kits")
            words = MT.fold(query).split()
            kits = sorted((r for r in all_kits if all(word in MT.fold(f"{r.get('name', '')} {r.get('notes') or ''}") for word in words)),
                          key=lambda r: (MT.fold(r.get("name", "")), r["id"]))
            return {"kits": [{"id": r["id"], "name": r["name"], "items": len(r["requests"]),
                              "updated_at": r["updated_at"]} for r in kits[offset:offset + limit]],
                    "total": len(kits), "all_total": len(all_kits), "q": query, "offset": offset, "limit": limit,
                    "has_more": offset + limit < len(kits)}
        if action == "get":
            return {"kit": _kit(ctx, _arg(a, "kit", str, required=True))}
        if action == "delete":
            if _arg(a, "confirm", bool, False) is not True:
                raise ToolError("confirm_required", "Confirma el borrado del kit con confirm=true.")
            row = _kit(ctx, _arg(a, "kit", str, required=True))
            saved = ctx.store.put("packing_kits", {**row, "deleted_at": ctx.now_ms()})
            return {"status": "deleted", "kit_id": saved["id"], "inventory_version": ctx.store.info()["version"]}
        if action != "save":
            raise ToolError("invalid", "action debe ser list, get, save o delete.")
        name = _arg(a, "name", str, required=True)
        if len(name) > 160:
            raise ToolError("invalid", "El nombre del kit debe tener como máximo 160 caracteres.")
        requests = _arg(a, "requests", list, required=True)
        required = _kit_requirements(requests)
        if any(v > 9007199254740991 for v in required.values()):
            raise ToolError("invalid", "Las cantidades del kit superan la precisión de las copias portables.")
        ref = _arg(a, "kit", str, "")
        old = _kit(ctx, ref, deleted=True) if ref else None
        matches = [r for r in ctx.store.alive("packing_kits") if MT.fold(r.get("name", "")) == MT.fold(name)]
        if len(matches) > 1 or (old and any(r["id"] != old["id"] for r in matches)):
            raise ToolError("ambiguous", "El nombre pertenece a otro kit; usa otro nombre o su id.")
        old = old or (matches[0] if matches else None)
        household = (old or {}).get("household_id") or _household(ctx)
        rid = (old or {}).get("id") or str(uuid.uuid5(uuid.NAMESPACE_URL, f"homehoard:kit:{household}:{MT.fold(name)}"))
        old = old or ctx.store.get("packing_kits", rid)
        rec = {"id": rid, "household_id": household, "name": name,
               "requests": [{"item_id": k, "quantity": v} for k, v in required.items()],
               "notes": _arg(a, "notes", str, (old or {}).get("notes")) or None,
               "created_at": (old or {}).get("created_at", ctx.now_ms()), "deleted_at": None}
        if old and all(old.get(k) == v for k, v in rec.items()):
            return {"status": "unchanged", "kit": old, "inventory_version": ctx.store.info()["version"]}
        saved = ctx.store.put("packing_kits", rec)
        return {"status": "updated" if old else "created", "kit": saved, "inventory_version": ctx.store.info()["version"]}


def t_check_list(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    if sum(a.get(key) is not None for key in ("kit", "kits", "requests")) != 1:
        raise ToolError("invalid", "Indica requests, kit o kits, exactamente uno de los tres.")
    kit = None
    kits = []
    contributions: dict[str, list[dict[str, Any]]] = {}
    # Definition, stock and version all refer to one consistent snapshot.
    with ctx.store.lock:
        if a.get("kits") is not None:
            refs = _arg(a, "kits", list, required=True)
            if not 1 <= len(refs) <= 50:
                raise ToolError("invalid", "kits debe contener entre 1 y 50 ids o nombres de kit.")
            required: dict[str, int] = {}
            seen = set()
            for ref in refs:
                saved = _kit(ctx, _arg({"kit": ref}, "kit", str, required=True))
                if saved["id"] in seen:
                    continue
                seen.add(saved["id"])
                kits.append({key: saved[key] for key in ("id", "name", "updated_at")})
                for item_id, quantity in _kit_requirements(saved["requests"]).items():
                    required[item_id] = required.get(item_id, 0) + quantity
                    contributions.setdefault(item_id, []).append({"id": saved["id"], "name": saved["name"], "quantity": quantity})
        else:
            if a.get("kit") is not None:
                kit = _kit(ctx, _arg(a, "kit", str, required=True))
                requests = kit["requests"]
            else:
                requests = _arg(a, "requests", list, required=True)
            required = _kit_requirements(requests)
        paths = _paths(ctx)
        version = ctx.store.info()["version"]
    rows = []
    for item_id, quantity in required.items():
        item = paths["items"].get(item_id)
        available = item.get("quantity", 1) if item else None
        known = type(available) is int and available >= 0
        to_pack = min(quantity, available) if known else None
        missing = max(0, quantity - available) if known else None
        rows.append({"item_id": item_id, "name": item.get("name") if item else None,
                     "requested": quantity, "available": available if known else None,
                     "to_pack": to_pack, "missing": missing,
                     "location": _item_path(paths, item) if item else None,
                     **({"kits": contributions[item_id]} if kits else {}),
                     "status": ("not_found" if item is None else "unknown_quantity" if not known
                                else "shortage" if missing else "available")})
    complete = all(r["available"] is not None for r in rows)
    return {**({"kit": {"id": kit["id"], "name": kit["name"], "updated_at": kit["updated_at"]}} if kit else {}),
            **({"kits": kits} if kits else {}),
            "inventory_version": version, "ready": complete and all(r["missing"] == 0 for r in rows),
            "totals_complete": complete, "requested_total": sum(required.values()),
            "to_pack_total": sum(r["to_pack"] for r in rows) if complete else None,
            "missing_total": sum(r["missing"] for r in rows) if complete else None,
            "items": rows}


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
    ctx.emit("homehoard.item.created", {"item_id": item["id"], "source_ref": ""})
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
DETAIL_TEXT = ("brand", "model", "serial", "store", "manual_url", "notes", "source_ref", "warranty_ref")
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


def t_warranties(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    """A dated overview of recorded cards; no remote warranty inference."""
    days = _arg(a, 'days', int, 90)
    status = _arg(a, 'status', str, 'expiring')
    offset = _arg(a, 'offset', int, 0)
    limit = _arg(a, 'limit', int, 30)
    if not 0 <= days <= 3650 or offset < 0 or not 1 <= limit <= 100:
        raise ToolError('invalid', 'days debe estar entre 0 y 3650; offset ≥ 0 y limit entre 1 y 100.')
    if status not in ('expiring', 'expired', 'active', 'unknown', 'all'):
        raise ToolError('invalid', 'status es expiring, expired, active, unknown o all.')
    as_of = _day_arg(a, 'as_of')
    today = date.fromisoformat(as_of) if as_of else ctx.today()
    try:
        window_end = today + timedelta(days=days)
    except OverflowError:
        raise ToolError('invalid', 'El intervalo supera el calendario válido.') from None
    with ctx.store.lock:
        location = _resolve_location(ctx, _arg(a, 'location', str, '')) if a.get('location') else None
        paths = _paths(ctx)
        version = ctx.store.info()['version']
    details = {r['item_id']: r for r in paths['all']['item_details'] if r.get('deleted_at') is None}
    rows = []
    for item in paths['items'].values():
        if location:
            if location['kind'] == 'room' and item.get('room_id') != location['id']:
                continue
            if location['kind'] == 'container':
                cid, seen = item.get('container_id'), set()
                while cid and cid != location['id'] and cid not in seen:
                    seen.add(cid); cid = (paths['containers'].get(cid) or {}).get('parent_container_id')
                if cid != location['id']:
                    continue
        card = details.get(item['id'], {})
        until = MT.parse_day(card.get('warranty_until'))
        left = (until - today).days if until else None
        state = 'unknown' if until is None else 'expired' if left < 0 else 'active'
        rows.append({'item_id': item['id'], 'name': item['name'], 'location': _item_path(paths, item),
                     'warranty_until': until.isoformat() if until else None, 'days_left': left,
                     'status': state, 'source': (card.get('warranty_source') or 'manual') if until else None,
                     'warranty_ref': card.get('warranty_ref'), 'brand': card.get('brand'), 'model': card.get('model')})
    unknown = sum(r['status'] == 'unknown' for r in rows)
    def selected(row: dict[str, Any]) -> bool:
        if status == 'all': return True
        if status == 'expiring': return row['days_left'] is not None and 0 <= row['days_left'] <= days
        return row['status'] == status
    matched = sorted((r for r in rows if selected(r)), key=lambda r: (r['warranty_until'] or '9999-12-31', MT.fold(r['name']), r['item_id']))
    return {'as_of': today.isoformat(), 'window_end': window_end.isoformat(),
            'days': days, 'status': status, 'inventory_version': version, 'checked_items': len(rows),
            'unknown_dates': unknown, 'matched': len(matched), 'items': matched[offset:offset + limit],
            'next_offset': offset + limit if offset + limit < len(matched) else None,
            'basis': 'recorded_home_cards', 'kafka_queried': False}


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


REF = re.compile(r"^hoard://[a-z0-9._-]{1,40}/[a-z0-9._-]{1,40}/[A-Za-z0-9._:~-]{1,160}$")
KAFKA_DOC_REF = re.compile(r"^hoard://kafka/document/([A-Za-z0-9._:~-]{1,160})$")
INBOX_ROOM = "Por colocar"


def _ref_value(key: str, value: Any) -> Optional[str]:
    """A ``hoard://<app>/<kind>/<id>`` reference, or None to clear it."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not REF.match(text):
        raise ToolError("invalid", f"{key} debe ser una referencia hoard://app/tipo/id.", "Ejemplo: hoard://hub/purchase/12")
    return text


def save_details(ctx: Ctx, item_id: str, values: dict[str, Any]) -> dict[str, Any]:
    current = ctx.store.get("item_details", item_id) or {"id": item_id, "item_id": item_id, "created_at": ctx.now_ms()}
    rec = {**current, "deleted_at": None}
    for key, value in values.items():
        if key not in DETAIL_FIELDS:
            raise ToolError("invalid", f"Campo desconocido en la ficha: {key}.", "Campos: " + ", ".join(DETAIL_FIELDS))
        if key in ("source_ref", "warranty_ref"):
            rec[key] = _ref_value(key, value)
        elif key in DETAIL_TEXT:
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


# ====================================================================== purchases
def _inbox_room(ctx: Ctx) -> str:
    """The «Por colocar» room: where a bought thing waits until the user decides its place. Made on first use, to the right of the
    other rooms of the first floor of the first home."""
    rooms = ctx.store.alive("rooms")
    found = next((r for r in rooms if MT.fold(r.get("name")) == MT.fold(INBOX_ROOM)), None)
    if found:
        return found["id"]
    homes = sorted(ctx.store.alive("homes"), key=lambda r: r.get("created_at") or 0)
    floors = [f for f in ctx.store.alive("floors") if homes and f.get("home_id") == homes[0]["id"]]
    if not floors:
        raise ToolError("no_home", "HomeHoard no tiene todavía ninguna vivienda con planta.",
                        "Crea la vivienda en la app, o indica room con el nombre de una habitación existente.")
    floor = sorted(floors, key=lambda f: (f.get("level_index") or 0, f.get("created_at") or 0))[0]
    right = max([int((r.get("x_cm") or 0) + (r.get("width_cm") or 0)) for r in rooms if r.get("floor_id") == floor["id"]] or [-50])
    room = ctx.store.put("rooms", {"id": str(uuid.uuid4()), "floor_id": floor["id"], "name": INBOX_ROOM, "kind": None, "color": None, "shape": "rect",
                                   "x_cm": right + 50, "y_cm": 0, "width_cm": 200, "height_cm": 150, "rotation": 0, "points_json": None,
                                   "created_at": ctx.now_ms()})
    return room["id"]


def _purchase_place(ctx: Ctx, room: str, place: str) -> tuple[dict[str, Any], str, str]:
    """``({room_id, container_id}, how, warning)``: the place asked for, or the «Por colocar» room when none was given or it does not
    resolve (a purchase is never lost because a room name did not match)."""
    ref = f"{room} › {place}" if room and place else (place or room)
    warning = ""
    if ref:
        try:
            return _place(_resolve_location(ctx, ref)), "given", ""
        except ToolError as exc:
            if exc.code not in ("not_found", "ambiguous"):
                raise
            warning = f"{exc.message} {exc.hint}".strip()
    return {"room_id": _inbox_room(ctx), "container_id": None}, "inbox", warning


def _purchase_existing(ctx: Ctx, source_ref: str, name: str) -> Optional[dict[str, Any]]:
    """The object already filed for this purchase and name (the same event may arrive twice)."""
    folded = MT.fold(name)
    items = {i["id"]: i for i in ctx.store.alive("items")}
    for d in ctx.store.alive("item_details"):
        item = items.get(d.get("item_id") or d.get("id"))
        if item and d.get("source_ref") == source_ref and MT.fold(item.get("name")) == folded:
            return item
    return None


def t_item_add_from_purchase(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    name = _arg(a, "name", str, required=True)[:160]
    source_ref = _ref_value("source_ref", a.get("source_ref"))
    warranty_ref = _ref_value("warranty_ref", a.get("warranty_ref"))
    merchant = _arg(a, "merchant", str, "")[:120]
    price = a.get("price")
    if price in (None, ""):
        price = None
    else:
        try:
            price = float(str(price).replace(",", ".")) if not isinstance(price, (int, float)) or isinstance(price, bool) else float(price)
        except ValueError as exc:
            raise ToolError("invalid", "price debe ser un número.") from exc
        if price < 0:
            raise ToolError("invalid", "price no puede ser negativo.")
    when = _day_arg({"date": str(a["date"]).strip()[:10]}, "date") if a.get("date") not in (None, "") else None
    if source_ref:
        found = _purchase_existing(ctx, source_ref, name)
        if found:
            return {"ok": True, "status": "existing", "item_id": found["id"], "url": ctx.item_url(found["id"]), "item": _item_out(ctx, found)}
    place, how, warning = _purchase_place(ctx, _arg(a, "room", str, ""), _arg(a, "place", str, ""))
    item = ctx.store.put("items", {"id": str(uuid.uuid4()), "household_id": _household(ctx), "name": name, "description": None, "quantity": 1, **place,
                                   "photo_uri": None, "favorite": 0, "created_at": ctx.now_ms()})
    card: dict[str, Any] = {"store": merchant or None, "price": price, "purchase_date": when, "source_ref": source_ref, "warranty_ref": warranty_ref}
    doc = KAFKA_DOC_REF.match(warranty_ref or "")
    if doc:
        card["kafka_doc_ids"] = [doc.group(1)]
    if any(v is not None for v in card.values()):
        save_details(ctx, item["id"], {k: v for k, v in card.items() if v is not None})
    ctx.emit("homehoard.item.created", {"item_id": item["id"], "source_ref": source_ref or ""})
    if source_ref:
        if ctx.announced:
            ctx.announced(item["id"], source_ref)
        link = ctx.refs or fam_refs.link
        ctx.spawn(lambda: link(f"hoard://homehoard/item/{item['id']}", source_ref, "from_purchase", from_label=name))
    out = {"ok": True, "status": "created", "item_id": item["id"], "url": ctx.item_url(item["id"]),
           "item": _item_out(ctx, ctx.store.get("items", item["id"])), "placed": how}
    if warning:
        out["warning"] = warning
    return out


# ====================================================================== the house in 3D
VULCAN_REASON = {
    "hub_down": "El Hoard Hub no responde: ábrelo para enviar la casa a Vulcan.",
    "app_down": "Vulcan's Hoard no está abierto: ábrelo desde el Hub y repite.",
    "app_unknown": "El Hub no conoce Vulcan's Hoard.",
    "tool_missing": "Esta versión de Vulcan's Hoard no sabe importar un archivo suelto: actualízala.",
    "auth": "El Hub no acepta el token de HomeHoard.",
    "error": "Vulcan devolvió un error.",
}


def scene_of(ctx: Ctx, home: str = "") -> dict[str, Any]:
    return H3.build_scene(ctx.store.tables(), today=ctx.today(), settings=ctx.settings() if ctx.settings else None, home=home, app_url=ctx.app_url)


def t_3d_scene(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    scene = scene_of(ctx, _arg(a, "home", str, ""))
    return scene if _arg(a, "detail", bool, False) else H3.summary(scene)


def t_3d_locate(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    query = _arg(a, "query", str, required=True)
    limit = max(1, min(_arg(a, "limit", int, 5), 20))
    scene = scene_of(ctx)
    if any(i["id"] == query for i in scene["items"]):
        ids = [query]
    else:
        found = inventory.find(query, limit)
        if found["status"] in ("no_snapshot", "empty_query"):
            return {"status": found["status"], "query": query, "matches": [], "message": found["message"]}
        ids = [m["id"] for m in found["matches"]]
    matches = [m for m in (H3.locate(scene, i) for i in ids) if m]
    if not matches:
        return {"status": "not_found", "query": query, "matches": [],
                "message": "Ese objeto está en el inventario, pero su habitación no está en el plano de esta vivienda." if ids
                else "Objeto no encontrado en el inventario de HomeHoard."}
    return {"status": "found", "query": query, "count": len(matches), "best": matches[0], "matches": matches, "url": matches[0]["url"]}


def export_bytes(ctx: Ctx, fmt: str, *, home: str = "", include_items: Optional[bool] = None, scale: float = 100.0) -> dict[str, Any]:
    """The house as one file in memory: ``{scene, name, data, extra}`` (``extra`` holds the OBJ's material file)."""
    if fmt not in ("glb", "obj"):
        raise ToolError("invalid", "format es glb u obj.")
    if not 1 <= float(scale) <= 1000:
        raise ToolError("invalid", "scale va de 1 (tamaño real) a 1000.")
    scene = scene_of(ctx, home)
    if scene["empty"]:
        raise ToolError("not_found", scene.get("message") or "No hay plano que levantar.", "Añade habitaciones en la pestaña Plano.")
    name = HX.slug((scene["home"] or {}).get("name") or "", "casa")
    if fmt == "glb":
        return {"scene": scene, "name": name + ".glb", "data": HX.build_glb(scene, include_items=True if include_items is None else include_items), "extra": {}}
    obj, mtl = HX.build_obj(scene, include_items=bool(include_items), scale=float(scale), mtl_name=name + ".mtl")
    return {"scene": scene, "name": name + ".obj", "data": obj.encode("utf-8"), "extra": {name + ".mtl": mtl.encode("utf-8")}}


def _write_export(ctx: Ctx, built: dict[str, Any]) -> Path:
    if ctx.exports_dir is None:
        raise ToolError("invalid", "Este servidor no tiene carpeta de exportaciones.")
    folder = Path(ctx.exports_dir) / "casa-3d"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / built["name"]
    write_bytes_atomic(path, built["data"])
    for extra_name, data in built["extra"].items():
        write_bytes_atomic(folder / extra_name, data)
    return path


def vulcan_status(ctx: Ctx) -> dict[str, Any]:
    """Whether Vulcan's Hoard answers through the hub right now (the 3D view shows «Enviar a Vulcan» only then)."""
    from .kafka import classify
    try:
        r = (ctx.family_call or family.call)("vulcan", "models_stats", {}, timeout=6)
    except Exception as exc:  # noqa: BLE001 - a missing hub never breaks the view
        r = {"ok": False, "status": None, "error": f"{type(exc).__name__}: {exc}"}
    reason = classify(r if isinstance(r, dict) else {"ok": False, "error": "bad answer"})
    return {"available": reason == "ok", **({} if reason == "ok" else {"reason": reason, "message": VULCAN_REASON.get(reason, VULCAN_REASON["error"])})}


def _send_to_vulcan(ctx: Ctx, path: Path, scene: dict[str, Any]) -> dict[str, Any]:
    from .kafka import classify
    args = {"path": str(path.resolve()), "source_ref": f"hoard://homehoard/home/{scene['home']['id']}"}
    try:
        r = (ctx.family_call or family.call)("vulcan", "model_import_file", args, timeout=180)
    except Exception as exc:  # noqa: BLE001
        r = {"ok": False, "status": None, "error": f"{type(exc).__name__}: {exc}"}
    reason = classify(r if isinstance(r, dict) else {"ok": False, "error": "bad answer"})
    if reason != "ok":
        return {"ok": False, "reason": reason, "message": VULCAN_REASON.get(reason, VULCAN_REASON["error"]), "detail": str(r.get("error") or "")[:300]}
    result = r.get("result") if isinstance(r.get("result"), dict) else {"result": r.get("result")}
    model = result.get("model") if isinstance(result.get("model"), dict) else result
    return {"ok": True, "path": args["path"], "model_id": model.get("id") or result.get("id") or result.get("model_id"),
            "created": result.get("created"), "result": {k: v for k, v in result.items() if isinstance(v, (str, int, float, bool, type(None)))}}


def t_3d_export(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    fmt = (_arg(a, "format", str, "glb") or "glb").lower()
    send = _arg(a, "send_to_vulcan", bool, False)
    scale = _arg(a, "scale", (int, float), 100)
    home = _arg(a, "home", str, "")
    built = export_bytes(ctx, fmt, home=home, include_items=a.get("include_items") if isinstance(a.get("include_items"), bool) else None, scale=scale)
    path = _write_export(ctx, built)
    scene = built["scene"]
    out: dict[str, Any] = {"ok": True, "format": fmt, "path": str(path.resolve()), "file": built["name"], **HX.receipt(built["data"]),
                           "home": scene["home"], "stats": scene["stats"],
                           "units": "metros, Y arriba" if fmt == "glb" else f"milímetros a escala 1:{scale:g}, Z arriba",
                           "download_url": f"{ctx.app_url.rstrip('/')}/api/house3d/export.{fmt}"}
    if send:
        # Vulcan's library reads STL, 3MF and OBJ: the house goes there as an OBJ at print scale, whatever was asked for here
        obj = built if fmt == "obj" else export_bytes(ctx, "obj", home=home, include_items=False, scale=scale)
        obj_path = path if fmt == "obj" else _write_export(ctx, obj)
        out["vulcan"] = {**_send_to_vulcan(ctx, obj_path, scene), "file": obj["name"], "scale": f"1:{scale:g}"}
    return out


def _resolve_room(ctx: Ctx, ref: str) -> dict[str, Any]:
    room = ctx.store.get("rooms", (ref or "").strip())
    if room and room.get("deleted_at") is None:
        return room
    loc = _resolve_location(ctx, ref)
    if loc["kind"] != "room":
        raise ToolError("invalid", f"«{loc['path']}» es un mueble, no una habitación.")
    return ctx.store.get("rooms", loc["id"])


def _openings_out(ctx: Ctx, room: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    scene = scene_of(ctx)
    rows = [{**{k: v for k, v in o.items() if k not in ("center", "axis")}, "floor": f["name"], "side_label": H3.SIDE_LABEL[o["side"]]}
            for f in scene["floors"] for o in f["openings"] if room is None or room["id"] in (o["room_id"], o.get("other_room_id"))]
    return {"settings": scene["settings"], "count": len(rows), "openings": rows,
            "note": "Las puertas con inferred=true son supuestas: aparecen entre dos habitaciones que se tocan mientras esa pared no tenga un hueco real."}


def t_plan_openings(ctx: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    action = _arg(a, "action", str, "list") or "list"
    if action == "list":
        return _openings_out(ctx, _resolve_room(ctx, a["room"]) if _arg(a, "room", str, "") else None)
    if action == "settings":
        values = {k: a[k] for k in ("wall_height_cm", "infer_doors") if a.get(k) is not None}
        if not values:
            raise ToolError("invalid", "Indica wall_height_cm o infer_doors.")
        if ctx.save_settings is None:
            raise ToolError("invalid", "Este servidor no guarda ajustes.")
        ctx.save_settings(values)
        return {"ok": True, **_openings_out(ctx)}
    numbers = {k: _arg(a, k, (int, float)) for k in ("offset_cm", "width_cm", "sill_cm", "height_cm")}
    with ctx.store.lock:
        if action == "add":
            room = _resolve_room(ctx, _arg(a, "room", str, required=True))
            side = H3.parse_side(_arg(a, "side", str, required=True))
            if side is None:
                raise ToolError("invalid", "side es n, e, s u o (norte, este, sur, oeste).")
            kind, opening_id = _arg(a, "kind", str, "door") or "door", None
        elif action in ("update", "remove"):
            opening_id = _arg(a, "opening", str, required=True)
            if opening_id.startswith("auto:"):
                raise ToolError("invalid", "Es una puerta supuesta, no está guardada en el plano.",
                                "Añade una puerta o ventana real en esa pared con action=add, o quita todas las supuestas con action=settings, infer_doors=false.")
            room = next((r for r in ctx.store.alive("rooms") if any(o["id"] == opening_id for o in H3.room_openings(r))), None)
            if room is None:
                raise ToolError("not_found", f"No hay ninguna puerta o ventana «{opening_id}».", "Lista las que hay con action=list.")
            current = next(o for o in H3.room_openings(room) if o["id"] == opening_id)
            side = H3.parse_side(a["side"]) if a.get("side") else current["side"]
            kind = _arg(a, "kind", str, "") or current["kind"]
            for key in numbers:
                if numbers[key] is None:
                    numbers[key] = current[key]
        else:
            raise ToolError("invalid", "action: list, add, update, remove o settings.")
        if action == "remove":
            openings = [o for o in H3.room_openings(room) if o["id"] != opening_id]
        else:
            try:
                openings = H3.new_opening(room, kind=kind, side=side, replace_id=opening_id, **numbers)
            except ValueError as exc:
                raise ToolError("invalid", str(exc)) from exc
        saved = ctx.store.put("rooms", {**room, "openings_json": json.dumps(openings, ensure_ascii=False, separators=(",", ":"))})
    changed = None if action == "remove" else next(o for o in openings if o["id"] == (opening_id or openings[-1]["id"]))
    return {"ok": True, "action": action, "room": {"id": saved["id"], "name": saved.get("name")},
            **({"opening": {**changed, "side_label": H3.SIDE_LABEL[changed["side"]]}} if changed else {"removed": opening_id}),
            **_openings_out(ctx, saved)}


# ====================================================================== catalogue
ITEM = S("Object: its id or its name (a unique match).")
LOCATION = S("Room, piece of furniture or box: id, name or full path (e.g. «Dormitorio › Armario › Cajón rojo»).")
TASK = S("Maintenance task: its id, or words of its title and target (a unique match).")
DETAILS_SET = {"type": "object", "description": "Fields to save (only these change): brand, model, serial, purchase_date (YYYY-MM-DD), store, "
               "price, warranty_until (YYYY-MM-DD), warranty_source (manual|kafka), kafka_doc_ids (list, replaces), manual_url, notes, "
               "source_ref and warranty_ref (hoard://app/kind/id references), "
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
    Tool("home_check_list", _d("Check a packing list against current stock, with shortages and locations. Preparar equipo o un kit.",
                               "Pass one saved kit ID/name with kit, 1–50 saved kit IDs/names with kits, or 1–100 {item_id, quantity} entries with requests using IDs from home_find_item or home_list_location. Use exactly one source. "
                               "kits sums requirements before checking the shared stock and returns contributing kits per object; a resolved kit is counted once even if referenced by ID and name. "
                               "Repeated IDs are summed in first-seen order. Returns requested/available/to_pack/missing per object and inventory_version. "
                               "Unknown or deleted IDs and invalid stored stock have null quantities, totals_complete=false and ready=false; never infer zero stock. "
                               "Read only: nothing is reserved, moved or deducted. A repeated call checks the current inventory again.",
                               "packing list, preparar mochila, qué me falta, lista de equipo, preparar kit, comprobar cantidades"),
         _obj({"kit": S("Saved kit ID or exact unique name; use instead of requests or kits."),
               "kits": {"type": "array", "minItems": 1, "maxItems": 50, "items": S("Saved kit ID or exact unique name.")},
               "requests": {"type": "array", "minItems": 1, "maxItems": 100,
                             "items": _obj({"item_id": S("Exact object ID from inventory search."),
                                            "quantity": I("Requested units, a positive integer.", minimum=1)}, ("item_id", "quantity"))}},
              ()), True, t_check_list),
    Tool("home_kits", _d("Save and reuse packing kits; list, read, update or delete their definitions. Guardar listas de equipo.",
                         "action=list (default, optional q/offset/limit), get(kit), save(name,requests,kit optional,notes optional), delete(kit,confirm=true). "
                         "list searches every saved kit by all words in name/notes, ignoring case and accents; default limit50, maximum50, offset0. "
                         "Returns total matches, all_total saved kits and has_more; follow pages to reach kits beyond the first50. "
                         "save replaces the full list. Repeated saves of the same name reuse its ID; identical saves change nothing. "
                         "Duplicate item IDs are summed. Stock and item locations are unchanged. Check a saved kit with home_check_list(kit). "
                         "Definitions are backed up and synced; this is not a reservation or saved packing progress.",
                         "saved kits, reusable checklist, packing template, guardar kit, listas reutilizables, mochila, equipo de viaje"),
         _obj({"action": S("Operation", enum=["list", "get", "save", "delete"]), "kit": S("Kit ID or unique name"),
               "name": S("Kit name, up to 160 characters"), "notes": S("Optional notes"), "confirm": B("Confirm delete"),
               "q": S("List: all search words in name/notes, accent-insensitive, up to 200 characters", maxLength=200),
               "offset": I("List: number of matches to skip", minimum=0), "limit": I("List: page size, default50", minimum=1, maximum=50),
               "requests": {"type": "array", "minItems": 1, "maxItems": 100,
                            "items": _obj({"item_id": S("Inventory object ID"), "quantity": I("Required units", minimum=1)}, ("item_id", "quantity"))}}),
         False, t_kits),
    Tool("home_add_item", _d("Add an object to a room or furniture (path, name or id), with quantity and tags. Guardar objeto nuevo.",
                             "Returns the new object with its full path. If the place is ambiguous nothing is written.",
                             "apunta que tengo, guarda en, añade al inventario, he metido en"),
         _obj({"name": S("Object name."), "location": LOCATION, "quantity": I("Units (default 1).", minimum=0), "note": S("Free text."),
               "tags": {"type": "array", "items": {"type": "string"}, "description": "Tag names; new ones are created."}, "favorite": B("Mark as favorite.")},
              ("name", "location")), False, t_add_item),
    Tool("item_add_from_purchase", _d("File something that was bought: name, price, shop, date, warranty paper, origin. Registrar una compra.",
                                      "Called by the other Hoards when a purchase arrives. Without room/place it goes to the «Por colocar» room; a place that "
                                      "does not resolve does too (see warning). Idempotent by source_ref and name. Returns the object id and its link.",
                                      "he comprado, guarda lo que compré, alta desde la compra, añade a casa lo que llegó"),
         _obj({"name": S("What was bought."), "source_ref": S("Where it comes from: hoard://app/kind/id (e.g. hoard://hub/purchase/12)."),
               "price": N("Price paid.", minimum=0), "merchant": S("Shop."), "date": S("Purchase date " + DATE + "."),
               "room": S("Room (id, name or path)."), "place": S("Furniture or box in that room (name or path)."),
               "warranty_ref": S("The warranty paper: hoard://kafka/document/<id>.")}, ("name",)), False, t_item_add_from_purchase),
    Tool("home_update_item", _d("Change an object: name, quantity, note, place, tags, favorite. Editar un objeto del inventario.",
                                "Only the fields given change; tags replace the object's tags. Returns the new state.",
                                "cambia el nombre, ahora tengo 3, quita la etiqueta, marca como favorito"),
         _obj({"item": ITEM, "name": S("New name."), "quantity": I("Units.", minimum=0), "note": S("Free text (empty clears it)."), "location": LOCATION,
               "tags": {"type": "array", "items": {"type": "string"}}, "favorite": B("Favorite or not.")}, ("item",)), False, t_update_item),
    Tool("home_move_item", _d("Move an object to another room, piece of furniture or box. Mover o guardar un objeto en otro sitio.",
                              "Returns where it was and where it is now.",
                              "guarda la linterna en el cajón rojo, mueve, pon en, cambia de sitio, lo he llevado a"),
         _obj({"item": ITEM, "location": LOCATION}, ("item", "location")), False, t_move_item),
    Tool("home_warranties", _d("List recorded warranties by expiry date and location. Garantías que caducan o ya vencidas.",
           "Uses local appliance-card dates only; does not query Kafka or infer a legal warranty period. expiring includes today through days ahead. Unknown dates are counted separately; pagination uses next_offset.",
           "garantías, caducan, vencen, aparatos, warranty expiry, warranty overview"),
         _obj({"days": I("Days ahead, inclusive (0–3650).", minimum=0, maximum=3650),
               "status": S("expiring (default), expired, active, unknown or all.", enum=["expiring","expired","active","unknown","all"]),
               "as_of": S("Reference date YYYY-MM-DD; omit for today."),
               "location": S("Optional room or furniture ID/name/path; includes nested contents."),
               "offset": I("Pagination offset.", minimum=0), "limit": I("Page size (1–100).", minimum=1, maximum=100)}), True, t_warranties),
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
    Tool("home_3d_scene", _d("The house in 3D built from the 2D plan: rooms, walls, doors, furniture, objects. Casa en 3D.",
                             "Nothing is drawn again: room rectangles become floors and walls with height, the furniture of the plan becomes boxes, "
                             "each object gets a spot in its room or on its furniture, and overdue maintenance is flagged. Returns a summary (sizes in "
                             "metres, counts, openings, what is due, warnings, url of the 3D view); detail=true adds the full geometry.",
                             "generar el 3D, levantar el plano, vista 3D, maqueta de la casa, casa en tres dimensiones, muros"),
         _obj({"detail": B("Include the full geometry (walls as boxes, positions)."), "home": S("Home id or name when there are several.")}), True, t_3d_scene),
    Tool("home_3d_locate", _d("Where an object is inside the 3D house, with the camera to look at it and a link. Localizar en 3D.",
                              "Same search as home_find_item (Spanish questions, small spelling errors) or an object id. Each match says its room, "
                              "furniture and floor, its position in metres, an orbit camera and a first-person spot, and url opens the 3D view "
                              "flying to it. If it is not found, say so.",
                              "¿dónde está el taladro?, llévame hasta, enséñame dónde está, localizar en la casa, ver en 3D"),
         _obj({"query": S("What to look for, e.g. «taladro», or an object id."), "limit": I("1–20", minimum=1, maximum=20)}, ("query",)), True, t_3d_locate),
    Tool("home_3d_export", _d("Export the 3D house as GLB or OBJ and optionally file it in Vulcan's Hoard. Exportar la casa GLB.",
                              "format glb (default: metres, Y up, nodes named after rooms, furniture and objects with their ids in extras) or obj "
                              "(millimetres at 1:scale, Z up). Written to data/exports/casa-3d, overwriting the previous export; returns path, size "
                              "and SHA-256. send_to_vulcan=true also files an OBJ at 1:scale in Vulcan's 3D library through the hub and says why "
                              "when Vulcan is not open.",
                              "exportar la casa, GLB, glTF, OBJ, maqueta imprimible, enviar a Vulcan, descargar el modelo 3D"),
         _obj({"format": S("glb | obj", enum=["glb", "obj"]), "include_items": B("Object markers (default: yes in GLB, no in OBJ)."),
               "scale": {"type": "number", "minimum": 1, "maximum": 1000, "description": "OBJ and Vulcan: 1:scale (default 100)."},
               "send_to_vulcan": B("Also file it in Vulcan's Hoard."), "home": S("Home id or name when there are several.")}), False, t_3d_export),
    Tool("home_plan_openings", _d("Doors and windows of the plan and the wall height: list, add, update, remove. Puertas y ventanas.",
                                  "action=list (default; room optional), add(room, side n|e|s|o, kind door|window, offset_cm from the west or north "
                                  "end of that wall, default centred, width_cm, sill_cm, height_cm), update(opening, fields), remove(opening), "
                                  "settings(wall_height_cm 200–400, infer_doors). Openings are stored on the room; plans saved earlier keep working. "
                                  "A door between two rooms is stored once. inferred=true marks supposed doors, which are not stored.",
                                  "añadir puerta, poner ventana, quitar puerta, altura de los muros, huecos del plano, techo"),
         _obj({"action": S("Operation", enum=["list", "add", "update", "remove", "settings"]), "room": S("Room: id, name or path."),
               "side": S("Wall of the room: n, e, s, o (norte, este, sur, oeste)."), "kind": S("door | window", enum=["door", "window"]),
               "opening": S("Opening id (update, remove)."),
               "offset_cm": {"type": "number", "minimum": 0, "description": "From the west end (n, s walls) or the north end (e, o walls)."},
               "width_cm": {"type": "number", "minimum": 30}, "sill_cm": {"type": "number", "minimum": 0}, "height_cm": {"type": "number", "minimum": 30},
               "wall_height_cm": I("Wall height, 200–400.", minimum=200, maximum=400), "infer_doors": B("Supposed doors between rooms that touch.")}),
         False, t_plan_openings),
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
    if name in ("home_update_item", "home_move_item"):
        with ctx.store.lock:
            return tool.run(ctx, args)
    return tool.run(ctx, args)
