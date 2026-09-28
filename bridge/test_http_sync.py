import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import inventory
import server
from test_inventory import fixture


class LocalSyncTest(unittest.TestCase):
    def test_browser_preflight_and_import_stay_local_and_exclude_photos(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(inventory, "SNAPSHOT", Path(temp) / "snapshot.json"):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{httpd.server_port}/api/import"
            try:
                with urllib.request.urlopen(urllib.request.Request(url, method="OPTIONS", headers={"Origin": "http://127.0.0.1:19006"})) as response:
                    self.assertEqual(response.status, 204)
                    self.assertEqual(response.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:19006")
                with urllib.request.urlopen(urllib.request.Request(url, method="OPTIONS", headers={"Origin": "http://localhost:8082"})) as response:
                    self.assertEqual(response.status, 204)
                    self.assertEqual(response.headers["Access-Control-Allow-Origin"], "http://localhost:8082")
                payload = json.dumps(fixture()).encode()
                with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers={"Origin": "http://127.0.0.1:19006", "Content-Type": "application/json"})) as response:
                    self.assertEqual(json.load(response)["items"], 1)
                self.assertEqual(inventory.find("linterna phillips")["status"], "found")
                self.assertNotIn("base64", inventory.SNAPSHOT.read_text(encoding="utf-8"))
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
