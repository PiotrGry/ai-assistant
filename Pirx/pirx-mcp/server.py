import platform
import socket

from mcp.server.fastmcp import FastMCP


mcp = FastMCP("Pirx")


@mcp.tool()
def hello(name: str) -> str:
    """Say hello to someone."""
    return f"Hello, {name}!"


@mcp.tool()
def system_info() -> dict[str, str]:
    """Return basic information about the system running Pirx."""
    return {
        "hostname": socket.gethostname(),
        "os": platform.system(),
        "os_realese": platform.release(),
        "archittecture": platform.machine(),
        "pyhon": platform.python_version(),
    }


if __name__ == "__main__":
    mcp.run()
