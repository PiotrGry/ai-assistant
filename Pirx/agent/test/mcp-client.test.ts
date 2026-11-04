import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PirxMcpClient } from "../src/mcp-client.js";
import { initializeHostEnvironment } from "../src/startup-environment.js";

test("chat forwards runtime configuration to the real MCP child and can pause/resume its SQLite control", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-chat-control-"));
  const filename = join(root, "runtime.sqlite");
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // Exercise the built runtime boundary without adding an agent production dependency.
  const { RuntimeSqliteStore, OrchestratorControlRepository } = await import(pathToFileURL(resolve(directory, "orchestrator", "dist", "index.js")).href);
  const store = RuntimeSqliteStore.open({ filename });
  const at = new Date().toISOString();
  new OrchestratorControlRepository(store).heartbeat("paused", at);
  new OrchestratorControlRepository(store).recordDiagnostic({ schemaVersion: 1, event: "queue", outcome: "invalid_snapshot", reason: "Duplicate Queue Order=10 on closed Issues #48 and #189", details: { provider: "github", affectedIssues: [48, 189], correlationId: "correlation-243", token: "secret-value", context: 'quote " slash \\ unicode Ż😀 '.repeat(80) } }, at);
  const saved = process.env.PIRX_ORCHESTRATOR_DATABASE;
  const savedConfig = process.env.PIRX_CHAT_CONFIG;
  const configFile = join(root, "chat.json");
  await writeFile(configFile, JSON.stringify({ PIRX_ORCHESTRATOR_DATABASE: filename }));
  process.env.PIRX_CHAT_CONFIG = configFile;
  delete process.env.PIRX_ORCHESTRATOR_DATABASE;
  initializeHostEnvironment();
  const client = new PirxMcpClient(resolve(directory, "mcp-server", "dist", "index.js"), 30_000);
  context.after(async () => {
    await client.close(); store.close();
    if (saved === undefined) delete process.env.PIRX_ORCHESTRATOR_DATABASE; else process.env.PIRX_ORCHESTRATOR_DATABASE = saved;
    if (savedConfig === undefined) delete process.env.PIRX_CHAT_CONFIG; else process.env.PIRX_CHAT_CONFIG = savedConfig;
    await rm(root, { recursive: true, force: true });
  });
  await client.connect();
  const status = await client.callTool("pirx_orchestrator_status", {});
  assert.equal(status.isError, false, status.text);
  assert.equal(JSON.parse(status.text).snapshot.observedState, "paused");
  assert.match(JSON.parse(status.text).snapshot.diagnostics[0].reason, /Duplicate Queue Order/u);
  const diagnostic = await client.callTool("pirx_orchestrator_diagnostic", { sequence: 1 });
  assert.equal(diagnostic.isError, false);
  assert.deepEqual(JSON.parse(JSON.parse(diagnostic.text).diagnostic.text).details.affectedIssues, [48, 189]);
  const smallStatus = await client.callTool("pirx_orchestrator_status", {}, undefined, 256);
  assert.ok(smallStatus.text.length <= 256);
  const summary = JSON.parse(smallStatus.text);
  assert.equal(summary.truncated, true);
  assert.equal(summary.snapshot.diagnostics[0].sequence, 1);
  assert.equal(summary.snapshot.diagnostics[0].details.correlationId, "correlation-243");
  const expected = JSON.parse(diagnostic.text).diagnostic.text as string;
  assert.ok(!expected.includes("secret-value"));
  let offset = 0;
  let collected = "";
  do {
    const page = await client.callTool("pirx_orchestrator_diagnostic", { sequence: 1, offset }, undefined, 256);
    assert.ok(page.text.length <= 256);
    const chunk = JSON.parse(page.text).diagnostic as { offset: number; text: string; nextOffset?: number };
    assert.equal(chunk.offset, offset);
    collected += chunk.text;
    if (chunk.nextOffset === undefined) break;
    assert.equal(chunk.nextOffset, offset + chunk.text.length);
    assert.ok(chunk.nextOffset > offset);
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(collected, expected);
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
