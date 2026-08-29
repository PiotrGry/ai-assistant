import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PirxMcpClient } from "../src/mcp-client.js";

test("błędna nazwa narzędzia nie wyłącza serwera MCP", async (context) => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const pirxDirectory = resolve(testDirectory, "..", "..", "..");
  const client = new PirxMcpClient(
    resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    30_000,
  );

  context.after(async () => {
    await client.close();
  });

  await client.connect();
  const unknown = await client.callTool("nieistniejace_narzedzie", {});
  assert.equal(unknown.isError, true);
  assert.equal(unknown.serverUnavailable, false);

  const hello = await client.callTool("hello", { name: "Piotr" });
  assert.equal(hello.isError, false);
  assert.equal(hello.serverUnavailable, false);
  assert.equal(hello.text, '{"greeting":"Hello, Piotr!"}');
});
