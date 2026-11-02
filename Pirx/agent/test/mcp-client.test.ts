import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PirxMcpClient } from "../src/mcp-client.js";

test("chat forwards runtime configuration to the real MCP child and can pause/resume its SQLite control", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-chat-control-"));
  const filename = join(root, "runtime.sqlite");
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // Exercise the built runtime boundary without adding an agent production dependency.
  const { RuntimeSqliteStore, OrchestratorControlRepository } = await import(pathToFileURL(resolve(directory, "orchestrator", "dist", "index.js")).href);
  const store = RuntimeSqliteStore.open({ filename });
  const at = new Date().toISOString();
  new OrchestratorControlRepository(store).heartbeat("paused", at);
  const saved = process.env.PIRX_ORCHESTRATOR_DATABASE;
  process.env.PIRX_ORCHESTRATOR_DATABASE = filename;
  const client = new PirxMcpClient(resolve(directory, "mcp-server", "dist", "index.js"), 30_000);
  context.after(async () => {
    await client.close(); store.close();
    if (saved === undefined) delete process.env.PIRX_ORCHESTRATOR_DATABASE; else process.env.PIRX_ORCHESTRATOR_DATABASE = saved;
    await rm(root, { recursive: true, force: true });
  });
  await client.connect();
  const status = await client.callTool("pirx_orchestrator_status", {});
  assert.equal(status.isError, false);
  assert.equal(JSON.parse(status.text).snapshot.observedState, "paused");
  for (const action of ["pause", "resume"] as const) {
    const result = await client.callTool("pirx_orchestrator_control", { action, reason: "chat integration regression", operationId: `chat-${action}` }, { operationId: `chat-${action}` });
    assert.equal(result.isError, false, result.text);
    assert.equal(JSON.parse(result.text).requestedMode, action === "pause" ? "paused" : "running");
  }
  assert.equal(client.isReadOnlyTool("pirx_orchestrator_start"), false);
});

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
  assert.equal(client.isReadOnlyTool("hello"), true);
  assert.equal(client.isReadOnlyTool("obsidian_create"), false);
  const unknown = await client.callTool("nieistniejace_narzedzie", {});
  assert.equal(unknown.isError, true);
  assert.equal(unknown.serverUnavailable, false);

  const hello = await client.callTool("hello", { name: "Piotr" });
  assert.equal(hello.isError, false);
  assert.equal(hello.serverUnavailable, false);
  assert.equal(hello.text, '{"greeting":"Hello, Piotr!"}');
});
