import base64
import unittest

import inventory
from helpers_test import make_app, rec, sample_records, tempdir
from homehoard_server import tools as T


class KafkaLinkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name)
        self.app.store.merge(sample_records(1_000))
        self.call = lambda tool, /, **args: T.call(self.app.ctx, tool, args)
        self.mirror = self.app.mirror

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_each_task_becomes_one_kafka_deadline_with_its_basis(self):
        task = self.call("maintenance_add", template_id="caldera-gas", target="caldera", last_done="2024-11-20")["task"]
        out = self.mirror.run_once()
        self.assertEqual(out["sent"], 1)
        dl = self.kafka.deadlines[("homehoard", task["id"])]
        self.assertEqual(dl["title"], "Mantenimiento: Revisión de la caldera de gas (Caldera de gas)")
        self.assertEqual(dl["date"], "2026-11-20")
        self.assertIn("RD 1027/2007", dl["basis"])
        self.assertIn("fabricantes", dl["basis"], "the maker's advice travels with the legal basis")
        self.assertEqual(dl["rule"], "RITE IT 3.3")
        self.assertEqual(self.app.store.get("maintenance_tasks", task["id"])["kafka_deadline_id"], dl["id"])
        self.assertEqual(self.mirror.run_once()["sent"], 0, "nothing changed, nothing sent")
        self.call("maintenance_done", task=task["id"], done_at="2026-10-02")
        self.assertEqual(self.mirror.run_once()["sent"], 1)
        self.assertEqual(self.kafka.deadlines[("homehoard", task["id"])]["date"], "2028-10-02")
        self.assertEqual(len(self.kafka.deadlines), 1, "updates never duplicate")
        advice = self.call("maintenance_add", template_id="filtro-campana", target="lavadora")["task"]
        self.mirror.run_once()
        adl = self.kafka.deadlines[("homehoard", advice["id"])]
        self.assertEqual(adl["rule"], "Recomendación")
        self.assertIn("no es una obligación legal", adl["basis"])

    def test_kafka_down_queues_and_retries_and_deleting_closes(self):
        task = self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")["task"]
        self.kafka.down = "hub"
        out = self.mirror.run_once()
        self.assertEqual((out["sent"], out["failed"]), (0, 1))
        st = self.mirror.status()
        self.assertEqual(st["pending"], 1)
        self.assertEqual(st["tasks"][task["id"]]["reason"], "hub_down")
        self.assertIn("Hub", st["tasks"][task["id"]]["error"])
        self.kafka.down = None
        self.assertEqual(self.mirror.run_once()["sent"], 1)
        self.assertEqual(self.mirror.status()["pending"], 0)
        self.call("maintenance_delete", task=task["id"], confirm=True)
        self.assertEqual(self.mirror.run_once()["closed"], 1)
        self.assertEqual(self.kafka.deadlines[("homehoard", task["id"])]["state"], "dismissed")

    def test_the_setting_turns_the_mirror_off_and_closes_what_it_sent(self):
        task = self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")["task"]
        self.mirror.run_once()
        self.app.set_settings({"kafka_mirror": False})
        self.assertEqual(self.mirror.run_once()["closed"], 1)
        self.assertEqual(self.kafka.deadlines[("homehoard", task["id"])]["state"], "dismissed")
        self.app.set_settings({"kafka_mirror": True})
        self.assertEqual(self.mirror.run_once()["sent"], 1, "turned on again, it is sent again (and Kafka reopens it)")
        with self.assertRaises(T.ToolError):
            self.app.set_settings({"kafka_mirror": "sí"})

    def test_an_old_kafka_is_detected_without_leaving_duplicates(self):
        self.kafka.outdated = True
        self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")
        self.call("maintenance_add", template_id="filtro-campana", target="lavadora")
        out = self.mirror.run_once()
        self.assertEqual(out["sent"], 0)
        self.assertEqual([c[0] for c in self.kafka.calls], ["deadline_add", "deadline_delete"], "one try, undone, then it stops")
        self.assertTrue(any(t["reason"] == "kafka_outdated" for t in self.mirror.status()["tasks"].values()))

    def test_daily_due_event_and_done_event(self):
        self.call("maintenance_add", template_id="purgar-radiadores", target_kind="home")
        self.call("maintenance_add", template_id="caldera-gas", target="caldera", last_done="2024-12-30")
        self.mirror.run_once()
        due = [d for t, d in self.events if t == "homehoard.maintenance.due"]
        self.assertEqual(len(due), 1)
        self.assertEqual([x["title"] for x in due[0]["tasks"]], ["Purgar los radiadores"])
        self.mirror.run_once()
        self.assertEqual(len([1 for t, _ in self.events if t == "homehoard.maintenance.due"]), 1, "once a day")
        self.clock.advance(86400)
        self.mirror.run_once()
        self.assertEqual(len([1 for t, _ in self.events if t == "homehoard.maintenance.due"]), 2)
        task = self.app.store.alive("maintenance_tasks")[0]
        # the app marks it done: the log record arrives through the sync
        self.app.store.merge({"maintenance_log": [rec("log1", "", 5_000, task_id=task["id"], done_at=5_000, note=None)]})
        done = [d for t, d in self.events if t == "homehoard.maintenance.done"]
        self.assertEqual(done[0]["task_id"], task["id"])

    def test_papers_warranty_and_manual_search_go_through_the_hub(self):
        self.call("home_item_details", item="lavadora", set={"kafka_doc_ids": ["d_manual", "d_invoice"]})
        papers = self.call("home_item_papers", item="lavadora")
        self.assertEqual({d["id"] for d in papers["documents"]}, {"d_manual", "d_invoice"})
        self.assertEqual(papers["warranty"]["source"], "kafka")
        self.assertEqual(papers["kafka_warranty"]["cite"], "[d_invoice · p. 1]")
        self.assertTrue(papers["kafka_warranty"]["linked"])
        hit = self.call("home_manual_search", item="lavadora", query="error E21")
        self.assertEqual(hit["status"], "found")
        self.assertEqual(hit["searched"], "manuals")
        self.assertEqual(hit["results"][0]["cite"], "[d_manual · p. 2]")
        search = [a for t, a in self.kafka.calls if t == "doc_search"][-1]
        self.assertEqual(search["doc_ids"], ["d_manual"], "only the linked manuals are searched")
        self.assertEqual(self.call("home_manual_search", item="linterna", query="pilas")["status"], "no_papers")
        self.kafka.down = "kafka"
        down = self.call("home_item_papers", item="lavadora")
        self.assertEqual(down["kafka"]["reason"], "app_down")
        self.assertEqual(self.call("home_manual_search", item="lavadora", query="E21")["status"], "kafka_unavailable")

    def test_upload_sends_the_file_to_kafka_and_links_it(self):
        data = base64.b64encode(b"%PDF-1.4 manual de prueba").decode()
        out = self.app.kafka_upload({"item_id": "washer", "kind": "manual", "filename": "manual lavadora.pdf", "data": data})
        self.assertTrue(out["ok"])
        self.assertEqual(out["details"]["kafka_doc_ids"], ["d_new"])
        sent = self.kafka.files[0]
        self.assertEqual((sent["kind"], sent["item"], sent["bytes"]), ("manual", "Lavadora Demo", b"%PDF-1.4 manual de prueba"))
        self.assertEqual(list((self.app.paths.outbox).iterdir()), [], "the temporary copy is removed")
        self.kafka.down = "hub"
        failed = self.app.kafka_upload({"item_id": "washer", "kind": "invoice", "filename": "f.pdf", "data": data})
        self.assertEqual((failed["ok"], failed["reason"]), (False, "hub_down"))
        with self.assertRaises(T.ToolError):
            self.app.kafka_upload({"item_id": "washer", "kind": "receta", "filename": "f.pdf", "data": data})


if __name__ == "__main__":
    unittest.main()
