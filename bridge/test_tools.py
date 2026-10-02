import unittest

import inventory
from helpers_test import make_app, sample_records, tempdir
from homehoard_server import tools as T


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records(1_000))
        self.call = lambda tool, /, **args: T.call(self.app.ctx, tool, args)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_catalogue_follows_the_family_contract(self):
        names = [t["name"] for t in T.catalog()]
        for old in ("home_find_item", "home_inventory_status", "home_list_location"):
            self.assertIn(old, names)
        self.assertEqual(len(names), 15)
        for t in T.catalog():
            first = t["description"].splitlines()[0]
            self.assertLessEqual(len(first), 110, t["name"])
            self.assertIn("Sinónimos:", t["description"], t["name"])
            self.assertEqual(t["inputSchema"]["type"], "object")
        read_only = {t["name"] for t in T.catalog() if t["annotations"]["readOnlyHint"]}
        self.assertEqual(read_only, {"home_find_item", "home_inventory_status", "home_list_location", "home_item_papers", "home_manual_search",
                                     "maintenance_list", "maintenance_templates"})

    def test_existing_tools_read_the_live_home(self):
        found = self.call("home_find_item", query="¿Dónde está la linterna phillips?")
        self.assertEqual(found["status"], "found")
        self.assertEqual(found["matches"][0]["location"], "Piso de prueba › Planta única › Trastero › Estantería › Caja roja")
        self.assertEqual(found["matches"][0]["tags"], ["Material eléctrico"])
        listed = self.call("home_list_location", location="Trastero")
        self.assertEqual(listed["total_items"], 1)
        status = self.call("home_inventory_status")
        self.assertEqual((status["ready"], status["items"], status["source"]), (True, 3, "live"))
        self.assertEqual(self.call("home_find_item", query="taladro")["status"], "not_found")

    def test_add_update_and_move_items_through_the_merge(self):
        before = self.app.store.info()["version"]
        added = self.call("home_add_item", name="Cinta americana", location="Cajón rojo", quantity=2, tags=["Bricolaje", "material eléctrico"])
        item = added["item"]
        self.assertEqual(item["location"], "Piso de prueba › Planta única › Cocina › Cajón rojo")
        self.assertEqual(sorted(item["tags"]), ["Bricolaje", "Material eléctrico"])
        self.assertGreater(self.app.store.info()["version"], before)
        self.assertIn(("homehoard.item.added", {"id": item["id"], "title": "Cinta americana"}), self.events)
        moved = self.call("home_move_item", item="linterna", location="Cajón rojo")
        self.assertEqual(moved["from"], "Piso de prueba › Planta única › Trastero › Estantería › Caja roja")
        self.assertTrue(moved["item"]["location"].endswith("Cocina › Cajón rojo"))
        upd = self.call("home_update_item", item=item["id"], quantity=5, tags=["Bricolaje"], favorite=True, note="Gris")
        self.assertEqual((upd["item"]["quantity"], upd["item"]["tags"], upd["item"]["favorite"], upd["item"]["note"]), (5, ["Bricolaje"], True, "Gris"))
        link = self.app.store.get("itemTags", f"{item['id']}:electric")
        self.assertIsNotNone(link["deleted_at"], "the removed tag leaves a tombstone")
        self.assertEqual(self.call("home_find_item", query="linterna")["matches"][0]["location"].split(" › ")[-1], "Cajón rojo")

    def test_ambiguity_and_missing_places_are_reported(self):
        self.app.store.merge({"containers": [{"id": "redbox2", "name": "Caja roja", "room_id": "kitchen", "parent_container_id": None, "updated_at": 2_000, "deleted_at": None}]})
        with self.assertRaises(T.ToolError) as e:
            self.call("home_move_item", item="linterna", location="Caja roja")
        self.assertEqual(e.exception.code, "ambiguous")
        self.assertIn("redbox", e.exception.hint)
        with self.assertRaises(T.ToolError) as e:
            self.call("home_add_item", name="X", location="Sótano")
        self.assertEqual(e.exception.code, "not_found")
        self.assertEqual(self.call("home_item_details", item="¿está en garantía la lavadora?")["item"]["id"], "washer")
        with self.assertRaises(T.ToolError) as e:
            self.call("home_update_item", item="paraguas", name="Y")
        self.assertEqual(e.exception.code, "not_found")
        with self.assertRaises(T.ToolError) as e:
            self.call("home_find_item", query="x", extra=1)
        self.assertEqual(e.exception.code, "invalid")
        with self.assertRaises(T.ToolError) as e:
            T.call(self.app.ctx, "home_burn", {})
        self.assertEqual(e.exception.code, "unknown_tool")

    def test_item_details_get_and_set(self):
        empty = self.call("home_item_details", item="lavadora")
        self.assertFalse(empty["details"]["exists"])
        saved = self.call("home_item_details", item="lavadora", set={"brand": "Marca Demo", "model": "WX-100", "purchase_date": "2026-01-10",
                                                                      "price": 399.0, "warranty_until": "2029-01-10",
                                                                      "consumables": [{"name": "Filtro de la bomba", "spec": "Ø 40 mm", "qty": 1}]})
        self.assertEqual(saved["details"]["model"], "WX-100")
        self.assertEqual(saved["details"]["warranty_source"], "manual")
        self.assertEqual(saved["warranty"], {"until": "2029-01-10", "active": True, "days_left": 831, "source": "manual"})
        self.assertEqual(saved["details"]["consumables"][0]["spec"], "Ø 40 mm")
        with self.assertRaises(T.ToolError):
            self.call("home_item_details", item="lavadora", set={"colour": "blanco"})
        with self.assertRaises(T.ToolError):
            self.call("home_item_details", item="lavadora", set={"purchase_date": "10/01/2026"})

    def test_maintenance_from_template_done_and_lists(self):
        tpl = self.call("maintenance_templates", item="caldera")
        self.assertEqual(tpl["suggested"][0], "caldera-gas")
        boiler = next(t for t in tpl["templates"] if t["id"] == "caldera-gas")
        self.assertIn("RD 1027/2007", boiler["source"])
        added = self.call("maintenance_add", template_id="caldera-gas", target="caldera", last_done="2024-11-20")["task"]
        self.assertEqual((added["next_due"], added["basis"], added["group"]), ("2026-11-20", "law", "upcoming"))
        self.assertIn("IT 3.3", added["legal_ref"])
        radiators = self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home", target="")["task"]
        self.assertEqual(radiators["next_due"], "2026-10-02", "created in October, due this month")
        custom = self.call("maintenance_add", title="Limpiar filtro", target_kind="item", target="lavadora", every_days=30, last_done="2026-08-01")["task"]
        self.assertEqual(custom["group"], "overdue")
        listed = self.call("maintenance_list", filter="month")
        self.assertEqual([t["id"] for t in listed["tasks"]], [custom["id"], radiators["id"]])
        self.assertEqual(listed["groups"], {"overdue": 1, "month": 1, "upcoming": 0})
        self.assertEqual(self.call("maintenance_list", target="caldera")["count"], 1)
        done = self.call("maintenance_done", task="caldera", cost=95.5, who="Empresa habilitada", note="Sin incidencias")
        self.assertEqual(done["task"]["next_due"], "2028-10-02")
        self.assertEqual(done["log"]["cost"], 95.5)
        upd = self.call("maintenance_update", task=custom["id"], every_months=2, next_due="2026-12-01")["task"]
        self.assertEqual((upd["next_due"], upd["next_due_manual"], upd["interval"]), ("2026-12-01", True, "cada 2 meses"))
        back = self.call("maintenance_update", task=custom["id"], next_due="")["task"]
        self.assertEqual(back["next_due"], "2026-10-01")
        with self.assertRaises(T.ToolError):
            self.call("maintenance_add", title="Revisión", target="caldera", every_months=12, basis="law")
        with self.assertRaises(T.ToolError) as e:
            self.call("maintenance_delete", task=custom["id"])
        self.assertEqual(e.exception.code, "confirm_required")
        self.assertEqual(self.call("maintenance_delete", task=custom["id"], confirm=True)["status"], "deleted")
        self.assertEqual(self.call("maintenance_list")["count"], 2)


if __name__ == "__main__":
    unittest.main()
