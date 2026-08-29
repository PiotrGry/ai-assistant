import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("zbudowany serwer komunikuje się przez stdio", async (context) => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const serverEntry = resolve(testDirectory, "..", "..", "dist", "index.js");
  const client = new Client({ name: "pirx-stdio-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: "pipe",
  });

  context.after(async () => {
    await client.close();
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "hello",
    arguments: { name: "stdio" },
  });

  assert.deepEqual(result.structuredContent, { greeting: "Hello, stdio!" });
});
