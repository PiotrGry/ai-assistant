import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { ObsidianVault } from "../src/obsidian/vaults.js";
import { createMcpServer } from "../src/server.js";
import { SqliteResourceReportPort, type ResourceReportPort } from "../src/tools/resources.js";

const now = 120_000;

async function database(version = 2) {
  const directory = await mkdtemp(join(tmpdir(), "pirx-resource-report-"));
  const filename = join(directory, "resources.sqlite");
  const value = new DatabaseSync(filename);
  value.exec(`
    CREATE TABLE cpu_samples (sampled_at INTEGER PRIMARY KEY, utilization_percent REAL, logical_cores INTEGER NOT NULL, load_1m REAL NOT NULL, load_5m REAL NOT NULL, load_15m REAL NOT NULL, total_memory_bytes INTEGER NOT NULL, free_memory_bytes INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE gpu_samples (sampled_at INTEGER NOT NULL, gpu_index INTEGER NOT NULL, utilization_percent REAL, memory_utilization_percent REAL, vram_used_mb REAL, vram_total_mb REAL, temperature_c REAL, power_w REAL, power_limit_w REAL, fan_percent REAL, pstate TEXT, PRIMARY KEY (sampled_at, gpu_index)) WITHOUT ROWID;
    PRAGMA user_version = ${version};
  `);
  return { directory, filename, value };
}

test("resource report returns bounded ordered CPU/GPU current values, summaries, and history", async () => {
  const fixture = await database();
  try {
    for (const [sampledAt, cpu, gpu] of [[10_000, null, 10], [70_000, 50, 40], [119_000, 100, 90]] as const) {
      fixture.value.prepare("INSERT INTO cpu_samples VALUES (?, ?, 8, 1, 0.8, 0.5, 16000, 4000)").run(sampledAt, cpu);
      fixture.value.prepare("INSERT INTO gpu_samples VALUES (?, 0, ?, 20, 1000, 16000, 50, 100, 320, 20, 'P2')").run(sampledAt, gpu);
    }
    fixture.value.close();
    const result = new SqliteResourceReportPort(fixture.filename).report({ nowMs: now, windowMinutes: 2, pointCount: 2, staleAfterMs: 5_000, gpuIndex: 0 });
    assert.equal(result.outcome, "success");
    if (result.outcome !== "success") return;
    assert.equal(result.report.cpu?.current.utilizationPercent, 100);
    assert.equal(result.report.gpu?.current.utilizationPercent, 90);
    assert.deepEqual(result.report.cpu?.summary, { sampleCount: 3, averageUtilizationPercent: 75, peakUtilizationPercent: 100 });
    assert.equal(result.report.cpu?.history.length, 2);
    assert.equal(result.report.gpu?.history.length, 2);
    assert.ok((result.report.cpu?.history[0]?.sampledAt ?? "") < (result.report.cpu?.history[1]?.sampledAt ?? ""));
    assert.deepEqual(result.report.notices, []);
    assert.equal(JSON.stringify(result).includes(fixture.filename), false);
  } finally { try { fixture.value.close(); } catch { /* already closed */ } await rm(fixture.directory, { recursive: true, force: true }); }
});

test("resource report keeps partial, stale, empty, invalid, schema, and unavailable outcomes explicit", async () => {
  const fixture = await database();
  try {
    fixture.value.prepare("INSERT INTO cpu_samples VALUES (10000, NULL, 8, 1, 0.8, 0.5, 16000, 4000)").run();
    fixture.value.close();
    const port = new SqliteResourceReportPort(fixture.filename);
    const partial = port.report({ nowMs: now, windowMinutes: 2, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 });
    assert.equal(partial.outcome, "success");
    if (partial.outcome === "success") assert.deepEqual(partial.report.notices, ["cpu_stale", "gpu_unavailable"]);
    assert.equal(port.report({ nowMs: now, windowMinutes: 1, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 }).outcome, "no_data");
    assert.equal(port.report({ nowMs: now, windowMinutes: 0, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 }).outcome, "invalid_request");
  } finally { try { fixture.value.close(); } catch { /* already closed */ } await rm(fixture.directory, { recursive: true, force: true }); }

  const gpuOnly = await database();
  try {
    gpuOnly.value.prepare("INSERT INTO gpu_samples VALUES (119000, 0, 80, 20, 1000, 16000, 50, 100, 320, 20, 'P2')").run();
    gpuOnly.value.close();
    const partial = new SqliteResourceReportPort(gpuOnly.filename).report({ nowMs: now, windowMinutes: 1, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 });
    assert.equal(partial.outcome, "success");
    if (partial.outcome === "success") assert.deepEqual(partial.report.notices, ["cpu_unavailable"]);
  } finally { try { gpuOnly.value.close(); } catch { /* already closed */ } await rm(gpuOnly.directory, { recursive: true, force: true }); }

  const malformed = await database();
  try {
    malformed.value.prepare("INSERT INTO cpu_samples VALUES (119000, 999, 8, 1, 0.8, 0.5, 16000, 4000)").run();
    malformed.value.close();
    assert.equal(new SqliteResourceReportPort(malformed.filename).report({ nowMs: now, windowMinutes: 1, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 }).outcome, "invalid_data");
  } finally { try { malformed.value.close(); } catch { /* already closed */ } await rm(malformed.directory, { recursive: true, force: true }); }

  const wrong = await database(1);
  try { wrong.value.close(); assert.equal(new SqliteResourceReportPort(wrong.filename).report({ nowMs: now, windowMinutes: 1, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 }).outcome, "schema_mismatch"); }
  finally { try { wrong.value.close(); } catch { /* already closed */ } await rm(wrong.directory, { recursive: true, force: true }); }
  assert.equal(new SqliteResourceReportPort(join(tmpdir(), `missing-pirx-resources-${Date.now()}.sqlite`)).report({ nowMs: now, windowMinutes: 1, pointCount: 5, staleAfterMs: 5_000, gpuIndex: 0 }).outcome, "unavailable");
});

test("MCP exposes the read-only report as one bounded call", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-resource-mcp-"));
  const calls: unknown[] = [];
  const port: ResourceReportPort = { report(input) { calls.push(input); return { outcome: "no_data", window: { from: new Date(input.nowMs - 60_000).toISOString(), to: new Date(input.nowMs).toISOString() }, notices: ["cpu_unavailable", "gpu_unavailable"] }; } };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations" }, obsidianVault: new ObsidianVault(root), resourceReportPort: port });
  const client = new Client({ name: "pirx-resource-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === "pirx_resource_report");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const result = await client.callTool({ name: "pirx_resource_report", arguments: { windowMinutes: 30, pointCount: 10, gpuIndex: 1 } });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as { outcome: string }).outcome, "no_data");
  assert.equal(calls.length, 1);
});
