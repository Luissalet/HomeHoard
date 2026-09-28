"""Faustus MCP tools. Reads only the local snapshot; no cloud or write tools."""
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from inventory import find, list_location, status

mcp = FastMCP("HomeHoard")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def home_find_item(query: str, limit: int = 5) -> dict:
    """Find household objects by name, description, tag or location and return full paths. Accepts Spanish questions and small spelling errors. If there is no match, say so; never invent a location. The timestamp is when the inventory copy was exported."""
    return find(query, limit)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def home_inventory_status() -> dict:
    """Check whether Faustus has a local HomeHoard snapshot and when it was exported."""
    return status()


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def home_list_location(location: str, offset: int = 0, limit: int = 50) -> dict:
    """List all objects in one room, piece of furniture or box, including nested contents. Use a location name, full path or ID. If names are ambiguous, ask which location the user means. Paginate with offset and limit; total_items is the full count."""
    return list_location(location, offset, limit)


if __name__ == "__main__":
    mcp.run(transport="stdio")
