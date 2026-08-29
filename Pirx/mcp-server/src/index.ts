import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";

try {
  await serveStdio(() => createMcpServer());
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Serwer MCP zakończył się błędem: ${message}`);
  process.exitCode = 1;
}
