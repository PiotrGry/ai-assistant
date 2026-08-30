import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";

let handle: StdioServerHandle | undefined;
let keepAlive: NodeJS.Timeout | undefined;

try {
  handle = serveStdio(() => createMcpServer(), {
    onerror: (error) => {
      console.error(`MCP transport error: ${error.message}`);
    },
  });
  // Keep the child alive while the parent prepares the first initialize frame.
  // A pipe with no bytes buffered does not reliably keep every supported Node
  // version alive, so retain one cheap timer until stdin closes.
  process.stdin.resume();
  keepAlive = setInterval(() => undefined, 60_000);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Serwer MCP zakończył się błędem: ${message}`);
  process.exitCode = 1;
}

process.stdin.once("end", () => {
  if (keepAlive !== undefined) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
  void handle?.close().catch(() => undefined);
});
