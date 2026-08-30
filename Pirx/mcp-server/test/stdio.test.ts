import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio survives a tool error, accepts a later call and shuts down cleanly", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const serverEntry = resolve(testDirectory, "..", "..", "dist", "index.js");
  const vaultPath = await mkdtemp(join(tmpdir(), "pirx-stdio-vault-"));
  const client = new Client({ name: "pirx-stdio-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      PIRX_OBSIDIAN_VAULT: vaultPath,
      PIRX_GOOGLE_CREDENTIALS_FILE: join(vaultPath, "missing-google-credentials.json"),
      PIRX_GOOGLE_TOKEN_FILE: join(vaultPath, "missing-google-token.json"),
      PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC",
    },
  });

  try {
    await client.connect(transport);
    assert.ok(transport.pid !== null);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "obsidian_read"));
    assert.ok(listed.tools.some((tool) => tool.name === "calendar_list_events"));

    const failure = await client.callTool({
      name: "obsidian_read",
      arguments: { path: "missing.md" },
    });
    assert.equal(failure.isError, true);

    const result = await client.callTool({
      name: "hello",
      arguments: { name: "stdio" },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { greeting: "Hello, stdio!" });

    await client.close();
    assert.equal(transport.pid, null);
  } finally {
    await client.close().catch(() => undefined);
    await rm(vaultPath, { recursive: true, force: true });
  }
});
