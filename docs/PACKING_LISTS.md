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
`kit.name` and `kit.updated_at`. Supply exactly one of `requests`, `kit` or `kits`.

- `action=list` (default): names and IDs, up to 50 results with a total count.
- `action=get, kit=ID_or_unique_name`: the complete definition.
- `action=save, name, requests, kit?`: replace the full list; optional `notes`.
  Reusing the name keeps the existing ID; an identical save changes neither
  the home version nor the file. Duplicate item IDs are summed in first-seen order.
- `action=delete, kit, confirm=true`: a tombstone, retained in backups/sync.

Missing/deleted object IDs remain in the definition and produce `not_found`
with unknown quantities on a check. This supports correcting a kit later
without silently substituting another object. Renaming or correcting a kit
does not move objects, reserve them or deduct stock. The connected web editor
has temporary collection checkmarks; no packing-run history is stored.

Kits use the normal record merge (`updated_at`, tombstone wins an exact tie),
web sync and version **4** portable backups. Versions 1–3 remain importable.
The native SQLite adapter retains kit records through import/export; mobile
still exchanges JSON rather than syncing with the computer. In the connected
web app, Home → **Prepare a kit** opens `/kits`. Search inventory objects, edit
quantities and notes, save or reopen a kit, and check the draft without saving.
The result shows the current recorded stock, deficits and full locations.
Collection checkmarks count the available units, including the available part
of a shortage. Missing objects cannot be marked as collected. A new check or
edited requirements resets the marks; stock and saved definitions stay intact.
The editor needs the computer connection and says so when it is unavailable.

### Preparing several saved kits together

Use `home_check_list({"kits":["Weekend trip","Emergency bag"]})` to combine
1–50 saved kit IDs or exact unique names. All definitions and stock come from
one snapshot. Shared object quantities are added **before** checking stock:
two torches for a trip plus one for emergencies need three in total, so a stock
of two leaves one missing even though either kit is individually ready.

Each resolved kit counts once, including when referenced by both ID and name.
Response `kits` contains IDs, names and update times; each item row adds `kits`
with the quantity requested by each contributing kit. Items remain in first-seen
order. Each saved definition keeps its existing 100-row limit; the combined
check can contain more than 100 distinct objects. An absent, deleted or ambiguous
kit fails the whole request; unknown objects/stock keep the existing null rules.

In `/kits`, choose **Combinar kits**, mark saved kits and **Comprobar selección**.
The result shows the combined shortage, locations and the contribution of each
kit. It uses saved versions, preserves an unsaved editor draft when returning,
and resets the result and temporary collection marks when the selection changes.
The check creates no reservation, saved combination or packing history.

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
Faustus o desde Inicio → **Preparar un kit** en la web conectada. El editor
permite buscar objetos, ajustar cantidades y notas, guardar listas y comprobar
existencias y ubicaciones. Las marcas de recogida son temporales: no descuentan
stock y se reinician al cambiar lo solicitado o volver a comprobar. El móvil
nativo conserva el intercambio JSON; el editor necesita el ordenador conectado.

Para preparar varios kits a la vez, **Combinar kits** permite marcar los
guardados y comprobar la selección. `home_check_list(kits=[id_o_nombre,...])`
suma sus necesidades contra las mismas existencias y muestra cuánto pide cada
kit. Un kit repetido, incluso por ID y nombre, cuenta una sola vez. Se usan
las definiciones guardadas; el borrador del editor se conserva al volver.

## References

The workflow draws on equipment-library and packing-list patterns documented by
[ZenPak](https://github.com/zenpakapp/zenpak) and inventory-linked lists in
[HomeInventory](https://github.com/asdteke/HomeInventory). This implementation is
original; no upstream code or assets are included. The connected editor also
uses the reusable-kit pattern documented in the [official asset-management
feature list](https://snipeitapp.com/product), without importing its code or
introducing asset assignment or checkout in HomeHoard.

Combined demand is informed by the [official Grocy meal-plan workflow](https://github.com/grocy/grocy-docs/blob/master/tutorials/cooking.md)
and [InvenTree's bill-of-materials stock checks](https://docs.inventree.org/en/latest/manufacturing/build/).
HomeHoard implements only a read-only check of household equipment needs, with
no consumption, allocation, purchase workflow or imported upstream code.
