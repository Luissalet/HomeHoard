"""HomeHoard server: the computer keeps the home (state, photos, maintenance) and serves the web app, the agent tools
and the link with the rest of the family. Standard library only, except the vendored ``hoard_link`` (which needs httpx)
and the stdio MCP bridge (which needs ``mcp``)."""

VERSION = "0.3.0"
SERVICE = "homehoard-bridge"     # the hub identifies the app by this name; it predates the server
APP_ID = "homehoard"


def load_tests(loader, tests, pattern):  # noqa: ARG001 — keeps `unittest discover` out of the vendored hoard_link
    return tests
