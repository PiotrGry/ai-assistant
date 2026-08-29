import { McpServer } from "@modelcontextprotocol/server";

import { registerHelloTool } from "./tools/hello.js";
import { registerSystemTools } from "./tools/system.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "pirx-mcp-server",
    version: "0.1.0",
  });

  registerHelloTool(server);
  registerSystemTools(server);

  return server;
}
