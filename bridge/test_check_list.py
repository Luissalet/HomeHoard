import json
import unittest

import inventory
from helpers_test import Running, make_app, sample_records, tempdir
from homehoard_server import tools as T
from test_http_sync import get, post


class CheckListTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records())

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def check(self, requests):
        return T.call(self.app.ctx, "home_check_list", {"requests": requests})

    def test_repeated_requirements_compete_for_the_same_stock_without_writes(self):
        tape = T.call(self.app.ctx, "home_add_item", {"name": "Cinta", "location": "drawer", "quantity": 4})["item"]["id"]
        before = self.app.store.client_state()
        file = self.app.paths.state
        original = (file.read_bytes(), file.stat().st_mtime_ns)
        events = list(self.events)
        result = self.check([{"item_id": "torch", "quantity": 2}, {"item_id": tape, "quantity": 3}, {"item_id": "torch", "quantity": 1}])
        self.assertFalse(result["ready"])
        self.assertEqual((result["requested_total"], result["to_pack_total"], result["missing_total"]), (6, 4, 2))
        torch, other = result["items"]
        self.assertEqual((torch["requested"], torch["available"], torch["to_pack"], torch["missing"]), (3, 1, 1, 2))
        self.assertEqual(torch["location"], "Piso de prueba › Planta única › Trastero › Estantería › Caja roja")
        self.assertEqual((other["item_id"], other["missing"], other["location"]), (tape, 0, "Piso de prueba › Planta única › Cocina › Cajón rojo"))
        self.assertEqual(self.app.store.client_state(), before)
        self.assertEqual((file.read_bytes(), file.stat().st_mtime_ns), original)
        self.assertEqual(self.events, events)
        self.assertEqual(self.kafka.calls, [])

    def test_absent_deleted_and_unknown_stock_are_not_invented_as_zero(self):
        self.app.store.put("items", {**self.app.store.get("items", "washer"), "deleted_at": self.app.ctx.now_ms()})
        self.app.store.put("items", {**self.app.store.get("items", "torch"), "quantity": None})
        self.app.store.put("items", {**self.app.store.get("items", "boiler"), "quantity": 0})
        result = self.check([{"item_id": id, "quantity": 2} for id in ("missing", "washer", "torch", "boiler")])
        self.assertFalse(result["ready"])
        self.assertFalse(result["totals_complete"])
        self.assertIsNone(result["missing_total"])
        self.assertIsNone(result["to_pack_total"])
        self.assertEqual([r["status"] for r in result["items"]], ["not_found", "not_found", "unknown_quantity", "shortage"])
        for row in result["items"][:3]:
            self.assertIsNone(row["available"])
            self.assertIsNone(row["missing"])
        self.assertIsNone(result["items"][1]["name"])
        self.assertEqual((result["items"][3]["available"], result["items"][3]["missing"]), (0, 2))

    def test_repeat_then_recheck_changed_quantities_and_nested_location(self):
        request = [{"item_id": "torch", "quantity": 3}]
        first = self.check(request)
        self.assertEqual(self.check(request), first)
        T.call(self.app.ctx, "home_update_item", {"item": "torch", "quantity": 5})
        T.call(self.app.ctx, "home_move_item", {"item": "torch", "location": "drawer"})
        latest = self.check(request)
        self.assertTrue(latest["ready"])
        self.assertGreater(latest["inventory_version"], first["inventory_version"])
        self.assertEqual((latest["items"][0]["available"], latest["missing_total"], latest["to_pack_total"]), (5, 0, 3))
        self.assertTrue(latest["items"][0]["location"].endswith("Cocina › Cajón rojo"))

    def test_invalid_requests_fail_without_changing_inventory(self):
        before = self.app.store.client_state()
        cases = [[], [None], [{"item_id": "torch"}], [{"item_id": "", "quantity": 1}],
                 [{"item_id": "torch", "quantity": 1, "extra": "x"}], [{"item_id": "torch", "quantity": 1}] * 101]
        cases.extend([[{"item_id": "torch", "quantity": q}] for q in (True, False, 0, -1, 1.5, "2")])
        for request in cases:
            with self.subTest(request=request), self.assertRaises(T.ToolError) as caught:
                self.check(request)
            self.assertEqual(caught.exception.code, "invalid")
        self.assertEqual(self.app.store.client_state(), before)

    def test_real_http_catalog_and_tool_preserve_the_home(self):
        before = self.app.store.client_state()
        with Running(self.app) as base:
            _, _, raw = get(base + "/api/agent/tools")
            tool = next(t for t in json.loads(raw)["tools"] if t["name"] == "home_check_list")
            self.assertTrue(tool["annotations"]["readOnlyHint"])
            self.assertTrue(tool["annotations"]["idempotentHint"])
            status, result = post(base + "/api/agent/call", {"name": tool["name"], "arguments": {"requests": [{"item_id": "torch", "quantity": 1}]}},
                                  {"Authorization": "Bearer " + self.app.token})
            self.assertEqual(status, 200)
            self.assertTrue(result["ready"])
            self.assertEqual(result["items"][0]["item_id"], "torch")
        self.assertEqual(self.app.store.client_state(), before)


if __name__ == "__main__":
    unittest.main()
