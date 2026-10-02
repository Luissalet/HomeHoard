import base64
import json
import unittest
from pathlib import Path

import inventory
from helpers_test import make_app, rec, sample_records, tempdir
from homehoard_server.bundle import records_from_bundle

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake photo").decode()


class StoreMergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.store = self.app.store

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_last_writer_wins_per_record_and_version_grows(self):
        first = self.store.merge(sample_records(1_000))
        self.assertEqual(first["version"], 1)
        self.assertGreater(first["applied"], 10)
        older = self.store.merge({"items": [rec("torch", "Linterna vieja", 900, room_id="storage", container_id=None)]})
        self.assertEqual((older["applied"], older["ignored"], older["version"]), (0, 1, 1))
        newer = self.store.merge({"items": [rec("torch", "Linterna nueva", 1_100, room_id="storage", container_id="shelf")]})
        self.assertEqual((newer["applied"], newer["version"]), (1, 2))
        self.assertEqual(self.store.get("items", "torch")["name"], "Linterna nueva")
        same = self.store.merge({"items": [self.store.get("items", "torch")]})
        self.assertEqual((same["applied"], same["version"]), (0, 2), "re-sending the same record changes nothing")
        # survives a restart: atomic file, same instance and version
        again, *_ = make_app(self.tmp.name, mirror=False)
        self.assertEqual(again.store.info(), self.store.info())
        self.assertEqual(again.store.get("items", "torch")["name"], "Linterna nueva")

    def test_tombstones_win_when_newer_and_on_a_tie(self):
        self.store.merge(sample_records(1_000))
        self.store.merge({"items": [rec("washer", "Lavadora Demo", 1_000, room_id="kitchen", deleted_at=1_000)]})
        self.assertIsNotNone(self.store.get("items", "washer")["deleted_at"], "a tombstone wins a tie")
        self.store.merge({"items": [rec("washer", "Lavadora Demo", 999, room_id="kitchen")]})
        self.assertIsNotNone(self.store.get("items", "washer")["deleted_at"], "an older live copy does not resurrect it")
        self.store.merge({"items": [rec("washer", "Lavadora Demo", 1_200, room_id="kitchen")]})
        self.assertIsNone(self.store.get("items", "washer")["deleted_at"], "a newer restore does")

    def test_tag_links_get_deterministic_ids(self):
        self.store.merge(sample_records(1_000))
        self.store.merge({"itemTags": [{"item_id": "torch", "tag_id": "electric", "updated_at": 1_500, "deleted_at": 1_500}]})
        links = [l for l in self.store.tables()["itemTags"] if l["item_id"] == "torch"]
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["id"], "torch:electric")
        self.assertEqual(inventory.find("material eléctrico")["status"], "not_found", "a removed tag no longer finds the object")

    def test_photos_become_files_and_are_removed_with_the_photo(self):
        self.store.merge(sample_records(1_000))
        torch = {**self.store.get("items", "torch"), "photo_uri": PNG, "updated_at": 1_100}
        self.store.merge({"items": [torch]})
        uri = self.store.get("items", "torch")["photo_uri"]
        self.assertTrue(uri.startswith("/photos/torch?v="), uri)
        self.assertEqual(self.store.photo_file("torch").read_bytes(), b"\x89PNG fake photo")
        snapshot = (Path(self.tmp.name) / "data" / "faustus-inventory.json").read_text(encoding="utf-8")
        self.assertNotIn("base64", snapshot)
        self.assertNotIn("/photos/", snapshot, "the old snapshot stays photo-free")
        # the app sends back the absolute URL it shows: nothing changes
        self.store.merge({"items": [{**self.store.get("items", "torch"), "photo_uri": "http://127.0.0.1:5196" + uri, "updated_at": 1_150}]})
        self.assertEqual(self.store.get("items", "torch")["photo_uri"], uri)
        # a photo map entry (sync body) wins over the inline value
        self.store.merge({"items": [{**self.store.get("items", "torch"), "updated_at": 1_160}]}, {"torch": "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()})
        self.assertEqual(self.store.photo_file("torch").suffix, ".jpg")
        # a phone path cannot be read here: the computer keeps its photo
        self.store.merge({"items": [{**self.store.get("items", "torch"), "photo_uri": "file:///data/photos/x.jpg", "updated_at": 1_170}]})
        self.assertIsNotNone(self.store.photo_file("torch"))
        # the app removes the photo
        self.store.merge({"items": [{**self.store.get("items", "torch"), "photo_uri": None, "updated_at": 1_200}]})
        self.assertIsNone(self.store.photo_file("torch"))

    def test_old_backups_merge_and_never_drop_photos(self):
        self.store.merge(sample_records(1_000))
        self.store.merge({"items": [{**self.store.get("items", "torch"), "photo_uri": PNG, "updated_at": 1_100}]})
        legacy = sample_records(1_000)
        bundle = {"format": "homehoard-export", "version": 1, "exported_at": 2_000,
                  "data": {**legacy, "itemTags": [{"item_id": "torch", "tag_id": "electric"}],
                           "items": [{**i, "updated_at": 1_300, "photo_uri": None} if i["id"] == "torch" else i for i in legacy["items"]]}}
        result = inventory.save(bundle)
        self.assertGreaterEqual(result["applied"], 1)
        self.assertEqual(result["source"], "live")
        self.assertIsNotNone(self.store.photo_file("torch"), "a backup without photos never deletes one")
        records, photos, exported = records_from_bundle(bundle)
        self.assertEqual(records["itemTags"][0]["updated_at"], 1_300, "a v1 link takes the time of its object")
        v2 = {**bundle, "version": 2, "photos": {"washer": PNG}}
        v2["data"] = {**bundle["data"], "items": [{**i, "updated_at": 1_400} if i["id"] == "washer" else i for i in bundle["data"]["items"]]}
        inventory.save(v2)
        self.assertIsNotNone(self.store.photo_file("washer"))
        v3 = {"format": "homehoard-export", "version": 3, "exported_at": 3_000, "data": {**sample_records(1_000), "maintenance_tasks": [
            rec("mt", "", 1_000, title="Purgar radiadores", target_kind="home", target_id="home", every_months=12, anchor_month=10, basis="advice")],
            "item_details": [{"item_id": "washer", "brand": "Marca Demo", "kafka_doc_ids": '["d_invoice"]', "consumables": "[]", "updated_at": 1_000}],
            "maintenance_log": []}}
        inventory.save(v3)
        self.assertEqual(self.store.get("maintenance_tasks", "mt")["title"], "Purgar radiadores")
        self.assertEqual(self.store.get("item_details", "washer")["kafka_doc_ids"], ["d_invoice"], "phone JSON columns become lists")
        with self.assertRaises(ValueError):
            inventory.save({"format": "homehoard-export", "version": 9, "data": {}})

    def test_unknown_tables_and_bad_rows_are_reported_not_stored(self):
        out = self.store.merge({"secrets": [{"id": "x"}], "items": [{"name": "sin id"}, "texto"]})
        self.assertEqual(out["invalid"], 2)
        self.assertIn("tabla desconocida: secrets", out["notes"])
        self.assertEqual(out["version"], 0)

    def test_server_managed_fields_do_not_beat_app_edits(self):
        self.store.merge({"maintenance_tasks": [rec("mt", "", 1_000, title="Caldera", target_kind="item", target_id="boiler", every_months=24)]})
        self.store.set_silently("maintenance_tasks", "mt", kafka_deadline_id="t_9")
        self.assertEqual(self.store.get("maintenance_tasks", "mt")["updated_at"], 1_000)
        self.store.merge({"maintenance_tasks": [rec("mt", "", 1_100, title="Caldera (revisión)", target_kind="item", target_id="boiler", every_months=24)]})
        self.assertEqual(self.store.get("maintenance_tasks", "mt")["kafka_deadline_id"], "t_9", "the app's newer edit keeps the Kafka id")


if __name__ == "__main__":
    unittest.main()
