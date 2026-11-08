import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const directory = process.env.PIRX_RECONNECT_FIXTURE_DIRECTORY;
if (directory === undefined) throw new Error("PIRX_RECONNECT_FIXTURE_DIRECTORY is required");

const starts = join(directory, "starts.txt");
const effects = join(directory, "effects.txt");
let generation = 1;
try { generation = readFileSync(starts, "utf8").trim().split("\n").filter(Boolean).length + 1; }
catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
appendFileSync(starts, `${process.pid}\n`, "utf8");

const server = new McpServer({ name: "pirx-reconnect-fixture", version: "1.0.0" });
server.registerTool("fixture_read", {
  description: "Read without side effects.",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ value }) => ({ content: [{ type: "text", text: value }], structuredContent: { value } }));

server.registerTool("fixture_effect_count", {
  description: "Read the number of fixture effects.",
  inputSchema: z.object({}),
  outputSchema: z.object({ count: z.number() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  let count = 0;
  try { count = readFileSync(effects, "utf8").trim().split("\n").filter(Boolean).length; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { content: [{ type: "text", text: String(count) }], structuredContent: { count } };
});

server.registerTool("fixture_write_then_exit", {
  description: "Record one effect and lose the response connection.",
  inputSchema: z.object({ value: z.string() }),
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ value }) => {
  appendFileSync(effects, `${value}\n`, "utf8");
  process.exit(23);
});

server.registerTool("fixture_stall_read", {
  description: "Never finish a read response.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => new Promise<never>(() => undefined));

if (generation > 1) {
  server.registerTool("fixture_after_restart", {
    description: "Prove that tools/list was refreshed after restart.",
    inputSchema: z.object({}),
    outputSchema: z.object({ generation: z.number() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: String(generation) }], structuredContent: { generation } }));
}

const handle = serveStdio(() => server);
process.stdin.resume();
const keepAlive = setInterval(() => undefined, 60_000);
process.stdin.once("end", () => {
  clearInterval(keepAlive);
  void handle.close().catch(() => undefined);
});
