import platform
import socket

from mcp.server.fastmcp import FastMCP


mcp = FastMCP("Pirx")


@mcp.tool()
def hello(name: str) -> str:
    """Say hello to someone."""
    return f"Hello, {name}!"


if __name__ == "__main__":
    mcp.run()
