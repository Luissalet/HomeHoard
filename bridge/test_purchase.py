import dataclasses
import json
import unittest
import urllib.error
import urllib.request

import inventory
from helpers_test import Running, make_app, rec, sample_records, tempdir
from homehoard_server import agenda as AG
from homehoard_server import tools as T


class PurchaseToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records(1_000))
        self.links: list[tuple] = []
        self.ctx = dataclasses.replace(self.app.ctx, refs=lambda *a, **k: self.links.append((a, k)) or {"ok": True}, background=lambda fn: fn())

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def call(self, **args):
        return T.call(self.ctx, "item_add_from_purchase", args)

    def created(self):
        return [d for t, d in self.events if t == "homehoard.item.created"]

    def test_the_tool_is_in_the_catalogue_and_writes(self):
        tool = next(t for t in T.TOOLS if t.name == "item_add_from_purchase")
        self.assertFalse(tool.read_only)
        self.assertLessEqual(len(tool.description.splitlines()[0]), 110)
        self.assertIn("Sinónimos:", tool.description)

    def test_a_purchase_with_a_place_is_filed_with_its_card_and_announced(self):
        out = self.call(name="Aspiradora Demo", source_ref="hoard://hub/purchase/12", price=129.9, merchant="Tienda Demo", date="2026-09-28",
                        room="Cocina", place="Cajón rojo", warranty_ref="hoard://kafka/document/d_invoice")
        self.assertTrue(out["ok"])
        self.assertEqual((out["status"], out["placed"]), ("created", "given"))
        self.assertTrue(out["url"].endswith("/item/" + out["item_id"]))
        item = self.app.store.get("items", out["item_id"])
        self.assertEqual((item["room_id"], item["container_id"]), ("kitchen", "drawer"))
        card = T.call(self.ctx, "home_item_details", {"item": out["item_id"]})["details"]
        self.assertEqual((card["store"], card["price"], card["purchase_date"]), ("Tienda Demo", 129.9, "2026-09-28"))
        self.assertEqual((card["source_ref"], card["warranty_ref"]), ("hoard://hub/purchase/12", "hoard://kafka/document/d_invoice"))
        self.assertEqual(card["kafka_doc_ids"], ["d_invoice"], "a Kafka paper is linked so warranty questions find it")
        self.assertEqual(self.created(), [{"item_id": out["item_id"], "source_ref": "hoard://hub/purchase/12"}])
        (args, kw), = self.links
        self.assertEqual(args, (f"hoard://homehoard/item/{out['item_id']}", "hoard://hub/purchase/12", "from_purchase"))
        self.assertEqual(kw["from_label"], "Aspiradora Demo")

    def test_the_place_can_be_a_full_path_or_only_a_room(self):
        a = self.call(name="Tijeras", room="Cocina › Cajón rojo")
        self.assertEqual(self.app.store.get("items", a["item_id"])["container_id"], "drawer")
        b = self.call(name="Pilas", room="Trastero")
        item = self.app.store.get("items", b["item_id"])
        self.assertEqual((item["room_id"], item["container_id"]), ("storage", None))

    def test_without_a_place_it_waits_in_a_room_made_for_it(self):
        out = self.call(name="Router Demo")
        self.assertEqual(out["placed"], "inbox")
        self.assertNotIn("warning", out)
        rooms = [r for r in self.app.store.alive("rooms") if r["name"] == T.INBOX_ROOM]
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0]["floor_id"], "floor")
        self.assertEqual(self.app.store.get("items", out["item_id"])["room_id"], rooms[0]["id"])
        self.call(name="Otro objeto")
        self.assertEqual(len([r for r in self.app.store.alive("rooms") if r["name"] == T.INBOX_ROOM]), 1, "the room is reused")

    def test_a_place_that_does_not_resolve_is_never_a_lost_purchase(self):
        out = self.call(name="Lámpara", room="Garaje inexistente")
        self.assertEqual(out["placed"], "inbox")
        self.assertIn("warning", out)
        self.assertTrue(self.app.store.get("items", out["item_id"]))

    def test_the_same_purchase_twice_creates_one_object(self):
        first = self.call(name="Cafetera Demo", source_ref="hoard://hub/purchase/7", price=50)
        again = self.call(name="cafetera demo", source_ref="hoard://hub/purchase/7")
        self.assertEqual((again["status"], again["item_id"]), ("existing", first["item_id"]))
        self.assertEqual(len(self.created()), 1)
        other = self.call(name="Cafetera Demo", source_ref="hoard://hub/purchase/8")
        self.assertEqual(other["status"], "created")

    def test_bad_input_is_refused_without_writing(self):
        before = len(self.app.store.alive("items"))
        for bad in ({"name": "X", "source_ref": "https://example.com"}, {"name": "X", "price": "mucho"}, {"name": "X", "price": -3},
                    {"name": "X", "date": "ayer"}, {"name": "X", "warranty_ref": "d_123"}, {}):
            with self.assertRaises(T.ToolError, msg=str(bad)):
                self.call(**bad)
        self.assertEqual(len(self.app.store.alive("items")), before)
        self.assertEqual(self.created(), [])

    def test_a_datetime_and_a_decimal_comma_are_accepted(self):
        out = self.call(name="Tostadora", price="19,95", date="2026-09-30T08:15:00")
        card = T.call(self.ctx, "home_item_details", {"item": out["item_id"]})["details"]
        self.assertEqual((card["price"], card["purchase_date"]), (19.95, "2026-09-30"))

    def test_without_any_home_it_asks_for_one(self):
        tmp = tempdir()
        try:
            app, *_ = make_app(tmp.name, mirror=False)
            with self.assertRaises(T.ToolError) as ctx:
                T.call(app.ctx, "item_add_from_purchase", {"name": "Algo"})
            self.assertEqual(ctx.exception.code, "no_home")
        finally:
            inventory.use_store(None)
            tmp.cleanup()

    def test_a_failing_hub_does_not_break_the_tool(self):
        def boom(*a, **k):
            raise RuntimeError("hub down")
        ctx = dataclasses.replace(self.ctx, refs=boom)
        out = T.call(ctx, "item_add_from_purchase", {"name": "Radio", "source_ref": "hoard://hub/purchase/3"})
        self.assertTrue(out["ok"])

    def test_home_add_item_also_announces_creation(self):
        T.call(self.ctx, "home_add_item", {"name": "Martillo", "location": "Trastero"})
        self.assertEqual(len(self.created()), 1)
        self.assertEqual(self.created()[0]["source_ref"], "")


class WebFormAnnounceTest(unittest.TestCase):
    """An object filed from the web form (not the tool) is announced once too."""

    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records(1_000))
        self.links: list[tuple] = []
        self.app.ctx.refs = lambda *a, **k: self.links.append((a, k)) or {"ok": True}
        self.app.ctx.background = lambda fn: fn()

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def created(self):
        return [d for t, d in self.events if t == "homehoard.item.created"]

    def push(self, **card):
        t = 9_000_000_000_000 + len(self.events)
        item = rec("n1", "Taladro Demo", t, household_id="hh", room_id="storage", container_id=None, quantity=1, photo_uri=None, favorite=0)
        details = rec("n1", "", t, item_id="n1", kafka_doc_ids=[], consumables=[], **card)
        return self.app.store.merge({"items": [item], "item_details": [details]}, mode="sync", origin="app")

    def test_a_form_purchase_is_announced_once_and_linked(self):
        self.push(source_ref="hoard://hub/purchase/5", store="Tienda Demo")
        self.assertEqual(self.created(), [{"item_id": "n1", "source_ref": "hoard://hub/purchase/5"}])
        self.assertEqual(self.links[0][0], ("hoard://homehoard/item/n1", "hoard://hub/purchase/5", "from_purchase"))
        self.push(source_ref="hoard://hub/purchase/5", store="Otra tienda")
        self.assertEqual(len(self.created()), 1, "editing the card later does not announce it again")

    def test_an_ordinary_object_or_card_is_not_announced_by_the_sync(self):
        self.push(store="Tienda Demo")
        self.assertEqual(self.created(), [])

    def test_what_the_tool_announced_is_not_announced_again_when_the_web_pushes_it_back(self):
        tool = T.call(self.app.ctx, "item_add_from_purchase", {"name": "Sierra", "source_ref": "hoard://hub/purchase/6"})
        self.assertEqual(len(self.created()), 1)
        card = self.app.store.get("item_details", tool["item_id"])
        self.app.store.merge({"item_details": [{**card, "notes": "afilada", "updated_at": card["updated_at"] + 10}]}, mode="sync", origin="app")
        self.assertEqual(len(self.created()), 1)


class AgendaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records(1_000))
        self.call = lambda tool, /, **args: T.call(self.app.ctx, tool, args)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def items(self, a, b):
        from datetime import date
        return AG.build_items(self.app.ctx, date.fromisoformat(a), date.fromisoformat(b))

    def test_tasks_are_listed_by_their_day_with_basis_and_link(self):
        law = self.call("maintenance_add", template_id="caldera-gas", target="caldera", last_done="2025-10-10")["task"]
        advice = self.call("maintenance_add", template_id="filtro-campana", target="lavadora")["task"]
        got = {i["id"]: i for i in self.items("2026-10-01", "2027-12-31")}
        self.assertIn(f"homehoard:maintenance:{law['id']}", got)
        item = got[f"homehoard:maintenance:{law['id']}"]
        self.assertEqual((item["kind"], item["all_day"], item["priority"], item["start"]), ("maintenance", True, "high", law["next_due"]))
        self.assertIn("caldera de gas", item["title"].lower())
        self.assertTrue(item["url"].endswith(f"/maintenance?task={law['id']}"))
        self.assertEqual(got[f"homehoard:maintenance:{advice['id']}"]["priority"], "normal")

    def test_overdue_tasks_are_listed_paused_and_deleted_are_not(self):
        old = self.call("maintenance_add", template_id="caldera-gas", target="caldera", last_done="2020-01-01")["task"]
        paused = self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")["task"]
        gone = self.call("maintenance_add", template_id="filtro-campana", target="lavadora")["task"]
        self.app.store.put("maintenance_tasks", {**self.app.store.get("maintenance_tasks", paused["id"]), "paused": 1})
        self.call("maintenance_delete", task=gone["id"], confirm=True)
        ids = [i["id"] for i in self.items("2026-10-02", "2026-10-09")]
        self.assertEqual(ids, [f"homehoard:maintenance:{old['id']}"], "overdue is listed whatever the window, with high priority")
        self.assertEqual(self.items("2026-10-02", "2026-10-09")[0]["priority"], "high")

    def test_the_http_route_needs_the_token(self):
        task = self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")["task"]
        with Running(self.app) as base:
            url = base + "/api/family/agenda?from=2026-10-01&to=2026-10-31"
            with self.assertRaises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(url)
            self.assertEqual(err.exception.code, 401)
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + self.app.token})) as r:
                body = json.load(r)
        self.assertTrue(body["ok"])
        self.assertEqual([i["id"] for i in body["items"]], [f"homehoard:maintenance:{task['id']}"])
        self.assertEqual(body["items"][0]["kind"], "maintenance")


class ManifestTest(unittest.TestCase):
    def test_the_manifest_declares_the_agenda(self):
        from pathlib import Path
        manifest = json.loads((Path(__file__).resolve().parent.parent / "faustus-plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["x-family"], {"agenda": True})
        self.assertIn("purchase-intake", manifest["capabilities"])


if __name__ == "__main__":
    unittest.main()
