"""The 3D house as files: binary glTF (GLB, metres, Y up) and Wavefront OBJ (millimetres at a scale, Z up, for a print
library). Standard library only. Every solid of the house is a box, so one unit cube is stored once and each wall piece,
floor slab, piece of furniture and object marker is a node that places and scales it."""
from __future__ import annotations

import hashlib
import json
import re
import struct
import unicodedata
from typing import Any, Iterator

from .house3d import SLAB

GENERATOR = "HomeHoard"
MARKER = 0.16          # side of the cube that stands for an object, metres
PART_MATERIAL = {"solid": "wall", "sill": "wall", "lintel": "wall", "glass": "glass", "door": "door"}
MATERIALS = {
    "wall": {"color": (0.92, 0.89, 0.84, 1.0), "roughness": 0.9},
    "glass": {"color": (0.55, 0.75, 0.88, 0.45), "roughness": 0.1},
    "door": {"color": (0.56, 0.40, 0.26, 1.0), "roughness": 0.7},
    "furniture": {"color": (0.69, 0.54, 0.37, 1.0), "roughness": 0.75},
    "item": {"color": (0.90, 0.57, 0.25, 1.0), "roughness": 0.5},
    "item_due": {"color": (0.83, 0.66, 0.26, 1.0), "roughness": 0.5},
    "item_overdue": {"color": (0.77, 0.27, 0.23, 1.0), "roughness": 0.5},
}
ITEM_MATERIAL = {"ok": "item", "due": "item_due", "overdue": "item_overdue"}


def slug(text: str, fallback: str = "casa") -> str:
    plain = unicodedata.normalize("NFD", str(text or "")).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:60] or fallback


def _hex_rgba(color: str, fallback: tuple[float, float, float, float] = (0.6, 0.6, 0.6, 1.0)) -> tuple[float, float, float, float]:
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        return fallback
    r, g, b = (int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    # room colours are strong on a flat plan; on a lit floor they are mixed with a light wood tone
    return (round(0.45 * r + 0.42, 4), round(0.45 * g + 0.40, 4), round(0.45 * b + 0.36, 4), 1.0)


def solids(scene: dict[str, Any], *, include_items: bool = True) -> Iterator[dict[str, Any]]:
    """Every box of the house: ``{name, group, floor, material, min, max, color?, ref?}``, in a stable order."""
    for floor in scene.get("floors", []):
        for room in floor["rooms"]:
            r, y = room["rect"], floor["elevation"]
            yield {"name": room["name"], "group": "Habitaciones", "floor": floor["name"], "material": "floor:" + room["color"].lower(),
                   "color": _hex_rgba(room["color"]), "min": [r["x0"], y - SLAB, r["z0"]], "max": [r["x1"], y, r["z1"]], "ref": ("room", room["id"])}
        for wall in floor["walls"]:
            for i, box in enumerate(wall["boxes"]):
                yield {"name": f"{wall['id']}-{box['part']}-{i + 1}", "group": "Muros", "floor": floor["name"], "material": PART_MATERIAL[box["part"]],
                       "min": box["min"], "max": box["max"], "ref": ("wall", wall["id"])}
        for f in floor["furniture"]:
            yield {"name": f["name"], "group": "Muebles", "floor": floor["name"], "material": "furniture", "min": f["box"]["min"], "max": f["box"]["max"],
                   "ref": ("container", f["id"])}
        if include_items:
            for item in scene.get("items", []):
                if item["floor_id"] != floor["id"]:
                    continue
                x, y, z = item["position"]
                h = MARKER / 2
                yield {"name": item["name"], "group": "Objetos", "floor": floor["name"], "material": ITEM_MATERIAL.get(item["status"], "item"),
                       "min": [x - h, y, z - h], "max": [x + h, y + MARKER, z + h], "ref": ("item", item["id"])}


# ---------------------------------------------------------------------------- GLB
def _unit_cube() -> tuple[bytes, bytes, bytes]:
    faces = (((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 0, 1), (0, 1, 0)), ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
             ((0, -1, 0), (1, 0, 0), (0, 0, 1)), ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (0, 1, 0), (1, 0, 0)))
    positions, normals, indices = [], [], []
    for n, u, v in faces:
        base = len(positions)
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            positions.append(tuple(0.5 * (n[k] + su * u[k] + sv * v[k]) for k in range(3)))
            normals.append(tuple(float(c) for c in n))
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return (b"".join(struct.pack("<3f", *p) for p in positions), b"".join(struct.pack("<3f", *n) for n in normals),
            struct.pack(f"<{len(indices)}H", *indices))


def build_glb(scene: dict[str, Any], *, include_items: bool = True) -> bytes:
    """Binary glTF 2.0 of the house. Nodes are named after rooms, furniture and objects and carry their HomeHoard id in
    ``extras``, so another program can tell what each box is."""
    positions, normals, indices = _unit_cube()
    blob = positions + normals + indices + b"\x00" * ((4 - len(indices) % 4) % 4)
    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": GENERATOR},
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(positions), "target": 34962},
                        {"buffer": 0, "byteOffset": len(positions), "byteLength": len(normals), "target": 34962},
                        {"buffer": 0, "byteOffset": len(positions) + len(normals), "byteLength": len(indices), "target": 34963}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3", "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]},
                      {"bufferView": 1, "componentType": 5126, "count": 24, "type": "VEC3"},
                      {"bufferView": 2, "componentType": 5123, "count": 36, "type": "SCALAR"}],
        "materials": [], "meshes": [], "nodes": [], "scenes": [{"nodes": [0]}], "scene": 0,
    }
    home = scene.get("home") or {}
    root = {"name": home.get("name") or "Casa", "children": [],
            "extras": {"homehoard": {"kind": "home", "id": home.get("id")}, "units": "m", "exported": scene.get("today")}}
    gltf["nodes"].append(root)
    mesh_of: dict[str, int] = {}
    parents: dict[tuple[str, ...], int] = {}

    def group(path: tuple[str, ...]) -> int:
        if path in parents:
            return parents[path]
        index = len(gltf["nodes"])
        gltf["nodes"].append({"name": path[-1], "children": []})
        parent = gltf["nodes"][group(path[:-1])] if len(path) > 1 else root
        parent["children"].append(index)
        parents[path] = index
        return index

    def mesh(material: str, color: Any) -> int:
        if material in mesh_of:
            return mesh_of[material]
        spec = MATERIALS.get(material, {"color": color or (0.6, 0.6, 0.6, 1.0), "roughness": 0.85})
        rgba = [round(float(c), 4) for c in (color or spec["color"])]
        mat: dict[str, Any] = {"name": material, "pbrMetallicRoughness": {"baseColorFactor": rgba, "metallicFactor": 0.0,
                                                                          "roughnessFactor": spec["roughness"]}}
        if rgba[3] < 1:
            mat["alphaMode"] = "BLEND"
        gltf["materials"].append(mat)
        gltf["meshes"].append({"name": material, "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2,
                                                                 "material": len(gltf["materials"]) - 1}]})
        mesh_of[material] = len(gltf["meshes"]) - 1
        return mesh_of[material]

    for solid in solids(scene, include_items=include_items):
        lo, hi = solid["min"], solid["max"]
        size = [max(hi[k] - lo[k], 0.001) for k in range(3)]
        node = {"name": solid["name"], "mesh": mesh(solid["material"], solid.get("color")),
                "translation": [round((lo[k] + hi[k]) / 2, 4) for k in range(3)], "scale": [round(s, 4) for s in size],
                "extras": {"homehoard": {"kind": solid["ref"][0], "id": solid["ref"][1]}}}
        parent = group((solid["floor"], solid["group"]))
        gltf["nodes"].append(node)
        gltf["nodes"][parent]["children"].append(len(gltf["nodes"]) - 1)
    for node in gltf["nodes"]:
        if node.get("children") == []:
            del node["children"]
    text = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    text += b" " * ((4 - len(text) % 4) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    return b"".join((struct.pack("<4sII", b"glTF", 2, total), struct.pack("<I4s", len(text), b"JSON"), text,
                     struct.pack("<I4s", len(blob), b"BIN\x00"), blob))


def read_glb(data: bytes) -> tuple[dict[str, Any], bytes]:
    """(JSON, binary chunk) of a GLB; raises ValueError when it is not one. Used by the tests and the export receipt."""
    if len(data) < 28 or data[:4] != b"glTF":
        raise ValueError("not a GLB")
    version, total = struct.unpack_from("<II", data, 4)
    json_len, json_kind = struct.unpack_from("<I4s", data, 12)
    if version != 2 or total != len(data) or json_kind != b"JSON":
        raise ValueError("bad GLB header")
    doc = json.loads(data[20:20 + json_len].decode("utf-8"))
    bin_len, bin_kind = struct.unpack_from("<I4s", data, 20 + json_len)
    if bin_kind != b"BIN\x00" or 28 + json_len + bin_len != total:
        raise ValueError("bad GLB chunks")
    return doc, data[28 + json_len:]


# ---------------------------------------------------------------------------- OBJ
def build_obj(scene: dict[str, Any], *, include_items: bool = False, scale: float = 100.0, mtl_name: str = "casa.mtl") -> tuple[str, str]:
    """(OBJ text, MTL text): millimetres at 1:``scale`` with Z up, the convention of print libraries."""
    k = 1000.0 / max(float(scale), 1.0)
    lines = [f"# {GENERATOR}: casa en 3D, milimetros a escala 1:{scale:g}, Z arriba", f"mtllib {mtl_name}"]
    colors: dict[str, tuple[float, ...]] = {}
    count = 0
    for i, solid in enumerate(solids(scene, include_items=include_items)):
        material = re.sub(r"[^a-z0-9_]+", "_", solid["material"].lower())
        colors.setdefault(material, tuple(solid.get("color") or MATERIALS.get(solid["material"], {"color": (0.6, 0.6, 0.6, 1.0)})["color"]))
        lo, hi = solid["min"], solid["max"]
        lines.append(f"o {slug(solid['group'])}-{slug(solid['name'], 'pieza')}-{i + 1}")
        lines.append(f"usemtl {material}")
        for x, y, z in ((lo[0], lo[1], lo[2]), (hi[0], lo[1], lo[2]), (hi[0], hi[1], lo[2]), (lo[0], hi[1], lo[2]),
                        (lo[0], lo[1], hi[2]), (hi[0], lo[1], hi[2]), (hi[0], hi[1], hi[2]), (lo[0], hi[1], hi[2])):
            lines.append(f"v {x * k:.3f} {-z * k:.3f} {y * k:.3f}")       # Y up -> Z up
        b = count + 1
        for face in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)):
            lines.append("f " + " ".join(str(b + v) for v in face))
        count += 8
    mtl = []
    for name, rgba in colors.items():
        mtl += [f"newmtl {name}", f"Kd {rgba[0]:.4f} {rgba[1]:.4f} {rgba[2]:.4f}", f"d {rgba[3] if len(rgba) > 3 else 1.0:.2f}", ""]
    return "\n".join(lines) + "\n", "\n".join(mtl) + "\n"


def receipt(data: bytes) -> dict[str, Any]:
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
