import json
import unittest
from datetime import date, datetime
from pathlib import Path

from homehoard_server import maintenance as MT

CASES = json.loads((Path(__file__).resolve().parent.parent / "tests" / "maintenance-cases.json").read_text(encoding="utf-8"))


def noon(day: str) -> int:
    d = date.fromisoformat(day)
    return int(datetime(d.year, d.month, d.day, 12, 0).timestamp() * 1000)


class MaintenanceRulesTest(unittest.TestCase):
    """The same cases as tests/maintenance.test.mjs: the server and the app agree on every date."""

    def test_next_due_matches_the_shared_cases(self):
        for case in CASES["next_due"]:
            task = dict(case["task"])
            task["last_done_at"] = noon(task["last_done"]) if task.get("last_done") else None
            task["created_at"] = noon(task["created"])
            self.assertEqual(MT.compute_next_due(task), case["expected"], case["task"])

    def test_groups_intervals_and_suggestions(self):
        today = date.fromisoformat(CASES["groups"]["today"])
        for day, group in CASES["groups"]["cases"]:
            self.assertEqual(MT.group_of(day, today), group)
        for task, text in CASES["intervals"]:
            self.assertEqual(MT.interval_text(task), text)
        for case in CASES["suggest"]:
            got = [t["id"] for t in MT.suggest(case["name"], target_kind=case["target"], room_kind=case.get("room_kind", ""))]
            self.assertEqual(got, case["expected"], case["name"])

    def test_legal_templates_state_their_norm(self):
        for t in MT.templates():
            if t["basis"] == "law":
                self.assertTrue(t.get("legal_ref") and t.get("rule"), t["id"])
                self.assertEqual(MT.template_source(t), t["legal_ref"])
            else:
                self.assertIn("no es una obligación legal", MT.template_source(t))
        boiler = MT.template("caldera-gas")
        self.assertEqual(boiler["every_months"], 24)
        self.assertIn("RD 1027/2007", boiler["legal_ref"])
        self.assertEqual(MT.template("instalacion-gas")["every_months"], 60)
        self.assertEqual((MT.template("aire-hasta-12kw")["every_months"], MT.template("aire-12-70kw")["every_months"]), (48, 24))


if __name__ == "__main__":
    unittest.main()
