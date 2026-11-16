"""Home Assistant as a gateway: a fake instance (REST + WebSocket) answers, so the client, the bus and the rules are
exercised over real sockets."""
from __future__ import annotations

import base64
import hashlib
import json
import queue
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import inventory
from helpers_test import Running, make_app, tempdir
from homehoard_server import homeassistant as HA
from homehoard_server import tools as T

TOKEN = "token-de-prueba"
STATES = [
    {"entity_id": "light.salon", "state": "off", "last_changed": "2026-11-16T20:00:00+00:00",
     "attributes": {"friendly_name": "Luz del salón", "brightness": 0}},
    {"entity_id": "sensor.salon_temperature", "state": "21.5", "last_changed": "2026-11-16T20:00:00+00:00",
     "attributes": {"friendly_name": "Temperatura del salón", "unit_of_measurement": "°C", "device_class": "temperature"}},
    {"entity_id": "binary_sensor.puerta_entrada", "state": "off", "last_changed": "2026-11-16T20:00:00+00:00",
     "attributes": {"friendly_name": "Puerta de entrada", "device_class": "door"}},
]


# ---------------------------------------------------------------------- the fake instance
def _frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """A server frame (never masked)."""
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += length.to_bytes(2, "big")
    else:
        header.append(127)
        header += length.to_bytes(8, "big")
    return bytes(header) + payload


def _read_frame(sock) -> tuple[int, bytes]:
    """One client frame (masked)."""
    def take(n: int) -> bytes:
        data = b""
        while len(data) < n:
            chunk = sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("closed")
            data += chunk
        return data
    first, second = take(2)
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(take(2), "big")
    elif length == 127:
        length = int.from_bytes(take(8), "big")
    mask = take(4) if second & 0x80 else b"\0\0\0\0"
    payload = take(length) if length else b""
    return first & 0x0F, bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


class FakeHomeAssistant:
    """The REST API and the event bus of one instance, on a free loopback port."""

    def __init__(self):
        self.states = {s["entity_id"]: dict(s) for s in STATES}
        self.calls: list[tuple[str, str, dict]] = []
        self.events: "queue.Queue[dict]" = queue.Queue()
        self.bus_ready = threading.Event()
        self.bus_clients = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                return

            def _json(self, code: int, payload) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                if self.headers.get("Authorization") == f"Bearer {TOKEN}":
                    return True
                self._json(401, {"message": "Unauthorized"})
                return False

            def do_GET(self) -> None:
                if self.path == "/api/websocket":
                    self._websocket()
                    return
                if not self._authorized():
                    return
                if self.path == "/api/":
                    self._json(200, {"message": "API running.", "version": "2026.11.0", "location_name": "Casa Demo"})
                elif self.path == "/api/states":
                    self._json(200, list(fake.states.values()))
                elif self.path.startswith("/api/states/"):
                    entity_id = self.path[len("/api/states/"):]
                    if entity_id in fake.states:
                        self._json(200, fake.states[entity_id])
                    else:
                        self._json(404, {"message": "Entity not found."})
                else:
                    self._json(404, {"message": "Not found."})

            def do_POST(self) -> None:
                if not self._authorized():
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                if not self.path.startswith("/api/services/"):
                    self._json(404, {"message": "Not found."})
                    return
                domain, service = self.path[len("/api/services/"):].split("/", 1)
                fake.calls.append((domain, service, body))
                changed = []
                for entity_id in body.get("entity_id") or []:
                    row = fake.states.get(entity_id)
                    if row is None:
                        continue
                    if service == "turn_on":
                        row["state"] = "on"
                    elif service == "turn_off":
                        row["state"] = "off"
                    changed.append(row)
                self._json(200, changed)

            def _websocket(self) -> None:
                key = self.headers.get("Sec-WebSocket-Key", "")
                accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                  f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
                self.wfile.flush()
                sock = self.connection
                sock.sendall(_frame(json.dumps({"type": "auth_required", "ha_version": "2026.11.0"}).encode()))
                opcode, payload = _read_frame(sock)
                auth = json.loads(payload or b"{}")
                if auth.get("access_token") != TOKEN:
                    sock.sendall(_frame(json.dumps({"type": "auth_invalid", "message": "Invalid access token"}).encode()))
                    return
                sock.sendall(_frame(json.dumps({"type": "auth_ok", "ha_version": "2026.11.0"}).encode()))
                opcode, payload = _read_frame(sock)
                subscribe = json.loads(payload or b"{}")
                sock.sendall(_frame(json.dumps({"id": subscribe.get("id"), "type": "result", "success": True,
                                                "result": None}).encode()))
                fake.bus_clients += 1
                fake.bus_ready.set()
                try:
                    while True:
                        try:
                            data = fake.events.get(timeout=0.2)
                        except queue.Empty:
                            continue
                        if data is None:
                            return
                        sock.sendall(_frame(json.dumps({"id": subscribe.get("id"), "type": "event",
                                                        "event": {"event_type": "state_changed", "data": data}}).encode()))
                except (OSError, ConnectionError):
                    return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_port}"

    def __enter__(self) -> "FakeHomeAssistant":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.events.put(None)
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def push(self, entity_id: str, old: str, new: str) -> None:
        self.events.put({"entity_id": entity_id, "old_state": {"state": old}, "new_state": {"state": new}})


# ---------------------------------------------------------------------- the pieces
class RulesTest(unittest.TestCase):
    def test_urls_are_normalized_and_refused(self):
        self.assertEqual(HA.normalize_url("http://homeassistant.local:8123/"), "http://homeassistant.local:8123")
        for bad in ("homeassistant.local:8123", "ftp://casa", "http://user:pass@casa:8123"):
            with self.assertRaises(HA.HaError):
                HA.normalize_url(bad)

    def test_a_rule_needs_an_entity_and_an_action(self):
        with self.assertRaises(HA.HaError):
            HA.clean_rule({"notify_title": "Hola"})
        with self.assertRaises(HA.HaError):
            HA.clean_rule({"entity_id": "light.salon"})
        rule = HA.clean_rule({"entity_id": "light.salon", "to_state": "on", "notify_title": "Luz encendida"})
        self.assertEqual((rule["enabled"], rule["cooldown_s"], rule["priority"]), (True, 60, "normal"))
        self.assertEqual(rule["name"], "light.salon → on")
        with self.assertRaises(HA.HaError):
            HA.clean_rule({"entity_id": "light.salon", "notify_title": "x", "priority": "cuando sea"})

    def test_matching_honours_the_wildcard_and_the_states(self):
        rule = HA.clean_rule({"entity_id": "light.*", "to_state": "on", "notify_title": "Luz"})
        self.assertTrue(HA.matches(rule, "light.cocina", "off", "on"))
        self.assertFalse(HA.matches(rule, "light.cocina", "on", "off"))
        self.assertFalse(HA.matches(rule, "switch.cocina", "off", "on"))
        rule["enabled"] = False
        self.assertFalse(HA.matches(rule, "light.cocina", "off", "on"))


class ClientTest(unittest.TestCase):
    def test_states_and_a_service_call_go_through_the_rest_api(self):
        with FakeHomeAssistant() as fake:
            client = HA.HaClient(fake.url, TOKEN)
            self.assertEqual(client.api_ok()["location_name"], "Casa Demo")
            states = client.states()
            self.assertEqual(len(states), 3)
            self.assertEqual(HA.entity_out(states[1])["unit"], "°C")
            changed = client.call_service("light", "turn_on", {"entity_id": ["light.salon"]})
            self.assertEqual(changed[0]["state"], "on")
            self.assertEqual(fake.calls, [("light", "turn_on", {"entity_id": ["light.salon"]})])
            self.assertEqual(client.state("light.salon")["state"], "on")

    def test_a_wrong_token_and_a_missing_entity_are_reported(self):
        with FakeHomeAssistant() as fake:
            with self.assertRaises(HA.HaError) as e:
                HA.HaClient(fake.url, "otro").states()
            self.assertEqual(e.exception.code, "auth")
            with self.assertRaises(HA.HaError) as e:
                HA.HaClient(fake.url, TOKEN).state("light.que_no_existe")
            self.assertEqual(e.exception.code, "not_found")
            with self.assertRaises(HA.HaError) as e:
                HA.HaClient("http://127.0.0.1:9", TOKEN, timeout=1).states()
            self.assertEqual(e.exception.code, "unreachable")


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.notified: list[tuple] = []

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def gateway(self, url: str, token: str = TOKEN) -> HA.Gateway:
        settings = {"ha_url": url, "ha_token": token}
        return HA.Gateway(self.app.paths, lambda: settings, clock=self.clock,
                          notify=lambda title, body="", **kw: self.notified.append((title, body, kw)) or {"ok": True, "id": "n1"},
                          emit=lambda t, d=None, **k: self.events.append((t, d)))

    def test_entities_are_filtered_paged_and_cached(self):
        with FakeHomeAssistant() as fake:
            gateway = self.gateway(fake.url)
            listed = gateway.entities()
            self.assertEqual(listed["total"], 3)
            self.assertEqual([e["entity_id"] for e in listed["entities"]], ["binary_sensor.puerta_entrada", "light.salon", "sensor.salon_temperature"])
            self.assertEqual(gateway.entities(domain="light")["total"], 1)
            self.assertEqual(gateway.entities(q="temperatura")["entities"][0]["entity_id"], "sensor.salon_temperature")
            self.assertEqual(gateway.entities(q="SALON")["total"], 2, "accent- and case-insensitive")
            page = gateway.entities(limit=2, offset=2)
            self.assertEqual((len(page["entities"]), page["has_more"]), (1, False))
            fake.states["light.salon"]["state"] = "on"
            self.assertEqual(gateway.entities(domain="light")["entities"][0]["state"], "off", "the few-seconds cache answers")
            self.assertEqual(gateway.entities(domain="light", force=True)["entities"][0]["state"], "on")

    def test_a_service_call_clears_the_cache(self):
        with FakeHomeAssistant() as fake:
            gateway = self.gateway(fake.url)
            self.assertEqual(gateway.entities(domain="light")["entities"][0]["state"], "off")
            answer = gateway.call_service("light", "turn_on", {"entity_id": ["light.salon"]})
            self.assertEqual((answer["service"], answer["count"]), ("light.turn_on", 1))
            self.assertEqual(gateway.entities(domain="light")["entities"][0]["state"], "on")

    def test_rules_are_saved_listed_and_deleted(self):
        gateway = self.gateway("http://127.0.0.1:9")
        rule = gateway.save_rule({"entity_id": "binary_sensor.puerta_entrada", "to_state": "on", "notify_title": "Puerta abierta"})
        self.assertEqual(len(gateway.list_rules()), 1)
        updated = gateway.save_rule({"to_state": "off"}, rule["id"])
        self.assertEqual((updated["id"], updated["to_state"], updated["notify_title"]), (rule["id"], "off", "Puerta abierta"))
        with self.assertRaises(HA.HaError) as e:
            gateway.delete_rule(rule["id"])
        self.assertEqual(e.exception.code, "confirm_required")
        gateway.delete_rule(rule["id"], confirm=True)
        self.assertEqual(gateway.list_rules(), [])
        self.assertEqual(json.loads((Path(self.tmp.name) / "data" / "homeassistant-rules.json").read_text())["rules"], [])

    def test_an_event_fires_the_rule_once_per_cooldown_and_notifies(self):
        with FakeHomeAssistant() as fake:
            gateway = self.gateway(fake.url)
            gateway.save_rule({"entity_id": "binary_sensor.puerta_entrada", "to_state": "on", "notify_title": "Puerta abierta",
                               "notify_body": "Se ha abierto la puerta de entrada", "priority": "high", "cooldown_s": 60,
                               "service_domain": "light", "service_name": "turn_on", "service_data": {"entity_id": ["light.salon"]}})
            fired = gateway.handle_event({"entity_id": "binary_sensor.puerta_entrada", "old_state": {"state": "off"},
                                          "new_state": {"state": "on"}})
            self.assertEqual(len(fired), 1)
            self.assertEqual(self.notified[0][0], "Puerta abierta")
            self.assertEqual(self.notified[0][2]["priority"], "high")
            self.assertEqual(fake.calls[0][:2], ("light", "turn_on"))
            self.assertEqual(gateway.list_rules()[0]["fired"], 1)
            self.assertEqual(gateway.events()[0]["to"], "on")
            again = gateway.handle_event({"entity_id": "binary_sensor.puerta_entrada", "old_state": {"state": "off"},
                                          "new_state": {"state": "on"}})
            self.assertEqual(again, [], "the cooldown holds the second firing")
            self.clock.advance(61)
            self.assertEqual(len(gateway.handle_event({"entity_id": "binary_sensor.puerta_entrada", "old_state": {"state": "off"},
                                                       "new_state": {"state": "on"}})), 1)
            self.assertEqual(gateway.handle_event({"entity_id": "light.salon", "old_state": {"state": "off"},
                                                   "new_state": {"state": "on"}}), [], "another entity does not match")

    def test_the_bus_delivers_a_change_and_the_rule_runs(self):
        with FakeHomeAssistant() as fake:
            gateway = self.gateway(fake.url)
            gateway.save_rule({"entity_id": "sensor.salon_temperature", "to_state": "25.0", "notify_title": "Hace calor"})
            gateway.start()
            try:
                self.assertTrue(fake.bus_ready.wait(5), "the bus connected")
                deadline = time.time() + 5
                while not gateway.connected and time.time() < deadline:
                    time.sleep(0.05)
                self.assertTrue(gateway.connected)
                fake.push("sensor.salon_temperature", "21.5", "25.0")
                deadline = time.time() + 5
                while not self.notified and time.time() < deadline:
                    time.sleep(0.05)
                self.assertEqual(self.notified[0][0], "Hace calor")
                self.assertEqual(gateway.events()[0]["entity_id"], "sensor.salon_temperature")
            finally:
                gateway.stop()

    def test_status_says_what_is_missing_and_what_answers(self):
        gateway = self.gateway("")
        status = gateway.status(probe=True)
        self.assertEqual((status["configured"], status["token_set"]), (False, False))
        with FakeHomeAssistant() as fake:
            status = self.gateway(fake.url).status(probe=True)
            self.assertEqual((status["reachable"], status["version"], status["entities"]), (True, "2026.11.0", 3))
            status = self.gateway(fake.url, "otro").status(probe=True)
            self.assertEqual((status["reachable"], status["code"]), (False, "auth"))

    def test_the_notification_switch_silences_the_rules_and_keeps_the_service(self):
        with FakeHomeAssistant() as fake:
            settings = {"ha_url": fake.url, "ha_token": TOKEN, "ha_notify": False}
            gateway = HA.Gateway(self.app.paths, lambda: settings, clock=self.clock,
                                 notify=lambda title, body="", **kw: self.notified.append((title, body, kw)) or {"ok": True},
                                 emit=lambda t, d=None, **k: self.events.append((t, d)))
            gateway.save_rule({"entity_id": "light.salon", "to_state": "on", "notify_title": "Luz encendida",
                               "service_domain": "light", "service_name": "turn_on", "service_data": {"entity_id": ["light.salon"]}})
            fired = gateway.handle_event({"entity_id": "light.salon", "old_state": {"state": "off"}, "new_state": {"state": "on"}})
            self.assertEqual(self.notified, [], "the switch is off: nothing is pushed")
            self.assertEqual(fired[0]["service"]["count"], 1, "the service still runs")
            self.assertFalse(gateway.status()["notify"])


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.call = lambda tool, /, **args: T.call(self.app.ctx, tool, args)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_the_tools_read_and_act_through_the_gateway(self):
        with FakeHomeAssistant() as fake:
            self.app.set_settings({"ha_url": fake.url, "ha_token": TOKEN})
            listed = self.call("ha_list_entities", domain="light")
            self.assertEqual((listed["total"], listed["entities"][0]["name"]), (1, "Luz del salón"))
            self.assertEqual(self.call("ha_get_state", entity_id="sensor.salon_temperature")["unit"], "°C")
            called = self.call("ha_call_service", domain="light", service="turn_on", data={"entity_id": ["light.salon"]})
            self.assertEqual(called["count"], 1)
            saved = self.call("ha_watch", action="save", entity_id="light.salon", to_state="on", notify_title="Luz encendida")
            self.assertEqual(saved["rule"]["to_state"], "on")
            self.assertEqual(self.call("ha_watch", action="list")["count"], 1)
            self.assertEqual(self.call("ha_watch", action="events")["events"], [])
            self.assertEqual(self.call("ha_watch", action="run", rule=saved["rule"]["id"])["ran"]["rule"], saved["rule"]["id"])
            self.assertEqual(self.call("ha_watch", action="delete", rule=saved["rule"]["id"], confirm=True)["deleted"], saved["rule"]["id"])

    def test_a_missing_configuration_is_reported_plainly(self):
        with self.assertRaises(T.ToolError) as e:
            self.call("ha_list_entities")
        self.assertEqual(e.exception.code, "not_configured")
        with self.assertRaises(T.ToolError) as e:
            self.call("ha_get_state", entity_id="light.salon")
        self.assertEqual(e.exception.code, "not_configured")
        with self.assertRaises(T.ToolError) as e:
            self.call("ha_watch", action="save", entity_id="light.salon")
        self.assertEqual(e.exception.code, "invalid")
        with self.assertRaises(T.ToolError) as e:
            self.call("ha_watch", action="borrar")
        self.assertEqual(e.exception.code, "invalid")


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def test_the_token_is_never_sent_back_and_the_status_is_public(self):
        with FakeHomeAssistant() as fake, Running(self.app) as base:
            status, body = self.post(base + "/api/settings", {"ha_url": fake.url + "/", "ha_token": TOKEN})
            self.assertEqual((status, body["ha_url"], body["ha_token"], body["ha_token_set"]), (200, fake.url, "", True))
            with urllib.request.urlopen(base + "/api/settings") as response:
                public = json.load(response)
            self.assertEqual((public["ha_token"], public["ha_token_set"]), ("", True))
            with urllib.request.urlopen(base + "/api/homeassistant/status?probe=1") as response:
                status_body = json.load(response)
            self.assertEqual((status_body["configured"], status_body["reachable"], status_body["entities"]), (True, True, 3))
            with urllib.request.urlopen(base + "/api/health") as response:
                health = json.load(response)
            self.assertEqual(health["homeassistant"]["configured"], True)
            status, body = self.post(base + "/api/settings", {"ha_url": "casa:8123"})
            self.assertEqual(status, 400)

    def test_the_page_and_its_files_are_served(self):
        with Running(self.app) as base:
            with urllib.request.urlopen(base + "/homeassistant") as response:
                page = response.read().decode()
            self.assertEqual(response.status, 200)
            self.assertIn("Home Assistant", page)
            self.assertIn("/homeassistant/app.js", page)
            with urllib.request.urlopen(base + "/homeassistant/app.js") as response:
                script = response.read().decode()
            self.assertIn("ha_list_entities", script)
            with urllib.request.urlopen(base + "/homeassistant/style.css") as response:
                self.assertEqual(response.headers["Content-Type"], "text/css; charset=utf-8")
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(base + "/homeassistant/../app.py")
            self.assertEqual(e.exception.code, 404)

    def post(self, url: str, body: dict) -> tuple[int, dict]:
        request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)


if __name__ == "__main__":
    unittest.main()