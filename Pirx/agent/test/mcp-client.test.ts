import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PirxMcpClient } from "../src/mcp-client.js";
import { initializeHostEnvironment } from "../src/startup-environment.js";
import { loadConfig } from "../src/config.js";

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
  const savedXdgConfig = process.env.XDG_CONFIG_HOME;
  const savedToolProfile = process.env.PIRX_TOOL_PROFILE;
  process.env.XDG_CONFIG_HOME = root;
  const configFile = join(root, "chat.json");
  await writeFile(configFile, JSON.stringify({ PIRX_TOOL_PROFILE: "operations", PIRX_ORCHESTRATOR_DATABASE: filename }));
  process.env.PIRX_CHAT_CONFIG = configFile;
  delete process.env.PIRX_ORCHESTRATOR_DATABASE;
  delete process.env.PIRX_TOOL_PROFILE;
  initializeHostEnvironment();
  const profile = loadConfig(process.env).toolProfile;
  const client = new PirxMcpClient(resolve(directory, "mcp-server", "dist", "index.js"), 30_000, 12_000, undefined, profile);
  context.after(async () => {
    await client.close(); store.close();
    if (saved === undefined) delete process.env.PIRX_ORCHESTRATOR_DATABASE; else process.env.PIRX_ORCHESTRATOR_DATABASE = saved;
    if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdgConfig;
    if (savedConfig === undefined) delete process.env.PIRX_CHAT_CONFIG; else process.env.PIRX_CHAT_CONFIG = savedConfig;
    if (savedToolProfile === undefined) delete process.env.PIRX_TOOL_PROFILE; else process.env.PIRX_TOOL_PROFILE = savedToolProfile;
    await rm(root, { recursive: true, force: true });
  });
  await client.connect();
  assert.equal(profile, "operations");
  assert.ok(client.toolNames.includes("pirx_orchestrator_status"));
  assert.ok(client.toolNames.includes("github_issue_get"));
  assert.ok(!client.toolNames.includes("obsidian_read"));
  assert.ok(!client.toolNames.includes("calendar_list_events"));
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
  const workArguments = {
    operationId: "cross-process-work-231",
    repository: "PiotrGry/ai-assistant",
    issueNumber: 231,
    goal: "Add Pirx CI checks and cross-process acceptance tests",
    acceptanceCriteria: ["request survives chat restart", "normal Queue remains the only dispatcher"],
    priority: "P2",
    risk: "Medium",
    area: "Orchestrator",
    workType: "Task",
    queueOrder: 231,
  };
  const submitted = await client.callTool("pirx_work_submit", workArguments, { operationId: workArguments.operationId });
  assert.equal(submitted.isError, false, submitted.text);
  const receipt = JSON.parse(submitted.text) as { outcome: string; intake: { id: string; state: string } };
  assert.equal(receipt.outcome, "accepted_pending");
  assert.equal(receipt.intake.state, "accepted");
  const tasksBeforeRestart = store.tasks.list();
  assert.equal(tasksBeforeRestart.outcome === "success" ? tasksBeforeRestart.value.length : -1, 0);
  await client.close();

  const restarted = new PirxMcpClient(resolve(directory, "mcp-server", "dist", "index.js"), 30_000, 12_000, undefined, profile);
  context.after(async () => { await restarted.close(); });
  await restarted.connect();
  const persisted = await restarted.callTool("pirx_work_status", { intakeId: receipt.intake.id });
  assert.equal(persisted.isError, false, persisted.text);
  assert.equal((JSON.parse(persisted.text) as { intake: { operationId: string; state: string } }).intake.operationId, workArguments.operationId);
  assert.equal((JSON.parse(persisted.text) as { intake: { state: string } }).intake.state, "accepted");
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
  assert.equal(unknown.outcome, "failed_before_execution");

  const hello = await client.callTool("hello", { name: "Piotr" });
  assert.equal(hello.isError, false);
  assert.equal(hello.serverUnavailable, false);
  assert.equal(hello.text, '{"greeting":"Hello, Piotr!"}');
});

async function lines(filename: string): Promise<string[]> {
  try { return (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("a real MCP process reconnects reads, never replays an interrupted mutation, and respects the supplied deadline", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-mcp-reconnect-"));
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const pirxDirectory = resolve(testDirectory, "..", "..", "..");
  const fixture = resolve(pirxDirectory, "mcp-server", "dist-test", "test", "fixtures", "restarting-mcp-server.js");
  const wrapper = join(root, "server.mjs");
  await writeFile(wrapper, `process.env.PIRX_RECONNECT_FIXTURE_DIRECTORY=${JSON.stringify(root)};\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`, "utf8");
  const client = new PirxMcpClient(wrapper, 2_000);
  context.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });

  await client.connect();
  const firstPid = Number((await lines(join(root, "starts.txt")))[0]);
  assert.ok(Number.isSafeInteger(firstPid) && firstPid > 0);
  process.kill(firstPid, "SIGKILL");

  const recovered = await client.callTool("fixture_read", { value: "after restart" }, undefined, 1_024, 2_000);
  assert.equal(recovered.outcome, "succeeded", recovered.text);
  assert.deepEqual(JSON.parse(recovered.text), { value: "after restart" });
  const restarted = await lines(join(root, "starts.txt"));
  assert.ok(restarted.length >= 2);
  assert.notEqual(Number(restarted.at(-1)), firstPid);
  assert.ok(client.toolNames.includes("fixture_after_restart"));

  const mutation = await client.callTool("fixture_write_then_exit", { value: "exactly-once" }, undefined, 1_024, 2_000);
  assert.equal(mutation.outcome, "unknown");
  assert.equal(mutation.serverUnavailable, true);
  assert.deepEqual(await lines(join(root, "effects.txt")), ["exactly-once"]);

  const count = await client.callTool("fixture_effect_count", {}, undefined, 1_024, 2_000);
  assert.equal(count.outcome, "succeeded", count.text);
  assert.deepEqual(JSON.parse(count.text), { count: 1 });
  assert.deepEqual(await lines(join(root, "effects.txt")), ["exactly-once"]);

  const startedAt = performance.now();
  const stalled = await client.callTool("fixture_stall_read", {}, undefined, 1_024, 80);
  const duration = performance.now() - startedAt;
  assert.equal(stalled.outcome, "confirmed_failure");
  assert.ok(duration < 500, `stalled read took ${duration} ms`);
});
