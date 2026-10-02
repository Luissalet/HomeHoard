import base64
import http.client
import json
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import inventory
from helpers_test import Running, make_app, sample_records, tempdir
from test_inventory import fixture

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG demo").decode()


def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {})) as r:
        return r.status, r.headers, r.read()


def post(url, body, headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


class ServerHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_browser_preflight_and_import_stay_local_and_exclude_photos_from_the_snapshot(self):
        with Running(self.app) as base:
            url = base + "/api/import"
            for origin in ("http://127.0.0.1:19006", "http://localhost:8082"):
                with urllib.request.urlopen(urllib.request.Request(url, method="OPTIONS", headers={"Origin": origin})) as response:
                    self.assertEqual(response.status, 204)
                    self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
            status, body = post(url, fixture(), {"Origin": "http://127.0.0.1:19006"})
            self.assertEqual((status, body["items"]), (200, 1))
            self.assertEqual(inventory.find("linterna phillips")["status"], "found")
            snapshot = (Path(self.tmp.name) / "data" / "faustus-inventory.json").read_text(encoding="utf-8")
            self.assertNotIn("base64", snapshot)
            status, body = post(url, fixture(), {"Origin": "http://evil.example"})
            self.assertEqual(status, 403)

    def test_home_state_sync_version_and_photos(self):
        with Running(self.app) as base:
            _, _, raw = get(base + "/api/health")
            health = json.loads(raw)
            self.assertEqual((health["service"], health["version"], health["app"]), ("homehoard-bridge", "0.3.0", "homehoard"))
            self.assertIn("hoard_link", health)
            records = sample_records(1_000)
            records["items"][0] = {**records["items"][0], "photo_uri": PNG}
            status, body = post(base + "/api/home/sync", {"base_version": 0, "records": records})
            self.assertEqual(status, 200)
            self.assertEqual(body["version"], 1)
            torch = next(i for i in body["state"]["tables"]["items"] if i["id"] == "torch")
            self.assertTrue(torch["photo_uri"].startswith("/photos/torch?v="))
            _, headers, photo = get(base + torch["photo_uri"])
            self.assertEqual((photo, headers["Content-Type"]), (b"\x89PNG demo", "image/png"))
            _, _, raw = get(base + "/api/home/version")
            self.assertEqual(json.loads(raw)["version"], 1)
            _, _, raw = get(base + "/api/home")
            state = json.loads(raw)
            self.assertEqual(len(state["tables"]["items"]), 3)
            self.assertIn("maintenance_tasks", state["tables"])
            status, body = post(base + "/api/home/sync", {"records": "nada"})
            self.assertEqual(status, 400)

    def test_guard_rejects_foreign_hosts_origins_and_cross_site_requests(self):
        with Running(self.app) as base:
            port = base.rsplit(":", 1)[1]
            conn = http.client.HTTPConnection("127.0.0.1", int(port))
            conn.request("GET", "/api/home", headers={"Host": "evil.example"})
            self.assertEqual(conn.getresponse().status, 403)
            conn.close()
            status, _ = post(base + "/api/home/sync", {"records": {}}, {"Origin": "https://evil.example"})
            self.assertEqual(status, 403)
            status, _ = post(base + "/api/home/sync", {"records": {}}, {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"})
            self.assertEqual(status, 403)

    def test_agent_contract_needs_the_token(self):
        self.app.store.merge(sample_records(1_000))
        with Running(self.app) as base:
            _, _, raw = get(base + "/api/agent/tools")
            catalog = json.loads(raw)
            self.assertIn("home_move_item", [t["name"] for t in catalog["tools"]])
            self.assertTrue(catalog["instructions"])
            status, _ = post(base + "/api/agent/call", {"name": "home_find_item", "arguments": {"query": "linterna"}})
            self.assertEqual(status, 401)
            auth = {"Authorization": "Bearer " + self.app.token}
            status, body = post(base + "/api/agent/call", {"name": "home_find_item", "arguments": {"query": "linterna"}}, auth)
            self.assertEqual((status, body["status"]), (200, "found"))
            status, body = post(base + "/api/agent/call", {"tool": "home_burn", "arguments": {}}, auth)
            self.assertEqual(status, 404)
            self.assertIn("Unknown tool", body["error"])
            status, body = post(base + "/api/agent/call", {"name": "home_move_item", "arguments": {"item": "linterna", "location": "Sótano"}}, auth)
            self.assertEqual((status, body["code"]), (400, "not_found"))
            status, body = post(base + "/api/ui/call", {"tool": "maintenance_templates", "arguments": {"text": "caldera"}})
            self.assertEqual((status, body["suggested"][0]), (200, "caldera-gas"))
            token_file = Path(self.tmp.name) / "data" / "mcp-token"
            self.assertEqual(token_file.read_text(encoding="utf-8"), self.app.token)

    def test_serves_the_web_app_with_deep_links_and_the_import_page(self):
        with Running(self.app) as base:
            _, _, page = get(base + "/")
            self.assertIn("npm run build:web".encode(), page, "without the export the page says how to build it")
            web = Path(self.tmp.name) / "web"
            (web / "_expo" / "static" / "js").mkdir(parents=True)
            (web / "index.html").write_text("<!doctype html><title>HomeHoard</title>", encoding="utf-8")
            (web / "_expo" / "static" / "js" / "app.js").write_text("console.log(1)", encoding="utf-8")
            _, _, page = get(base + "/item/123")
            self.assertIn(b"<title>HomeHoard</title>", page)
            _, headers, js = get(base + "/_expo/static/js/app.js")
            self.assertEqual(js, b"console.log(1)")
            self.assertIn("immutable", headers["Cache-Control"])
            _, _, page = get(base + "/importar")
            self.assertIn("Importar una copia".encode(), page)
            with self.assertRaises(urllib.error.HTTPError):
                get(base + "/../../etc/passwd")
            with self.assertRaises(urllib.error.HTTPError):
                get(base + "/photos/missing")

    def test_settings_and_kafka_status_say_why_kafka_is_missing(self):
        self.kafka.down = "hub"
        with Running(self.app) as base:
            _, _, raw = get(base + "/api/kafka/status")
            status = json.loads(raw)
            self.assertFalse(status["kafka"]["reachable"])
            self.assertEqual(status["kafka"]["reason"], "hub_down")
            self.assertTrue(status["settings"]["kafka_mirror"])
            code, body = post(base + "/api/settings", {"kafka_mirror": False})
            self.assertEqual((code, body), (200, {"kafka_mirror": False}))
            code, body = post(base + "/api/kafka/search", {"query": "lavadora"})
            self.assertEqual((code, body["ok"], body["reason"]), (200, False, "hub_down"))


if __name__ == "__main__":
    unittest.main()
