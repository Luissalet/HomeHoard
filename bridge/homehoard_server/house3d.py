"""The house in 3D, derived from the 2D plan that the app already keeps.

Nothing is drawn again: every room rectangle of a floor becomes a floor slab and walls with height, the furniture placed
on the plan becomes boxes, and each object of the inventory gets a spot in its room or on its piece of furniture. Doors
and windows live on the room record (``openings_json``, a JSON list); a plan saved before that field existed simply has
none, and two rooms that touch then get a door between them (``infer_doors``).

Pure functions over the tables of the home; ``today`` is always passed in. Metres, Y up, plan x -> X and plan y -> Z."""
from __future__ import annotations

import json
import math
import uuid
from datetime import date
from typing import Any, Optional

from . import maintenance as MT

DEFAULT_SETTINGS = {"wall_height_cm": 250, "infer_doors": True}
WALL_HEIGHT_RANGE = (200, 400)
EXTERIOR_T = 0.20          # wall thickness, metres
INTERIOR_T = 0.10
ADJACENT_TOL = 0.35        # two facing room edges this close are one shared wall
MIN_SHARED = 0.30
SLAB = 0.06
FLOOR_GAP = 0.30           # between the ceiling of one floor and the floor of the next
EYE = 1.6
SIDES = ("n", "e", "s", "w")
SIDE_LABEL = {"n": "norte", "e": "este", "s": "sur", "w": "oeste"}
SIDE_ALIASES = {"n": "n", "norte": "n", "north": "n", "arriba": "n", "s": "s", "sur": "s", "south": "s", "abajo": "s",
                "e": "e", "este": "e", "east": "e", "derecha": "e", "w": "w", "o": "w", "oeste": "w", "west": "w", "izquierda": "w"}
OPENING_KINDS = ("door", "window")
HALL_WORDS = ("pasillo", "recibidor", "entrada", "distribuidor", "vestibulo", "hall", "corredor")
OPENING_LABEL = {"door": "Puerta", "window": "Ventana"}
OPENING_DEFAULTS = {"door": {"width_cm": 82, "height_cm": 203, "sill_cm": 0},
                    "window": {"width_cm": 120, "height_cm": 120, "sill_cm": 90}}
MIN_OPENING = 0.30
MAX_OPENINGS_PER_ROOM = 40

# Height of a piece of furniture by kind (the plan only keeps its footprint) and the footprint used when it has none.
FURNITURE_HEIGHT = {"wardrobe": 2.0, "closet": 2.0, "shelf": 1.8, "fridge": 1.8, "cabinet": 0.9, "dresser": 0.9, "drawer": 0.5,
                    "nightstand": 0.55, "desk": 0.75, "chest": 0.5, "box": 0.4}
FURNITURE_FOOTPRINT = {"wardrobe": (1.2, 0.6), "closet": (1.2, 0.6), "shelf": (0.9, 0.35), "fridge": (0.6, 0.65), "cabinet": (0.9, 0.45),
                       "dresser": (0.9, 0.45), "drawer": (0.6, 0.45), "nightstand": (0.45, 0.4), "desk": (1.2, 0.6), "chest": (0.8, 0.45),
                       "box": (0.5, 0.4)}
DEFAULT_FURNITURE_HEIGHT = 0.8
DEFAULT_FOOTPRINT = (0.8, 0.45)
ROOM_COLORS = ("#5C8171", "#9A8060", "#647D93", "#9B705F", "#776D8D", "#7C8B5E", "#9D8254", "#697F77")


# ---------------------------------------------------------------------------- small helpers
def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return default
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


def _r(value: float) -> float:
    return round(float(value), 4)


def _alive(rows: Any) -> list[dict[str, Any]]:
    return [r for r in (rows or []) if isinstance(r, dict) and r.get("deleted_at") is None and r.get("id")]


def clean_settings(values: Optional[dict[str, Any]]) -> dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    values = values or {}
    h = _num(values.get("wall_height_cm"))
    if h is not None:
        out["wall_height_cm"] = int(min(max(h, WALL_HEIGHT_RANGE[0]), WALL_HEIGHT_RANGE[1]))
    if isinstance(values.get("infer_doors"), bool):
        out["infer_doors"] = values["infer_doors"]
    return out


# ---------------------------------------------------------------------------- doors and windows on the room record
def parse_side(value: Any) -> Optional[str]:
    return SIDE_ALIASES.get(MT.fold(value).strip())


def room_openings(room: dict[str, Any]) -> list[dict[str, Any]]:
    """The doors and windows stored on a room, cleaned: a plan without the field, or with rubbish in it, has none."""
    raw = room.get("openings_json")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            raw = []
    out: list[dict[str, Any]] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or entry.get("kind") not in OPENING_KINDS or entry.get("side") not in SIDES:
            continue
        base = OPENING_DEFAULTS[entry["kind"]]
        offset, width = _num(entry.get("offset_cm")), _num(entry.get("width_cm"), base["width_cm"])
        if offset is None or offset < 0 or width is None or width < MIN_OPENING * 100:
            continue
        out.append({"id": str(entry.get("id") or f"{entry['side']}{int(offset)}"), "kind": entry["kind"], "side": entry["side"],
                    "offset_cm": round(offset, 1), "width_cm": round(width, 1),
                    "sill_cm": round(max(0.0, _num(entry.get("sill_cm"), base["sill_cm"]) or 0.0), 1),
                    "height_cm": round(max(30.0, _num(entry.get("height_cm"), base["height_cm"]) or base["height_cm"]), 1)})
    return out[:MAX_OPENINGS_PER_ROOM]


def side_length_cm(room: dict[str, Any], side: str) -> float:
    rect = _room_rect(room)
    if rect is None:
        return 0.0
    return round(((rect["x1"] - rect["x0"]) if side in ("n", "s") else (rect["z1"] - rect["z0"])) * 100, 1)


def new_opening(room: dict[str, Any], *, kind: str, side: str, offset_cm: Optional[float] = None, width_cm: Optional[float] = None,
                sill_cm: Optional[float] = None, height_cm: Optional[float] = None, replace_id: Optional[str] = None) -> list[dict[str, Any]]:
    """The room's openings with one added (or ``replace_id`` changed). Raises ValueError, in Spanish, when it does not fit."""
    if kind not in OPENING_KINDS:
        raise ValueError("kind es door (puerta) o window (ventana).")
    if side not in SIDES:
        raise ValueError("side es n, e, s u o (norte, este, sur, oeste).")
    length = side_length_cm(room, side)
    if length <= 0:
        raise ValueError("Esa habitación todavía no tiene medidas en el plano.")
    base = OPENING_DEFAULTS[kind]
    width = float(width_cm if width_cm is not None else base["width_cm"])
    if width < MIN_OPENING * 100:
        raise ValueError("El hueco tiene que medir al menos 30 cm de ancho.")
    if width > length - 10:
        raise ValueError(f"La pared {SIDE_LABEL[side]} de «{room.get('name')}» mide {length:.0f} cm: un hueco de {width:.0f} cm no cabe.")
    offset = float(offset_cm) if offset_cm is not None else (length - width) / 2
    offset = min(max(offset, 5.0), length - width - 5.0)
    existing = [o for o in room_openings(room) if o["id"] != replace_id]
    for other in existing:
        if other["side"] == side and offset < other["offset_cm"] + other["width_cm"] and other["offset_cm"] < offset + width:
            raise ValueError(f"Se solapa con otra {OPENING_LABEL[other['kind']].lower()} de esa pared (a {other['offset_cm']:.0f} cm).")
    if len(existing) >= MAX_OPENINGS_PER_ROOM:
        raise ValueError("Esa habitación ya tiene demasiados huecos.")
    entry = {"id": replace_id or uuid.uuid4().hex[:10], "kind": kind, "side": side, "offset_cm": round(offset, 1), "width_cm": round(width, 1),
             "sill_cm": round(max(0.0, float(sill_cm if sill_cm is not None else base["sill_cm"])), 1),
             "height_cm": round(max(30.0, float(height_cm if height_cm is not None else base["height_cm"])), 1)}
    return existing + [entry]


# ---------------------------------------------------------------------------- rooms
def _room_rect(room: dict[str, Any]) -> Optional[dict[str, float]]:
    x, y, w, h = (_num(room.get(k)) for k in ("x_cm", "y_cm", "width_cm", "height_cm"))
    if x is None or y is None or w is None or h is None or w < 20 or h < 20:
        return None
    return {"x0": x / 100, "z0": y / 100, "x1": (x + w) / 100, "z1": (y + h) / 100}


def _layout_rooms(rooms: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Rectangle of every room in metres. Rooms the plan has no measures for are lined up below the rest, 3 x 3 m each."""
    rects: dict[str, dict[str, Any]] = {}
    pending = []
    for room in rooms:
        rect = _room_rect(room)
        if rect is None:
            pending.append(room)
        else:
            rects[room["id"]] = {**rect, "placed": True}
    top = max((r["z1"] for r in rects.values()), default=-0.1) + 0.2 if rects else 0.1
    for i, room in enumerate(pending):
        col, row = i % 4, i // 4
        x0, z0 = 0.1 + col * 3.2, top + row * 3.2
        rects[room["id"]] = {"x0": x0, "z0": z0, "x1": x0 + 3.0, "z1": z0 + 3.0, "placed": False}
    return rects


def _edge(rect: dict[str, Any], side: str) -> tuple[str, float, float, float, int]:
    """(axis the edge runs along, fixed coordinate, low, high, outward sign)."""
    if side == "n":
        return "x", rect["z0"], rect["x0"], rect["x1"], -1
    if side == "s":
        return "x", rect["z1"], rect["x0"], rect["x1"], 1
    if side == "w":
        return "z", rect["x0"], rect["z0"], rect["z1"], -1
    return "z", rect["x1"], rect["z0"], rect["z1"], 1


def _subtract(lo: float, hi: float, covered: list[tuple[float, float]]) -> list[tuple[float, float]]:
    free, at = [], lo
    for a, b in sorted(covered):
        if a > at + 1e-6:
            free.append((at, min(a, hi)))
        at = max(at, b)
        if at >= hi:
            break
    if at < hi - 1e-6:
        free.append((at, hi))
    return [(a, b) for a, b in free if b - a > 0.05]


def _inside(rect: dict[str, Any], x: float, z: float) -> bool:
    return rect["x0"] + 1e-6 < x < rect["x1"] - 1e-6 and rect["z0"] + 1e-6 < z < rect["z1"] - 1e-6


# ---------------------------------------------------------------------------- walls
def _wall_skeletons(rects: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    walls: list[dict[str, Any]] = []
    covered: dict[tuple[str, str], list[tuple[float, float]]] = {}
    ids = sorted(rects)
    for a in ids:
        for b in ids:
            if a == b:
                continue
            ra, rb = rects[a], rects[b]
            for side_a, side_b, lo_key, hi_key, near, far in (("s", "n", "x0", "x1", "z1", "z0"), ("e", "w", "z0", "z1", "x1", "x0")):
                gap = rb[far] - ra[near]
                if abs(gap) > ADJACENT_TOL:
                    continue
                lo, hi = max(ra[lo_key], rb[lo_key]), min(ra[hi_key], rb[hi_key])
                if hi - lo < MIN_SHARED:
                    continue
                walls.append({"axis": "x" if side_a == "s" else "z", "fixed": (ra[near] + rb[far]) / 2, "lo": lo, "hi": hi, "lo_ext": lo, "hi_ext": hi,
                              "thickness": max(INTERIOR_T, gap), "exterior": False, "sign": 1, "edges": [(a, side_a), (b, side_b)]})
                covered.setdefault((a, side_a), []).append((lo, hi))
                covered.setdefault((b, side_b), []).append((lo, hi))
    for rid in ids:
        rect = rects[rid]
        for side in SIDES:
            axis, fixed, lo, hi, sign = _edge(rect, side)
            for a, b in _subtract(lo, hi, covered.get((rid, side), [])):
                mid, out = (a + b) / 2, fixed + sign * 0.25
                px, pz = (mid, out) if axis == "x" else (out, mid)
                exterior = not any(_inside(other, px, pz) for oid, other in rects.items() if oid != rid)
                t = EXTERIOR_T if exterior else INTERIOR_T
                walls.append({"axis": axis, "fixed": fixed + sign * t / 2, "lo": a, "hi": b, "thickness": t, "exterior": exterior, "sign": sign,
                              "lo_ext": a - t if abs(a - lo) < 1e-6 else a, "hi_ext": b + t if abs(b - hi) < 1e-6 else b, "edges": [(rid, side)]})
    walls.sort(key=lambda w: (w["axis"], round(w["fixed"], 3), round(w["lo"], 3), w["edges"][0]))
    for i, wall in enumerate(walls):
        wall["id"] = f"w{i + 1}"
        wall["openings"] = []
    return walls


def _box(axis: str, a0: float, a1: float, f0: float, f1: float, y0: float, y1: float, part: str, **extra: Any) -> dict[str, Any]:
    lo, hi = (min(f0, f1), max(f0, f1))
    if axis == "x":
        return {"min": [_r(a0), _r(y0), _r(lo)], "max": [_r(a1), _r(y1), _r(hi)], "part": part, **extra}
    return {"min": [_r(lo), _r(y0), _r(a0)], "max": [_r(hi), _r(y1), _r(a1)], "part": part, **extra}


def _wall_boxes(wall: dict[str, Any], y0: float, height: float) -> list[dict[str, Any]]:
    axis, f, t = wall["axis"], wall["fixed"], wall["thickness"]
    f0, f1, top = f - t / 2, f + t / 2, y0 + height
    boxes: list[dict[str, Any]] = []
    at = wall["lo_ext"]
    for op in sorted(wall["openings"], key=lambda o: o["s"]):
        if op["s"] > at + 1e-6:
            boxes.append(_box(axis, at, op["s"], f0, f1, y0, top, "solid"))
        sill = y0 + min(op["sill"], height)
        head = y0 + min(op["sill"] + op["height"], height)
        if op["kind"] == "window":
            if sill > y0 + 0.01:
                boxes.append(_box(axis, op["s"], op["e"], f0, f1, y0, sill, "sill", opening_id=op["id"]))
            boxes.append(_box(axis, op["s"], op["e"], f - 0.015, f + 0.015, sill, head, "glass", opening_id=op["id"]))
        else:
            # the leaf, open at a right angle into the room the door belongs to
            inward = -wall["sign"] if len(wall["edges"]) == 1 else -1
            boxes.append(_box(axis, op["s"], op["s"] + 0.04, f + inward * t / 2, f + inward * (t / 2 + (op["e"] - op["s"])), y0, head, "door",
                              opening_id=op["id"]))
        if head < top - 0.01:
            boxes.append(_box(axis, op["s"], op["e"], f0, f1, head, top, "lintel", opening_id=op["id"]))
        at = max(at, op["e"])
    if at < wall["hi_ext"] - 1e-6:
        boxes.append(_box(axis, at, wall["hi_ext"], f0, f1, y0, top, "solid"))
    return boxes


def _door_spot(wall: dict[str, Any], half: float, furniture: list[dict[str, Any]]) -> float:
    """Where a supposed door goes along a shared wall: the middle, or the nearest spot with no furniture in front."""
    k = 0 if wall["axis"] == "x" else 2        # the coordinate the wall runs along; the other one is where it stands
    taken = [(f["box"]["min"][k] - 0.05, f["box"]["max"][k] + 0.05) for f in furniture
             if f["box"]["min"][2 - k] - 0.6 < wall["fixed"] < f["box"]["max"][2 - k] + 0.6]
    mid = (wall["lo"] + wall["hi"]) / 2
    reach = (wall["hi"] - wall["lo"]) / 2 - half - 0.1
    for i in range(int(max(reach, 0) / 0.1) + 1):
        for at in (mid + i * 0.1, mid - i * 0.1):
            if not any(at - half < b and a < at + half for a, b in taken):
                return at
    return mid


def _build_walls(rooms: list[dict[str, Any]], rects: dict[str, dict[str, Any]], *, elevation: float, height: float,
                 infer_doors: bool, furniture: Optional[list[dict[str, Any]]] = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    walls = _wall_skeletons(rects)
    names = {r["id"]: r.get("name") or "" for r in rooms}
    opening_rows: list[dict[str, Any]] = []
    for room in rooms:
        rect = rects[room["id"]]
        for op in room_openings(room):
            axis, _fixed, lo, hi, _sign = _edge(rect, op["side"])
            s = max(lo + 0.05, lo + op["offset_cm"] / 100)
            e = min(hi - 0.05, lo + (op["offset_cm"] + op["width_cm"]) / 100)
            if e - s < MIN_OPENING:
                continue
            for wall in walls:
                if (room["id"], op["side"]) not in wall["edges"]:
                    continue
                ws, we = max(s, wall["lo"]), min(e, wall["hi"])
                if we - ws < MIN_OPENING or any(ws < o["e"] and o["s"] < we for o in wall["openings"]):
                    continue
                wall["openings"].append({"id": op["id"], "kind": op["kind"], "s": ws, "e": we, "sill": op["sill_cm"] / 100, "height": op["height_cm"] / 100})
                opening_rows.append({**op, "room_id": room["id"], "room_name": names[room["id"]], "inferred": False, "wall_id": wall["id"],
                                     "_wall": wall, "_s": ws, "_e": we})
    if infer_doors:
        # Supposed doors: only the ones needed for every room to be reachable. Rooms already joined by a real door stay as
        # they are; the rest are joined through the walls they share, corridors first and then the longest wall.
        base = OPENING_DEFAULTS["door"]
        group = {r["id"]: r["id"] for r in rooms}

        def find(rid: str) -> str:
            while group[rid] != rid:
                group[rid] = group[group[rid]]
                rid = group[rid]
            return rid

        shared = [w for w in walls if len(w["edges"]) == 2]
        for wall in shared:
            if any(o["kind"] == "door" for o in wall["openings"]):
                group[find(wall["edges"][0][0])] = find(wall["edges"][1][0])
        halls = {r["id"] for r in rooms if r.get("kind") == "hall" or any(w in MT.fold(r.get("name")) for w in HALL_WORDS)}
        candidates = [w for w in shared if not w["openings"] and w["hi"] - w["lo"] >= base["width_cm"] / 100 + 0.3]
        candidates.sort(key=lambda w: (0 if halls & {w["edges"][0][0], w["edges"][1][0]} else 1, -(w["hi"] - w["lo"]), w["id"]))
        for wall in candidates:
            (room_a, side_a), (room_b, _side_b) = wall["edges"]
            if find(room_a) == find(room_b):
                continue
            group[find(room_a)] = find(room_b)
            half = base["width_cm"] / 200
            mid = _door_spot(wall, half, furniture or [])
            oid = f"auto:{room_a}:{room_b}"
            wall["openings"].append({"id": oid, "kind": "door", "s": mid - half, "e": mid + half, "sill": 0.0, "height": base["height_cm"] / 100})
            _axis, _fixed, lo, _hi, _sign = _edge(rects[room_a], side_a)
            opening_rows.append({"id": oid, "kind": "door", "side": side_a, "offset_cm": round((mid - half - lo) * 100, 1), "width_cm": float(base["width_cm"]),
                                 "sill_cm": 0.0, "height_cm": float(base["height_cm"]), "room_id": room_a, "room_name": names[room_a], "inferred": True,
                                 "other_room_id": room_b, "other_room_name": names[room_b], "wall_id": wall["id"], "_wall": wall,
                                 "_s": mid - half, "_e": mid + half})
    out_walls = []
    for wall in walls:
        boxes = _wall_boxes(wall, elevation, height)
        normal = [0, wall["sign"]] if wall["axis"] == "x" else [wall["sign"], 0]
        out_walls.append({"id": wall["id"], "axis": wall["axis"], "fixed": _r(wall["fixed"]), "lo": _r(wall["lo"]), "hi": _r(wall["hi"]),
                          "thickness": _r(wall["thickness"]), "height": _r(height), "exterior": wall["exterior"], "normal": normal,
                          "rooms": [rid for rid, _ in wall["edges"]], "edges": [{"room_id": rid, "side": side} for rid, side in wall["edges"]],
                          "boxes": boxes})
    out_openings = []
    for row in opening_rows:
        wall = row.pop("_wall")
        s, e = row.pop("_s"), row.pop("_e")
        mid = (s + e) / 2
        y = elevation + (row["sill_cm"] + row["height_cm"] / 2) / 100
        row["center"] = [_r(mid), _r(y), _r(wall["fixed"])] if wall["axis"] == "x" else [_r(wall["fixed"]), _r(y), _r(mid)]
        row["axis"] = wall["axis"]
        row["label"] = OPENING_LABEL[row["kind"]] + (" supuesta" if row["inferred"] else "")
        out_openings.append(row)
    return out_walls, out_openings


# ---------------------------------------------------------------------------- furniture and objects
def _furniture(containers: list[dict[str, Any]], rects: dict[str, dict[str, Any]], elevation: float) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    auto_at: dict[str, float] = {}
    for c in sorted(containers, key=lambda r: (MT.fold(r.get("name")), r["id"])):
        rect = rects.get(c.get("room_id"))
        if rect is None or c.get("parent_container_id"):
            continue
        kind = c.get("kind") or ""
        room_w, room_d = rect["x1"] - rect["x0"], rect["z1"] - rect["z0"]
        x, y, w, d = (_num(c.get(k)) for k in ("x_cm", "y_cm", "width_cm", "height_cm"))
        placed = None not in (x, y, w, d) and w >= 5 and d >= 5
        if placed:
            fw, fd = min(w / 100, room_w), min(d / 100, room_d)
            fx = rect["x0"] + min(max(x / 100, 0.0), room_w - fw)
            fz = rect["z0"] + min(max(y / 100, 0.0), room_d - fd)
        else:
            # no footprint on the plan: lined up along the north wall, then the south one
            fw, fd = FURNITURE_FOOTPRINT.get(kind, DEFAULT_FOOTPRINT)
            fw, fd = min(fw, room_w - 0.2), min(fd, room_d / 2 - 0.1)
            at = auto_at.get(c["room_id"], 0.1)
            north = at + fw <= room_w - 0.1
            if not north:
                at = auto_at.get(c["room_id"] + ":s", 0.1)
                auto_at[c["room_id"] + ":s"] = at + fw + 0.1
            else:
                auto_at[c["room_id"]] = at + fw + 0.1
            fx = rect["x0"] + min(at, max(0.0, room_w - fw))
            fz = rect["z0"] + 0.05 if north else rect["z1"] - fd - 0.05
        fh = FURNITURE_HEIGHT.get(kind, DEFAULT_FURNITURE_HEIGHT)
        out.append({"id": c["id"], "name": c.get("name") or "", "kind": kind or None, "room_id": c["room_id"], "placed": bool(placed),
                    "box": {"min": [_r(fx), _r(elevation), _r(fz)], "max": [_r(fx + fw), _r(elevation + fh), _r(fz + fd)]}})
    return out


def _grid(x0: float, z0: float, w: float, d: float, n: int) -> list[tuple[float, float]]:
    cols = max(1, min(n, round(math.sqrt(n * max(w, 0.05) / max(d, 0.05))) or 1))
    rows = math.ceil(n / cols)
    return [(x0 + (i % cols + 0.5) * w / cols, z0 + (i // cols + 0.5) * d / rows) for i in range(n)]


def _floor_spots(rect: dict[str, Any], blocked: list[dict[str, Any]], n: int) -> list[tuple[float, float]]:
    """Free floor for the loose objects of a room: a grid from the middle outwards that keeps off the furniture."""
    cx, cz = (rect["x0"] + rect["x1"]) / 2, (rect["z0"] + rect["z1"]) / 2
    for step, margin in ((0.55, 0.45), (0.4, 0.3), (0.28, 0.2), (0.18, 0.12)):
        w, d = rect["x1"] - rect["x0"] - 2 * margin, rect["z1"] - rect["z0"] - 2 * margin
        if w <= 0 or d <= 0:
            continue
        nx, nz = max(1, int(w / step) + 1), max(1, int(d / step) + 1)
        spots = []
        for i in range(nx):
            for j in range(nz):
                x = rect["x0"] + margin + (w * i / (nx - 1) if nx > 1 else w / 2)
                z = rect["z0"] + margin + (d * j / (nz - 1) if nz > 1 else d / 2)
                if any(b["min"][0] - 0.18 < x < b["max"][0] + 0.18 and b["min"][2] - 0.18 < z < b["max"][2] + 0.18 for b in blocked):
                    continue
                spots.append((x, z))
        if len(spots) >= n:
            # the very middle is left for the name of the room when there is floor to spare
            spots.sort(key=lambda p: (math.hypot(p[0] - cx, p[1] - cz) < 0.6, round(math.hypot(p[0] - cx, p[1] - cz), 3), p[1], p[0]))
            return spots[:n]
    return [(cx + 0.12 * math.cos(i * 2.4) * math.sqrt(i), cz + 0.12 * math.sin(i * 2.4) * math.sqrt(i)) for i in range(n)]


def _status(groups: list[str]) -> str:
    return "overdue" if "overdue" in groups else "due" if "month" in groups else "ok"


def _days_text(days: Optional[int]) -> str:
    if days is None:
        return ""
    if days < 0:
        return "vencida ayer" if days == -1 else f"vencida hace {-days} días"
    return "vence hoy" if days == 0 else "vence mañana" if days == 1 else f"vence en {days} días"


# ---------------------------------------------------------------------------- the scene
def build_scene(tables: dict[str, list[dict[str, Any]]], *, today: date, settings: Optional[dict[str, Any]] = None, home: str = "",
                app_url: str = "") -> dict[str, Any]:
    """Everything the 3D view, the locate tool and the exports need, from the tables of the home."""
    cfg = clean_settings(settings)
    height = cfg["wall_height_cm"] / 100
    homes = sorted(_alive(tables.get("homes")), key=lambda r: (r.get("created_at") or 0, r["id"]))
    chosen = next((h for h in homes if home and (h["id"] == home or MT.fold(h.get("name")) == MT.fold(home))), None) or (homes[0] if homes else None)
    base = {"format": "homehoard-house3d", "version": 1, "units": "m", "up": "y", "today": today.isoformat(), "settings": cfg,
            "homes": [{"id": h["id"], "name": h.get("name") or ""} for h in homes], "url": f"{app_url.rstrip('/')}/casa3d" if app_url else "/casa3d"}
    if chosen is None:
        return {**base, "home": None, "floors": [], "items": [], "maintenance": {"overdue": 0, "due": 0, "tasks": []}, "warnings": [],
                "stats": {"floors": 0, "rooms": 0, "walls": 0, "doors": 0, "windows": 0, "furniture": 0, "items": 0, "items_placed": 0},
                "bounds": None, "empty": True, "message": "Todavía no hay ninguna vivienda en HomeHoard."}

    floors = sorted((f for f in _alive(tables.get("floors")) if f.get("home_id") == chosen["id"]),
                    key=lambda f: (_num(f.get("level_index"), 0) or 0, f.get("created_at") or 0, f["id"]))
    all_rooms, all_containers = _alive(tables.get("rooms")), _alive(tables.get("containers"))
    containers_by_id = {c["id"]: c for c in all_containers}
    tasks = [t for t in _alive(tables.get("maintenance_tasks")) if not t.get("paused")]
    tasks_by_target: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for t in tasks:
        day = MT.parse_day(t.get("next_due"))
        row = {"id": t["id"], "title": t.get("title") or "", "next_due": t.get("next_due"), "group": MT.group_of(t.get("next_due"), today),
               "days": (day - today).days if day else None, "basis": t.get("basis") or "advice"}
        row["when"] = _days_text(row["days"])
        tasks_by_target.setdefault((str(t.get("target_kind")), str(t.get("target_id"))), []).append(row)
    for rows in tasks_by_target.values():
        rows.sort(key=lambda r: (r["next_due"] or "9999", r["title"]))

    warnings: list[str] = []
    floors_out, items_out, alerts = [], [], []
    room_floor: dict[str, dict[str, Any]] = {}
    furniture_by_id: dict[str, dict[str, Any]] = {}
    rects_all: dict[str, dict[str, Any]] = {}
    stats = {"floors": len(floors), "rooms": 0, "walls": 0, "doors": 0, "windows": 0, "furniture": 0, "items": 0, "items_placed": 0}
    lo = [math.inf, math.inf, math.inf]
    hi = [-math.inf, -math.inf, -math.inf]
    for floor in floors:
        level = int(_num(floor.get("level_index"), 0) or 0)
        elevation = level * (height + FLOOR_GAP)
        rooms = sorted((r for r in all_rooms if r.get("floor_id") == floor["id"]), key=lambda r: (MT.fold(r.get("name")), r["id"]))
        rects = _layout_rooms(rooms)
        rects_all.update(rects)
        unplaced = [r.get("name") for r in rooms if not rects[r["id"]]["placed"]]
        if unplaced:
            warnings.append(f"{floor.get('name')}: sin medidas en el plano, colocadas en fila: {', '.join(str(n) for n in unplaced)}.")
        furniture = _furniture([c for c in all_containers if c.get("room_id") in rects], rects, elevation)
        walls, openings = _build_walls(rooms, rects, elevation=elevation, height=height, infer_doors=cfg["infer_doors"], furniture=furniture)
        for f in furniture:
            furniture_by_id[f["id"]] = f
        rooms_out = []
        for i, room in enumerate(rooms):
            rect = rects[room["id"]]
            w, d = rect["x1"] - rect["x0"], rect["z1"] - rect["z0"]
            room_tasks = tasks_by_target.get(("room", room["id"]), [])
            out = {"id": room["id"], "name": room.get("name") or "", "kind": room.get("kind") or None,
                   "color": room.get("color") if isinstance(room.get("color"), str) and room["color"].startswith("#") else ROOM_COLORS[i % len(ROOM_COLORS)],
                   "rect": {k: _r(rect[k]) for k in ("x0", "z0", "x1", "z1")}, "placed": rect["placed"], "width_m": _r(w), "depth_m": _r(d),
                   "area_m2": round(w * d, 2), "center": [_r((rect["x0"] + rect["x1"]) / 2), _r(elevation), _r((rect["z0"] + rect["z1"]) / 2)],
                   "items": 0, "status": _status([t["group"] for t in room_tasks]), "tasks": room_tasks,
                   "openings": sum(1 for o in openings if o["room_id"] == room["id"] or o.get("other_room_id") == room["id"])}
            rooms_out.append(out)
            room_floor[room["id"]] = {"floor": floor, "elevation": elevation, "room": out}
            for k, v in ((0, rect["x0"]), (2, rect["z0"])):
                lo[k] = min(lo[k], v - EXTERIOR_T)
            for k, v in ((0, rect["x1"]), (2, rect["z1"])):
                hi[k] = max(hi[k], v + EXTERIOR_T)
            lo[1], hi[1] = min(lo[1], elevation - SLAB), max(hi[1], elevation + height)
        auto = sum(1 for f in furniture if not f["placed"])
        if auto:
            warnings.append(f"{floor.get('name')}: {auto} mueble(s) sin sitio en el plano, colocados junto a la pared.")
        stats["rooms"] += len(rooms_out)
        stats["walls"] += len(walls)
        stats["doors"] += sum(1 for o in openings if o["kind"] == "door")
        stats["windows"] += sum(1 for o in openings if o["kind"] == "window")
        stats["furniture"] += len(furniture)
        floors_out.append({"id": floor["id"], "name": floor.get("name") or "", "level": level, "elevation": _r(elevation), "height": _r(height),
                           "rooms": rooms_out, "walls": walls, "openings": openings, "furniture": furniture})

    # where each object sits: on its piece of furniture (the outermost one) or loose on the floor of its room
    homes_by_id = {h["id"]: h for h in homes}
    floors_by_id = {f["id"]: f for f in _alive(tables.get("floors"))}
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in sorted(_alive(tables.get("items")), key=lambda r: (MT.fold(r.get("name")), r["id"])):
        where = room_floor.get(item.get("room_id"))
        if where is None:
            continue
        chain, cid, seen = [], item.get("container_id"), set()
        while cid and cid not in seen:
            seen.add(cid)
            c = containers_by_id.get(cid)
            if not c:
                break
            chain.insert(0, c)
            cid = c.get("parent_container_id")
        root = chain[0] if chain and chain[0]["id"] in furniture_by_id and chain[0].get("room_id") == item["room_id"] else None
        groups.setdefault((item["room_id"], root["id"] if root else ""), []).append({"item": item, "chain": chain, "where": where})
    for (room_id, furniture_id), members in groups.items():
        where = members[0]["where"]
        elevation = where["elevation"]
        if furniture_id:
            box = furniture_by_id[furniture_id]["box"]
            pad = 0.06
            spots = _grid(box["min"][0] + pad, box["min"][2] + pad, max(0.05, box["max"][0] - box["min"][0] - 2 * pad),
                          max(0.05, box["max"][2] - box["min"][2] - 2 * pad), len(members))
            y = box["max"][1]
        else:
            blocked = [f["box"] for f in furniture_by_id.values() if f["room_id"] == room_id]
            spots = _floor_spots(rects_all[room_id], blocked, len(members))
            y = elevation
        for member, (x, z) in zip(members, spots):
            item, chain = member["item"], member["chain"]
            item_tasks = tasks_by_target.get(("item", item["id"]), [])
            floor = where["floor"]
            path = [homes_by_id.get(floor.get("home_id"), {}).get("name"), floor.get("name"), where["room"]["name"]] + [c.get("name") for c in chain]
            photo = item.get("photo_uri")
            row = {"id": item["id"], "name": item.get("name") or "", "quantity": item.get("quantity", 1), "favorite": bool(item.get("favorite")),
                   "note": item.get("description") or None, "room_id": room_id, "room_name": where["room"]["name"], "floor_id": floor["id"],
                   "container_id": item.get("container_id"), "furniture_id": furniture_id or None,
                   "location": " › ".join(str(p) for p in path if p), "position": [_r(x), _r(y), _r(z)],
                   "status": _status([t["group"] for t in item_tasks]), "tasks": item_tasks,
                   "photo": photo if isinstance(photo, str) and photo.startswith("/photos/") else None}
            items_out.append(row)
            where["room"]["items"] += 1
    items_out.sort(key=lambda r: (MT.fold(r["name"]), r["id"]))
    stats["items"] = sum(1 for i in _alive(tables.get("items")))
    stats["items_placed"] = len(items_out)
    if stats["items"] > stats["items_placed"]:
        warnings.append(f"{stats['items'] - stats['items_placed']} objeto(s) están en habitaciones de otra vivienda o borradas y no aparecen.")

    for f in furniture_by_id.values():
        own = [t for cid in [f["id"]] + [c["id"] for c in all_containers if _root_of(c, containers_by_id) == f["id"] and c["id"] != f["id"]]
               for t in tasks_by_target.get(("container", cid), [])]
        f["tasks"] = own
        f["status"] = _status([t["group"] for t in own])
        f["items"] = sum(1 for i in items_out if i["furniture_id"] == f["id"])

    # what is due: every task that is overdue or due this month, with the spot it points at
    items_by_id = {i["id"]: i for i in items_out}
    for (kind, target), rows in tasks_by_target.items():
        for t in rows:
            if t["group"] not in ("overdue", "month"):
                continue
            anchor: dict[str, Any] = {"position": None, "room_id": None, "floor_id": None, "target_name": None}
            if kind == "item" and target in items_by_id:
                it = items_by_id[target]
                anchor = {"position": it["position"], "room_id": it["room_id"], "floor_id": it["floor_id"], "target_name": it["name"]}
            elif kind == "container":
                root = _root_of(containers_by_id.get(target) or {}, containers_by_id)
                f = furniture_by_id.get(root or "")
                if f:
                    b = f["box"]
                    anchor = {"position": [_r((b["min"][0] + b["max"][0]) / 2), b["max"][1], _r((b["min"][2] + b["max"][2]) / 2)], "room_id": f["room_id"],
                              "floor_id": room_floor[f["room_id"]]["floor"]["id"], "target_name": (containers_by_id.get(target) or {}).get("name")}
            elif kind == "room" and target in room_floor:
                room = room_floor[target]["room"]
                anchor = {"position": room["center"], "room_id": target, "floor_id": room_floor[target]["floor"]["id"], "target_name": room["name"]}
            elif kind == "home" and target == chosen["id"]:
                anchor["target_name"] = chosen.get("name")
            elif kind == "home":
                continue
            if anchor["target_name"] is None:
                continue
            alerts.append({**t, "target_kind": kind, "target_id": target, **anchor})
    alerts.sort(key=lambda t: (t["next_due"] or "9999", t["title"], t["id"]))

    bounds = None if not stats["rooms"] else {"min": [_r(v) for v in lo], "max": [_r(v) for v in hi]}
    return {**base, "home": {"id": chosen["id"], "name": chosen.get("name") or "", "kind": chosen.get("kind")}, "floors": floors_out, "items": items_out,
            "maintenance": {"overdue": sum(1 for t in alerts if t["group"] == "overdue"), "due": sum(1 for t in alerts if t["group"] == "month"),
                            "tasks": alerts},
            "warnings": warnings, "stats": stats, "bounds": bounds, "empty": not stats["rooms"],
            **({"message": "El plano de esta vivienda todavía no tiene habitaciones."} if not stats["rooms"] else {})}


def _root_of(container: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> Optional[str]:
    cid, seen, last = container.get("id"), set(), None
    while cid and cid not in seen:
        seen.add(cid)
        row = by_id.get(cid)
        if not row:
            break
        last = row["id"]
        cid = row.get("parent_container_id")
    return last


def summary(scene: dict[str, Any]) -> dict[str, Any]:
    """The scene without its geometry: what an assistant needs to talk about the house."""
    floors = [{"id": f["id"], "name": f["name"], "level": f["level"], "elevation_m": f["elevation"],
               "rooms": [{"id": r["id"], "name": r["name"], "size_m": [r["width_m"], r["depth_m"]], "area_m2": r["area_m2"], "items": r["items"],
                          "openings": r["openings"], "maintenance": r["status"]} for r in f["rooms"]],
               "walls": len(f["walls"]), "furniture": len(f["furniture"]),
               "openings": [{k: o.get(k) for k in ("id", "kind", "room_id", "room_name", "side", "offset_cm", "width_cm", "inferred", "other_room_name")}
                            for o in f["openings"]]} for f in scene["floors"]]
    return {"home": scene["home"], "homes": scene["homes"], "today": scene["today"], "settings": scene["settings"], "stats": scene["stats"],
            "bounds": scene["bounds"], "floors": floors, "maintenance": scene["maintenance"], "warnings": scene["warnings"], "url": scene["url"],
            **({"message": scene["message"]} if scene.get("message") else {})}


# ---------------------------------------------------------------------------- where is it
def locate(scene: dict[str, Any], item_id: str) -> Optional[dict[str, Any]]:
    """Where an object is in the 3D house and where to put the camera (orbit and first person) to look at it."""
    item = next((i for i in scene["items"] if i["id"] == item_id), None)
    if item is None:
        return None
    room = next((r for f in scene["floors"] for r in f["rooms"] if r["id"] == item["room_id"]), None)
    floor = next((f for f in scene["floors"] if f["id"] == item["floor_id"]), None)
    furniture = next((x for f in scene["floors"] for x in f["furniture"] if x["id"] == item["furniture_id"]), None)
    x, y, z = item["position"]
    dx, dz = (room["center"][0] - x, room["center"][2] - z) if room else (0.0, 1.0)
    dist = math.hypot(dx, dz)
    dx, dz = (dx / dist, dz / dist) if dist > 0.3 else (0.0, 1.0)
    rect = room["rect"] if room else None
    wx, wz = x + dx * 1.9, z + dz * 1.9
    if rect:
        wx = min(max(wx, rect["x0"] + 0.35), rect["x1"] - 0.35) if rect["x1"] - rect["x0"] > 0.7 else (rect["x0"] + rect["x1"]) / 2
        wz = min(max(wz, rect["z0"] + 0.35), rect["z1"] - 0.35) if rect["z1"] - rect["z0"] > 0.7 else (rect["z0"] + rect["z1"]) / 2
    elevation = floor["elevation"] if floor else 0.0
    where = item["room_name"] + (f", en {furniture['name']}" if furniture else ", en el suelo de la habitación") + (f" ({floor['name']})" if floor else "")
    return {"id": item["id"], "name": item["name"], "quantity": item["quantity"], "location": item["location"], "where": where,
            "room": {"id": room["id"], "name": room["name"]} if room else None, "floor": {"id": floor["id"], "name": floor["name"]} if floor else None,
            "furniture": {"id": furniture["id"], "name": furniture["name"]} if furniture else None, "position": item["position"],
            "status": item["status"], "tasks": item["tasks"],
            "camera": {"position": [_r(x + dx * 3.6), _r(y + 3.4), _r(z + dz * 3.6)], "target": [_r(x), _r(y + 0.15), _r(z)]},
            "walk": {"position": [_r(wx), _r(elevation + EYE), _r(wz)], "target": [_r(x), _r(y + 0.15), _r(z)]},
            "url": f"{scene['url']}?objeto={item['id']}"}
