import platform
import socket


def register_system_tools(mcp):

    @mcp.tool()
    def system_info() -> dict[str, str]:
        """Return basic information about the system running Pirx."""
        return {
            "hostname": socket.gethostname(),
            "os": platform.system(),
            "os_release": platform.release(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
        }
