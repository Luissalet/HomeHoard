"""What HomeHoard takes from the family library: atomic writes, the stable token, the bridge and a server that needs no httpx."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import venv
from pathlib import Path

import inventory
from helpers_test import make_app, sample_records, tempdir
from homehoard_server import config as C
from homehoard_server.hoard_link import atomic

HERE = Path(__file__).resolve().parent


class AtomicWritesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_saving_leaves_no_temp_files_and_a_valid_state(self):
        self.app.store.merge(sample_records(1_000))
        self.app.set_settings({"kafka_mirror": False})
        leftovers = [p.name for p in Path(self.tmp.name).rglob("*.tmp")]
        self.assertEqual(leftovers, [])
        self.assertEqual(json.loads(self.app.paths.state.read_text(encoding="utf-8"))["format"], "homehoard-state")
        self.assertEqual(json.loads(self.app.paths.settings.read_text(encoding="utf-8")), {"kafka_mirror": False})

    def test_a_sharing_violation_on_the_replace_is_retried(self):
        calls = []
        real = os.replace

        def flaky(src, dst):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError(13, "in use")
            return real(src, dst)

        target = Path(self.tmp.name) / "x.json"
        tmp = target.with_name("x.json.tmp")
        tmp.write_text("{}", encoding="utf-8")
        atomic.replace_with_retry(tmp, target, replace=flaky, sleep=lambda s: None)
        self.assertEqual(len(calls), 3)
        self.assertTrue(target.exists())

    def test_a_photo_is_written_atomically_and_replaced(self):
        data = "data:image/png;base64,iVBORw0KGgo="
        uri = self.app.store._write_photo("torch", data)
        self.assertTrue(uri.startswith("/photos/torch?v="))
        photo = self.app.paths.photos / "torch.png"
        self.assertTrue(photo.is_file())
        self.assertEqual([p.name for p in self.app.paths.photos.glob("*.tmp")], [])

    def test_the_offline_snapshot_is_written_atomically(self):
        old = inventory.SNAPSHOT
        inventory.use_store(None)
        inventory.SNAPSHOT = Path(self.tmp.name) / "snap" / "faustus-inventory.json"
        try:
            bundle = {"format": "homehoard-export", "version": 3, "exported_at": "2026-10-02",
                      "data": {t: [] for t in inventory.TABLES}}
            inventory.save(bundle)
            self.assertEqual(json.loads(inventory.SNAPSHOT.read_text(encoding="utf-8"))["format"], "homehoard-faustus-snapshot")
            self.assertEqual([p.name for p in inventory.SNAPSHOT.parent.glob("*.tmp")], [])
        finally:
            inventory.SNAPSHOT = old


class TokenTest(unittest.TestCase):
    def test_the_token_is_created_once_and_stays_across_instances(self):
        tmp = tempdir()
        try:
            first, *_ = make_app(tmp.name, mirror=False)
            second, *_ = make_app(tmp.name, mirror=False)
            self.assertEqual(first.token, second.token)
            self.assertGreaterEqual(len(first.token), 32)
            self.assertEqual(first.paths.token.read_text(encoding="utf-8").strip(), first.token)
        finally:
            inventory.use_store(None)
            tmp.cleanup()

    def test_an_existing_token_file_is_kept(self):
        tmp = tempdir()
        try:
            (Path(tmp.name) / "data").mkdir(parents=True, exist_ok=True)
            (Path(tmp.name) / "data" / "mcp-token").write_text("a" * 40 + "\n", encoding="utf-8")
            app, *_ = make_app(tmp.name, mirror=False)
            self.assertEqual(app.token, "a" * 40)
        finally:
            inventory.use_store(None)
            tmp.cleanup()


class BridgeTest(unittest.TestCase):
    def test_the_bridge_is_the_family_catalog_bridge_for_this_app(self):
        import mcp_server
        bridge = mcp_server.make_bridge()
        self.assertEqual(bridge.service, "homehoard-bridge")
        self.assertEqual(bridge.package, "homehoard_server")
        self.assertEqual(bridge.default_port, C.DEFAULT_PORT)
        old = os.environ.get("HOMEHOARD_DATA_DIR")
        try:
            os.environ["HOMEHOARD_DATA_DIR"] = "/tmp/hh-data-test"
            self.assertEqual(bridge.data_dir, C.data_dir())
            os.environ.pop("HOMEHOARD_DATA_DIR")
            self.assertEqual(bridge.data_dir, C.ROOT / "data", "the home lives in <repo>/data, not next to the bridge")
        finally:
            if old is not None:
                os.environ["HOMEHOARD_DATA_DIR"] = old

    def test_the_server_starts_as_a_module(self):
        self.assertTrue((HERE / "homehoard_server" / "__main__.py").is_file())

    def test_the_server_and_its_family_link_import_without_httpx(self):
        code = ("import sys; sys.modules['httpx'] = None\n"
                "from homehoard_server import app, agenda, kafka, store\n"
                "from homehoard_server.hoard_link import family\n"
                "print(sorted(family.health_block())[:1])")
        out = subprocess.run([sys.executable, "-c", code], cwd=HERE, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_vendored_bridge_autostart_is_not_a_child_of_its_host(self):
        import psutil
        from homehoard_server.hoard_link import net, proc

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "fake app"
            package = root / "fake_lifetime_app"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("", encoding="utf-8")
            (package / "__main__.py").write_text(
                "import http.server, json, os, sys\n"
                "if os.environ.get('FAKE_LIFETIME_IDENTITY'):\n"
                " from homehoard_server.hoard_link.launch import process_created\n"
                " with open(os.environ['FAKE_LIFETIME_IDENTITY'],'w',encoding='utf-8') as f: json.dump({'pid':os.getpid(),'created':process_created(os.getpid()),'python':sys.executable,'cwd':os.getcwd()},f)\n"
                "class H(http.server.BaseHTTPRequestHandler):\n"
                " def do_GET(self):\n"
                "  raw=json.dumps({'service':'fake-lifetime','pid':os.getpid(),'python':sys.executable}).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)\n"
                " def log_message(self,*args): pass\n"
                "http.server.ThreadingHTTPServer(('127.0.0.1',int(os.environ['FAKE_LIFETIME_PORT'])),H).serve_forever()\n",
                encoding="utf-8",
            )
            data = root / "data"
            port = net.free_port()
            venv_root = root / "venv with spaces"
            venv.EnvBuilder(with_pip=False).create(venv_root)
            venv_python = venv_root / "Scripts" / "python.exe"
            self.assertTrue(venv_python.is_file())
            code = (
                "import json, os; from homehoard_server.hoard_link.bridge import ensure_running; "
                "ok=ensure_running('fake_lifetime_app', int(os.environ['FAKE_LIFETIME_PORT']), service='fake-lifetime', "
                "data_dir=os.environ['FAKE_LIFETIME_DATA'], cwd=os.environ['FAKE_LIFETIME_CWD'], "
                "port_env='FAKE_LIFETIME_PORT', wait_s=20); print(json.dumps({'ok':ok}))"
            )
            environment = {**os.environ, "FAKE_LIFETIME_PORT": str(port), "FAKE_LIFETIME_DATA": str(data),
                           "FAKE_LIFETIME_CWD": str(root),
                           "FAKE_LIFETIME_IDENTITY": str(data / "server-identity.json"),
                           "PYTHONPATH": os.pathsep.join((str(HERE), str(root)))}
            identity_path = data / "server-identity.json"
            identity = None
            pid = created = None
            try:
                host = subprocess.run([str(venv_python), "-c", code], cwd=root, env=environment,
                                      capture_output=True, text=True, timeout=45)
                self.assertEqual(host.returncode, 0, host.stderr)
                self.assertEqual(json.loads(host.stdout.strip()), {"ok": True})
                identity = json.loads(identity_path.read_text(encoding="utf-8"))
                pid, created = int(identity["pid"]), float(identity["created"])
                health = net.fetch_health(f"http://127.0.0.1:{port}/api/health", timeout=2)
                self.assertIsNotNone(health)
                self.assertEqual(int(health["pid"]), pid)
                self.assertAlmostEqual(psutil.Process(pid).create_time(), created, delta=0.01)
                self.assertEqual(Path(health["python"]).resolve(), venv_python.resolve())
                self.assertIn("fake_lifetime_app", psutil.Process(pid).cmdline())
                self.assertEqual(net.fetch_health(f"http://127.0.0.1:{port}/api/health", timeout=2)["pid"], pid)
            finally:
                if identity is None and identity_path.is_file():
                    try:
                        identity = json.loads(identity_path.read_text(encoding="utf-8"))
                        pid, created = int(identity["pid"]), float(identity["created"])
                    except (OSError, ValueError, KeyError, TypeError):
                        identity = None
                if pid is not None and created is not None and proc.pid_alive(pid):
                    try:
                        current = psutil.Process(pid)
                        if (abs(current.create_time() - created) <= 0.01 and Path(current.cwd()).resolve() == root.resolve()
                                and "fake_lifetime_app" in current.cmdline() and identity
                                and Path(identity["python"]).resolve() == venv_python.resolve()):
                            proc.kill_tree(pid, grace_s=0)
                    except psutil.Error:
                        pass


if __name__ == "__main__":
    unittest.main()
