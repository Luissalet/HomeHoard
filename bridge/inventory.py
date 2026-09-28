"""Read-only, local inventory snapshot used by Faustus."""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path

SNAPSHOT = Path(os.environ.get("HOMEHOARD_SNAPSHOT") or Path(__file__).resolve().parent.parent / "data" / "faustus-inventory.json")
STOP = {"donde", "esta", "estan", "tengo", "guardado", "guardada", "guardados", "guardadas", "puse", "deje", "hay", "el", "la", "los", "las", "un", "una", "mi", "mis", "que", "en", "de", "por", "favor"}
TABLES = ("households", "homes", "floors", "rooms", "containers", "items", "tags", "itemTags")


def normalized(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", value.lower()) if unicodedata.category(c) != "Mn")


def terms(query: str) -> list[str]:
    return [word for word in re.findall(r"[\w]+", normalized(query)) if word not in STOP]


def one_edit(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1:
        return False
    i = j = errors = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1; j += 1; continue
        errors += 1
        if errors > 1:
            return False
        if len(a) > len(b): i += 1
        elif len(b) > len(a): j += 1
        else: i += 1; j += 1
    return errors + len(a) - i + len(b) - j <= 1


def validate(bundle: object) -> dict:
    if not isinstance(bundle, dict) or bundle.get("format") != "homehoard-export" or bundle.get("version") not in (1, 2):
        raise ValueError("El archivo no es una copia de HomeHoard")
    data = bundle.get("data")
    if not isinstance(data, dict) or any(not isinstance(data.get(table), list) for table in TABLES):
        raise ValueError("La copia no contiene un inventario válido")
    clean = {table: data[table] for table in TABLES}
    for table in TABLES:
        if any(not isinstance(row, dict) for row in clean[table]):
            raise ValueError("La copia contiene registros inválidos")
    clean["items"] = [{**item, "photo_uri": None} for item in clean["items"]]
    return {"format": "homehoard-faustus-snapshot", "exported_at": bundle.get("exported_at"), "data": clean}


def save(bundle: object) -> dict:
    snapshot = validate(bundle)
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    pending = SNAPSHOT.with_suffix(".tmp")
    pending.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    pending.replace(SNAPSHOT)
    return status()


def load() -> dict | None:
    if not SNAPSHOT.exists():
        return None
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def status() -> dict:
    snapshot = load()
    if snapshot is None:
        return {"ready": False, "items": 0, "exported_at": None}
    return {"ready": True, "items": sum(i.get("deleted_at") is None for i in snapshot["data"]["items"]), "exported_at": snapshot.get("exported_at")}


def find(query: str, limit: int = 5) -> dict:
    snapshot = load()
    if snapshot is None:
        return {"status": "no_snapshot", "message": "HomeHoard no tiene una copia local para Faustus. Exporta una copia y cárgala en el puente local.", "matches": []}
    words = terms(query)
    if not words:
        return {"status": "empty_query", "message": "Indica el nombre del objeto que buscas.", "matches": [], "exported_at": snapshot.get("exported_at")}
    data = snapshot["data"]
    lookup = {table: {row.get("id"): row for row in data[table] if row.get("deleted_at") is None} for table in ("homes", "floors", "rooms", "containers")}
    tags = {row.get("id"): row.get("name", "") for row in data["tags"] if row.get("deleted_at") is None}
    item_tags: dict[str, list[str]] = {}
    for relation in data["itemTags"]:
        tag = tags.get(relation.get("tag_id"))
        if tag:
            item_tags.setdefault(relation.get("item_id"), []).append(tag)
    matches = []
    for item in data["items"]:
        if item.get("deleted_at") is not None:
            continue
        room = lookup["rooms"].get(item.get("room_id"))
        if not room:
            continue
        floor = lookup["floors"].get(room.get("floor_id"))
        home = lookup["homes"].get(floor.get("home_id")) if floor else None
        route = [r["name"] for r in (home, floor, room) if r]
        chain = []
        cid = item.get("container_id")
        seen = set()
        while cid and cid not in seen:
            seen.add(cid)
            container = lookup["containers"].get(cid)
            if not container:
                break
            chain.insert(0, container["name"])
            cid = container.get("parent_container_id")
        route.extend(chain)
        name = normalized(str(item.get("name", "")))
        note = normalized(str(item.get("description") or ""))
        location = normalized(" ".join(route))
        item_tag_names = item_tags.get(item.get("id"), [])
        tag_texts = [normalized(tag) for tag in item_tag_names]
        score = 0
        for word in words:
            points = 0
            if word == name: points = 100
            elif word in name.split(): points = 80
            elif word in name: points = 65
            elif len(word) >= 5 and any(one_edit(piece, word) for piece in name.split()): points = 45
            elif any(word == tag or word in tag.split() for tag in tag_texts): points = 50
            elif any(word in tag for tag in tag_texts): points = 40
            elif word in note: points = 20
            elif word in location: points = 15
            if not points:
                break
            score += points
        else:
            matches.append((score, {"id": item.get("id"), "name": item.get("name"), "quantity": item.get("quantity", 1), "location": " › ".join(route), "note": item.get("description") or None, "tags": item_tag_names}))
    matches.sort(key=lambda match: (-match[0], normalized(str(match[1]["name"]))))
    found = [match for _, match in matches[:max(1, min(limit, 20))]]
    return {"status": "found" if found else "not_found", "query": query, "matches": found, "exported_at": snapshot.get("exported_at"), "message": "Objeto no encontrado en la copia local de HomeHoard." if not found else None}


def list_location(location: str, offset: int = 0, limit: int = 50) -> dict:
    """List the complete contents of one room or container, with pagination."""
    snapshot = load()
    if snapshot is None:
        return {"status": "no_snapshot", "locations": [], "items": []}
    if not isinstance(location, str) or not location.strip():
        return {"status": "empty_location", "locations": [], "items": []}
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("offset debe ser >= 0 y limit debe estar entre 1 y 100")

    data = snapshot["data"]
    active = lambda table: {row.get("id"): row for row in data[table] if row.get("deleted_at") is None}
    homes, floors, rooms, containers = (active(table) for table in ("homes", "floors", "rooms", "containers"))
    def room_path(room):
        floor = floors.get(room.get("floor_id"))
        home = homes.get(floor.get("home_id")) if floor else None
        return " › ".join(row["name"] for row in (home, floor, room) if row)

    def container_path(container):
        room = rooms.get(container.get("room_id"))
        if room is None:
            return None
        chain, seen, current = [], set(), container
        while current is not None:
            cid = current.get("id")
            if cid in seen or current.get("room_id") != room.get("id"):
                return None
            seen.add(cid)
            chain.insert(0, current["name"])
            parent_id = current.get("parent_container_id")
            current = containers.get(parent_id) if parent_id else None
            if parent_id and current is None:
                return None
        return room_path(room) + " › " + " › ".join(chain)

    choices = ([{"id": row["id"], "kind": "room", "name": row["name"], "path": room_path(row), "room_id": row["id"]} for row in rooms.values()] +
               [{"id": row["id"], "kind": "container", "name": row["name"], "path": path, "room_id": row["room_id"]}
                for row in containers.values() if (path := container_path(row))])
    needle = normalized(location.strip())
    matched = [choice for choice in choices if choice["id"] == location or normalized(choice["path"]) == needle]
    if not matched:
        matched = [choice for choice in choices if normalized(choice["name"]) == needle]
    if not matched:
        matched = [choice for choice in choices if needle in normalized(choice["path"])]
    if not matched:
        words = [word for word in terms(location) if word not in {"del", "al", "dentro", "contenido", "contenidos", "todo", "todos"}]
        if words:
            matched = [choice for choice in choices if all(word in normalized(choice["path"]).split() for word in words)]
            named = [choice for choice in matched if all(word in words for word in normalized(choice["name"]).split())]
            if named:
                longest = max(len(normalized(choice["name"]).split()) for choice in named)
                named = [choice for choice in named if len(normalized(choice["name"]).split()) == longest]
                deepest = max(choice["path"].count(" › ") for choice in named)
                matched = [choice for choice in named if choice["path"].count(" › ") == deepest]
    if not matched:
        return {"status": "not_found", "locations": [], "items": [], "exported_at": snapshot.get("exported_at")}
    if len(matched) != 1:
        return {"status": "ambiguous", "locations": matched[:20], "items": [], "exported_at": snapshot.get("exported_at")}

    selected = matched[0]
    def inside(item):
        if item.get("room_id") != selected["room_id"]:
            return False
        if selected["kind"] == "room":
            return True
        cid, seen = item.get("container_id"), set()
        while cid and cid not in seen:
            if cid == selected["id"]:
                return True
            seen.add(cid)
            parent = containers.get(cid)
            cid = parent.get("parent_container_id") if parent else None
        return False

    items = []
    for item in data["items"]:
        if item.get("deleted_at") is not None or not inside(item):
            continue
        container = containers.get(item.get("container_id"))
        path = container_path(container) if container else room_path(rooms[selected["room_id"]])
        if path is None:
            continue
        items.append({"id": item.get("id"), "name": item.get("name"), "quantity": item.get("quantity", 1), "location": path})
    items.sort(key=lambda item: (normalized(str(item["name"])), str(item["id"])))
    return {"status": "found", "location": selected, "total_items": len(items),
            "total_quantity": sum(item["quantity"] for item in items), "offset": offset,
            "items": items[offset:offset + limit], "exported_at": snapshot.get("exported_at")}
