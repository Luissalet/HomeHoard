"""The shape of the home: tables, record normalisation and the export bundles (versions 1–4)."""
from __future__ import annotations

import json
from typing import Any, Optional

LEGACY_TABLES = ("households", "homes", "floors", "rooms", "containers", "items", "tags", "itemTags")
NEW_TABLES = ("item_details", "maintenance_tasks", "maintenance_log", "packing_kits")
TABLES = LEGACY_TABLES + NEW_TABLES
BUNDLE_FORMAT = "homehoard-export"
BUNDLE_VERSIONS = (1, 2, 3, 4)
JSON_FIELDS = {"item_details": ("kafka_doc_ids", "consumables"), "packing_kits": ("requests",)}


def link_id(item_id: Any, tag_id: Any) -> str:
    """Item-tag links have a deterministic id, so the same link made on two devices is one record."""
    return f"{item_id}:{tag_id}"


def _ms(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def normalize(table: str, row: Any, fallback_ts: int = 0) -> Optional[dict[str, Any]]:
    """One record ready to merge, or None when it cannot be one. Every record gets ``id``, ``updated_at`` and
    ``deleted_at``; links get their deterministic id; JSON columns stored as text by the phone become lists."""
    if not isinstance(row, dict):
        return None
    rec = dict(row)
    if table == "itemTags":
        if not rec.get("item_id") or not rec.get("tag_id"):
            return None
        rec["id"] = link_id(rec["item_id"], rec["tag_id"])
    elif table == "item_details":
        rec["id"] = str(rec.get("id") or rec.get("item_id") or "")
        rec["item_id"] = rec["id"]
    if not isinstance(rec.get("id"), str) or not rec["id"] or len(rec["id"]) > 200:
        return None
    updated = _ms(rec.get("updated_at"))
    rec["updated_at"] = updated if updated is not None else int(fallback_ts or 0)
    rec["deleted_at"] = _ms(rec.get("deleted_at"))
    if rec.get("created_at") is not None:
        rec["created_at"] = _ms(rec.get("created_at"))
    for field in JSON_FIELDS.get(table, ()):
        value = rec.get(field)
        if isinstance(value, str):
            try:
                value = json.loads(value or "[]")
            except ValueError:
                value = []
        rec[field] = value if isinstance(value, list) else []
    if table == "packing_kits":
        requests = rec["requests"]
        if not isinstance(rec.get("name"), str) or not rec["name"].strip() or not 1 <= len(requests) <= 100:
            return None
        for entry in requests:
            if (not isinstance(entry, dict) or set(entry) != {"item_id", "quantity"}
                    or not isinstance(entry.get("item_id"), str) or not entry["item_id"].strip()
                    or type(entry.get("quantity")) is not int or not 1 <= entry["quantity"] <= 9007199254740991):
                return None
    return rec


def records_from_bundle(bundle: Any) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str], int]:
    """(records per table, photos {item_id: data URL}, exported_at) from an export of any version.

    Versions 1 and 2 had no ids, times or tombstones on item-tag links: each link takes the time of its item, so a link
    is never newer than what the device knew when it exported."""
    if not isinstance(bundle, dict) or bundle.get("format") != BUNDLE_FORMAT or bundle.get("version") not in BUNDLE_VERSIONS:
        raise ValueError("El archivo no es una copia de HomeHoard")
    data = bundle.get("data")
    if not isinstance(data, dict) or any(not isinstance(data.get(t), list) for t in LEGACY_TABLES):
        raise ValueError("La copia no contiene un inventario válido")
    if bundle.get("version") == 4 and not isinstance(data.get("packing_kits"), list):
        raise ValueError("La copia versión 4 no contiene la tabla de kits; no se ha restaurado.")
    for table in TABLES:
        rows = data.get(table) or []
        if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
            raise ValueError("La copia contiene registros inválidos")
    exported = _ms(bundle.get("exported_at")) or 0
    item_times = {r.get("id"): _ms(r.get("updated_at")) or exported for r in data["items"]}
    out: dict[str, list[dict[str, Any]]] = {}
    for table in TABLES:
        rows = []
        for row in data.get(table) or []:
            fallback = item_times.get(row.get("item_id"), exported) if table == "itemTags" else exported
            rec = normalize(table, row, fallback)
            if rec is None and table == "packing_kits":
                raise ValueError("La copia contiene un kit inválido; no se ha restaurado.")
            if rec is not None:
                rows.append(rec)
        out[table] = rows
    photos = bundle.get("photos") if isinstance(bundle.get("photos"), dict) else {}
    return out, {str(k): v for k, v in photos.items() if isinstance(v, str)}, exported
