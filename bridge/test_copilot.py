"""The Faustus copilot in HomeHoard: the vendored Hoard Link relay wired into this server (forced origin, streaming,
allow-list), the pages and their launcher, the family guard in front of it, the off switch, the manifest and the page-side
context builders."""
import base64
import http.client
import json
import shutil
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import inventory
from helpers_test import Running, make_app, tempdir
from homehoard_server import copilot as cp
from homehoard_server.hoard_link.copilot_launcher import LAUNCHER_JS
from homehoard_server.hoard_link.copilot_stdlib import CopilotRelay

ROOT = Path(__file__).resolve().parent.parent


class FakeFaustus:
    """Capabilities, the panel element, a POST that records what it was sent and a slow event stream."""

    def __init__(self):
        self.posts = []
        self.raw_posts = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body, kind="application/json"):
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/api/hoard-copilot/capabilities":
                    self._send(b'{"contract_version": "1.0"}')
                elif self.path == "/api/hoard-copilot/panel.js":
                    self._send(b"customElements.define('faustus-chat', class extends HTMLElement {});", "application/javascript")
                else:
                    self.send_error(404)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                owner.raw_posts.append(body)
                try:
                    parsed = json.loads(body or b"null")
                except ValueError:   # a multipart upload
                    parsed = None
                owner.posts.append((self.path, self.headers.get("Authorization"), parsed))
                if self.path == "/api/chat_stream":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b"data: first\n\n")
                    self.wfile.flush()
                    time.sleep(0.8)
                    self.wfile.write(b"data: second\n\n")
                    self.wfile.flush()
                    return
                self._send(b'{"ok": true}')

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def call(base, path, method="GET", body=None, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers


class CopilotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.fake = FakeFaustus()
        self.app, _, _, _ = make_app(self.tmp.name, mirror=False)
        web = Path(self.tmp.name) / "web"
        web.mkdir()
        (web / "index.html").write_text('<!DOCTYPE html><html><body><div id="root"></div></body></html>', encoding="utf-8")
        self.app.copilot = cp.install(self.app.paths.data, urls=[self.fake.url], faustus_token="secret-token")

    def tearDown(self):
        inventory.use_store(None)
        self.fake.close()
        self.tmp.cleanup()

    def test_info_names_the_app_and_the_space_is_stable(self):
        with Running(self.app) as base:
            code, body, _ = call(base, "/api/copilot/info")
            info = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual((info["app_id"], info["app_name"]), ("homehoard", "HomeHoard"))
            self.assertEqual(info["panel_url"], "/api/copilot/panel.js")
            self.assertEqual(info["settings_url"], self.fake.url + "/studio/settings")
            self.assertEqual(info["data_space_id"], (Path(self.app.paths.data) / "copilot-space-id").read_text(encoding="utf-8").strip())
            self.assertEqual(json.loads(call(base, "/api/copilot/info")[1])["data_space_id"], info["data_space_id"])

    def test_every_page_carries_the_launcher_once_and_the_scripts_are_served(self):
        with Running(self.app) as base:
            for path in ("/", "/item/abc", "/importar"):
                page = call(base, path)[1].decode("utf-8")
                self.assertEqual(page.count("/api/copilot/launcher.js"), 1, path)
                self.assertEqual(page.count('<script src="/copilot.js"></script>'), 1, path)
            code, body, headers = call(base, "/api/copilot/launcher.js")
            self.assertEqual(code, 200)
            self.assertEqual(body, LAUNCHER_JS.encode("utf-8"))   # the vendored launcher, served as is
            self.assertIn(b"hoardCopilot", body)
            self.assertIn("javascript", headers["Content-Type"])
            self.assertFalse((cp.STATIC / "copilot-launcher.js").exists())   # no private copy of it
            code, body, _ = call(base, "/copilot.js")
            self.assertEqual(code, 200)
            self.assertIn(b"root.hoardCopilot", body)

    def test_panel_comes_through_the_relay_and_the_faustus_token_stays_on_the_server(self):
        with Running(self.app) as base:
            code, body, _ = call(base, "/api/copilot/panel.js")
            self.assertEqual(code, 200)
            self.assertIn(b"faustus-chat", body)
            self.assertNotIn(b"secret-token", body)
            self.assertNotIn(b"secret-token", call(base, "/api/copilot/info")[1])

    def test_proxy_forces_the_origin_and_only_reaches_the_copilot_surface(self):
        with Running(self.app) as base:
            envelope = {"path": "/api/hoard-copilot/turn", "method": "POST",
                        "body": {"context": {"origin": {"app_id": "someone-else", "data_space_id": "stolen"}}}}
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", envelope)[0], 200)
            path, auth, body = self.fake.posts[-1]
            self.assertEqual((path, auth), ("/api/hoard-copilot/turn", "Bearer secret-token"))
            self.assertEqual(body["context"]["origin"]["app_id"], "homehoard")
            self.assertEqual(body["context"]["origin"]["data_space_id"], self.app.copilot.space_id)
            for bad in ("/api/admin/keys", "//evil.example/x", "api/chat/x", "/api/hoard-copilotx/y", "http://evil.example/api/chat/x"):
                self.assertEqual(call(base, "/api/copilot/proxy", "POST", {"path": bad, "method": "GET"})[0], 400, bad)
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", ["not", "an", "object"])[0], 400)

    def test_proxy_streams_events_as_they_arrive(self):
        with Running(self.app) as base:
            conn = http.client.HTTPConnection(base.split("//")[1], timeout=10)
            started = time.time()
            conn.request("POST", "/api/copilot/proxy", json.dumps({"path": "/api/chat_stream", "method": "POST", "body": {"message": "hi"}}),
                         {"Content-Type": "application/json", "Connection": "close"})
            response = conn.getresponse()
            first = response.read1(65536)
            waited = time.time() - started
            rest = response.read()
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertIn(b"first", first)
            self.assertLess(waited, 0.6)           # not held back until the stream ends
            self.assertIn(b"second", rest)

    def test_the_family_guard_stays_in_front_of_the_relay(self):
        with Running(self.app) as base:
            self.assertEqual(call(base, "/api/copilot/info", headers={"Host": "evil.example"})[0], 403)
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", {"path": "/api/chat_stream"}, {"Origin": "http://evil.example"})[0], 403)
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", {"path": "/api/chat_stream"},
                                  {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"})[0], 403)

    def test_faustus_closed_answers_503_not_a_crash(self):
        self.fake.close()
        self.app.copilot = cp.install(self.app.paths.data, urls=["http://127.0.0.1:9"], faustus_token="")
        with Running(self.app) as base:
            self.assertEqual(call(base, "/api/copilot/info")[0], 503)
            self.assertEqual(call(base, "/api/copilot/panel.js")[0], 503)
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", {"path": "/api/chat_stream", "method": "POST", "body": {}})[0], 503)

    def test_the_off_switch_removes_the_routes_the_launcher_and_the_scripts(self):
        self.app.copilot = None
        with Running(self.app) as base:
            self.assertNotIn(b"launcher.js", call(base, "/")[1])
            self.assertNotIn(b"/copilot.js", call(base, "/")[1])
            self.assertEqual(call(base, "/api/copilot/info")[0], 404)
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", {"path": "/api/chat_stream"})[0], 404)
            self.assertFalse(json.loads(call(base, "/api/health")[1])["copilot"])

    def test_health_reports_the_copilot(self):
        with Running(self.app) as base:
            self.assertTrue(json.loads(call(base, "/api/health")[1])["copilot"])

    def test_enabled_reads_the_environment(self):
        import os
        old = os.environ.get("HOARD_COPILOT")
        try:
            os.environ["HOARD_COPILOT"] = "0"
            self.assertFalse(cp.enabled())
            self.assertIsNone(cp.install(self.app.paths.data))
            os.environ["HOARD_COPILOT"] = "1"
            self.assertTrue(cp.enabled())
        finally:
            if old is None:
                os.environ.pop("HOARD_COPILOT", None)
            else:
                os.environ["HOARD_COPILOT"] = old

    def test_faustus_url_comes_from_the_environment(self):
        import os
        saved = {k: os.environ.get(k) for k in ("HOMEHOARD_FAUSTUS_URL", "HOARD_FAUSTUS_TOKEN")}
        try:
            os.environ["HOMEHOARD_FAUSTUS_URL"] = "http://127.0.0.1:9"
            os.environ["HOARD_FAUSTUS_TOKEN"] = "abc"
            relay = cp.install(self.app.paths.data)
            self.assertEqual(relay.urls, ("http://127.0.0.1:9",))
            self.assertEqual(relay.token, "abc")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_a_multipart_context_is_rewritten_and_the_upload_is_untouched(self):
        boundary = "XB"
        context = json.dumps({"origin": {"app_id": "x"}, "view": {"page": "item"}})
        body = (("--%s\r\nContent-Disposition: form-data; name=\"context\"\r\n\r\n%s\r\n"
                 "--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n") % (boundary, context, boundary)).encode()
        body += b"\x00\x01\r\nraw\xff" + ("\r\n--%s--\r\n" % boundary).encode()
        with Running(self.app) as base:
            envelope = {"path": "/api/hoard-copilot/upload", "method": "POST", "content_type": "multipart/form-data; boundary=" + boundary,
                        "raw_body": base64.b64encode(body).decode("ascii")}
            self.assertEqual(call(base, "/api/copilot/proxy", "POST", envelope)[0], 200)
        sent = self.fake.raw_posts[-1]
        self.assertIn(b'"app_id": "homehoard"', sent)
        self.assertIn(b'"page": "item"', sent)
        self.assertIn(b"\x00\x01\r\nraw\xff", sent)
        self.assertEqual(sent.count(b"--XB"), 3)

    def test_the_html_injection_adds_the_page_script_then_the_launcher_once(self):
        once = cp.inject(b"<html><body><p>x</p></body></html>")
        self.assertEqual(once.count(b"/api/copilot/launcher.js"), 1)
        self.assertEqual(once.count(b'<script src="/copilot.js"></script>'), 1)
        self.assertLess(once.index(b"/copilot.js"), once.index(b"launcher.js"))
        self.assertLess(once.index(b"launcher.js"), once.index(b"</body>"))
        self.assertEqual(cp.inject(once), once)
        self.assertTrue(cp.inject(b"<p>no body</p>").endswith(b"</script>"))
        self.assertEqual(CopilotRelay.inject_html(b"<body></body>").count(b"launcher.js"), 1)

    def test_the_relay_is_the_vendored_one(self):
        self.assertIsInstance(self.app.copilot, CopilotRelay)
        self.assertEqual((self.app.copilot.app_id, self.app.copilot.app_name), ("homehoard", "HomeHoard"))

    def test_manifest_declares_the_copilot(self):
        manifest = json.loads((ROOT / "faustus-plugin.json").read_text(encoding="utf-8"))
        copilot = manifest["x-family"]["copilot"]
        self.assertTrue(manifest["x-family"]["agenda"])
        self.assertEqual((copilot["provider"], copilot["panel"]), ("faustus", "/api/copilot/panel.js"))
        self.assertIn("active_objects", copilot["context"])
        self.assertIn("project", copilot["context"])

    def test_the_page_side_context_builders_pass_their_node_tests(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run([node, "--test", str(ROOT / "tests" / "copilot.test.mjs")], capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout[-2000:] + result.stderr[-1000:])


if __name__ == "__main__":
    unittest.main()
