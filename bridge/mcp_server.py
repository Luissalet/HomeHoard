"""Faustus MCP tools. Reads only the local snapshot; no cloud or write tools."""
from mcp.server.fastmcp import FastMCP
from inventory import find, status

mcp = FastMCP("HomeHoard")


@mcp.tool()
def home_find_item(query: str, limit: int = 5) -> dict:
    """Find a household object and return its full location. Accepts Spanish questions and small spelling errors. If there is no match, say so; never invent a location. The timestamp is when the inventory copy was exported."""
    return find(query, limit)


@mcp.tool()
def home_inventory_status() -> dict:
    """Check whether Faustus has a local HomeHoard snapshot and when it was exported."""
    return status()


if __name__ == "__main__":
    mcp.run(transport="stdio")
