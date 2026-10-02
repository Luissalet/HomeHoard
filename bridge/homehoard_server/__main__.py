"""``python -m homehoard_server`` (what the MCP bridge starts when the server is not running); same as ``python bridge/server.py``."""
from .app import serve

if __name__ == "__main__":
    serve()
