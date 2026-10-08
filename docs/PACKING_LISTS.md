# Packing lists and kit checks

`home_check_list` compares a requested list with recorded quantities and locations.
It is available through the normal family HTTP contract and the stdio MCP bridge.
For example: “Do I have two torches, three USB-C cables and four AA batteries to
take on this trip? Where do I pick them up?”

## Workflow

1. Find objects with `home_find_item` or list a location. Use the returned IDs.
2. Call `home_check_list` with `requests`, a list of 1–100 objects containing
   exactly `item_id` and a positive integer `quantity`.
3. Report shortages and locations from the result. Do not substitute a similar
   object without the user's choice.
4. Pass a corrected list to check it again. The check itself does not save a list,
   reserve stock, move objects or reduce quantities.

```json
{"requests":[{"item_id":"torch","quantity":2},{"item_id":"cable","quantity":3},{"item_id":"torch","quantity":1}]}
```

The two torch entries require **three** torches in total. If recorded stock is
one torch and five cables, the result needs two more torches and no more cables.
It offers one torch and three cables to pick up, rather than counting all stock
or counting the same torch twice.

## Response

- `inventory_version`: the version of the single snapshot used for all rows.
- `ready`: true only when every recorded quantity is known and sufficient.
- `totals_complete`: false if an ID or its stock quantity cannot be resolved.
- `requested_total`: sum of requested units after combining repeated IDs.
- `to_pack_total`, `missing_total`: sums, or null when totals are incomplete.
- `items`: first-seen ID order; each row has `item_id`, `name`, `location`,
  `requested`, `available`, `to_pack`, `missing`, and `status`.

Status is `available`, `shortage`, `not_found` or `unknown_quantity`.
Missing and deleted IDs have no invented name or location. Their `available`,
`to_pack` and `missing` remain null. A known quantity of zero is different:
it produces a real shortage equal to the requested amount. Invalid requests
return the normal `invalid` tool error. No changes are made to the inventory.

Repeated calls read the current stock and locations, so a change made in the
app appears in the next result. Recorded stock is not a physical verification
that the objects still exist or work.

## Reusable kits

`home_kits` manages saved definitions through Faustus/MCP:

```json
{"action":"save","name":"Weekend trip","requests":[{"item_id":"torch","quantity":1},{"item_id":"cable","quantity":3}]}
```

Then `home_check_list({"kit":"Weekend trip"})` reads the definition and the
current stock/location in one snapshot. Its response also includes `kit.id`,
`kit.name` and `kit.updated_at`. Supply **either** `requests` or `kit`.

- `action=list` (default): names and IDs, up to 50 results with a total count.
- `action=get, kit=ID_or_unique_name`: the complete definition.
- `action=save, name, requests, kit?`: replace the full list; optional `notes`.
  Reusing the name keeps the existing ID; an identical save changes neither
  the home version nor the file. Duplicate item IDs are summed in first-seen order.
- `action=delete, kit, confirm=true`: a tombstone, retained in backups/sync.

Missing/deleted object IDs remain in the definition and produce `not_found`
with unknown quantities on a check. This supports correcting a kit later
without silently substituting another object. Renaming or correcting a kit
does not move objects, reserve them or deduct stock. Packing checkmarks and
packing-run history are not implemented.

Kits use the normal record merge (`updated_at`, tombstone wins an exact tie),
web sync and version **4** portable backups. Versions 1–3 remain importable.
The native SQLite adapter retains kit records through import/export; mobile
still exchanges JSON rather than syncing with the computer. There is no kit
editor in the web/mobile interface yet: manage definitions from Faustus.

Design references: [ZenPak's reusable gear and packing lists](https://github.com/zenpakapp/zenpak)
and [HomeInventory's inventory-linked lists](https://github.com/asdteke/HomeInventory).
No upstream code or dependency was copied. GitHub Trending did not demonstrate
a relevant home-inventory trend; these are primary product references.

## En español

Busca los IDs de los objetos y pide `home_check_list` con sus cantidades. Las
peticiones repetidas se suman; una linterna no puede cubrir dos entradas a la vez.
La respuesta indica qué recoger, qué falta y la ruta completa de cada objeto.
Los IDs desconocidos o borrados y las cantidades desconocidas son `null`, nunca
cero inventado. `ready` exige existencias registradas suficientes y conocidas.
Repite la consulta después de cambiar la lista o el inventario para comprobar
la versión actual. La comprobación no modifica el inventario. Para guardar una
plantilla reutilizable, usa `home_kits` con `action=save`, nombre y lista
completa; después `home_check_list(kit=nombre_o_id)` vuelve a comprobarla.
Las plantillas se conservan en la sincronización web y las copias versión 4;
el móvil conserva las definiciones al intercambiar JSON. Se gestionan desde
Faustus: no hay editor de kits ni progreso de preparación en la interfaz.

## References

The workflow draws on equipment-library and packing-list patterns documented by
[ZenPak](https://github.com/zenpakapp/zenpak) and inventory-linked lists in
[HomeInventory](https://github.com/asdteke/HomeInventory). This implementation is
original; no upstream code or assets are included.
