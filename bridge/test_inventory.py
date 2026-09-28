import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import inventory


def fixture():
    def row(id, name, **extra):
        return {"id": id, "name": name, "deleted_at": None, **extra}
    return {"format": "homehoard-export", "version": 2, "exported_at": 1720000000000,
            "photos": {"item": "data:image/png;base64,AAAA"},
            "data": {"households": [], "homes": [row("home", "Mi casa")],
                     "floors": [row("floor", "Planta baja", home_id="home")],
                     "rooms": [row("room", "Trastero", floor_id="floor")],
                     "containers": [row("shelf", "Estantería", parent_container_id=None), row("box", "Caja roja", parent_container_id="shelf")],
                     "items": [row("item", "Linterna Philips", room_id="room", container_id="box", photo_uri="file:///secret/photo.jpg", quantity=1),
                               row("gone", "Linterna vieja", room_id="room", container_id=None, deleted_at=3)],
                     "tags": [], "itemTags": []}}


class InventoryTest(unittest.TestCase):
    def test_natural_question_and_typo_return_full_path_without_photos(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(inventory, "SNAPSHOT", Path(temp) / "snapshot.json"):
            inventory.save(fixture())
            result = inventory.find("¿Dónde tengo guardada la linterna phillips?")
            self.assertEqual(result["status"], "found")
            self.assertEqual(result["matches"][0]["location"], "Mi casa › Planta baja › Trastero › Estantería › Caja roja")
            self.assertEqual(len(result["matches"]), 1)
            self.assertNotIn("secret/photo.jpg", inventory.SNAPSHOT.read_text(encoding="utf-8"))
            self.assertNotIn("base64", inventory.SNAPSHOT.read_text(encoding="utf-8"))

    def test_missing_snapshot_and_unknown_object(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(inventory, "SNAPSHOT", Path(temp) / "snapshot.json"):
            self.assertEqual(inventory.find("linterna")["status"], "no_snapshot")
            inventory.save(fixture())
            self.assertEqual(inventory.find("taladro")["status"], "not_found")

    def test_invalid_export_does_not_replace_snapshot(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(inventory, "SNAPSHOT", Path(temp) / "snapshot.json"):
            inventory.save(fixture())
            with self.assertRaises(ValueError): inventory.save({"format": "wrong"})
            self.assertEqual(inventory.status()["items"], 1)


if __name__ == "__main__":
    unittest.main()
