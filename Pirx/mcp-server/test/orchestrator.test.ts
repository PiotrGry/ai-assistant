import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { OrchestratorControlRequest, OrchestratorStatusSnapshot, UtcTimestamp } from "@pirx/orchestrator";

import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";
import { ObsidianVault } from "../src/obsidian/vaults.js";
import { createMcpServer } from "../src/server.js";
import type { OrchestratorControlToolPort } from "../src/tools/orchestrator.js";

const now = "2026-10-30T13:00:00.000Z" as UtcTimestamp;

class FakeControl implements OrchestratorControlToolPort {
  calls: OrchestratorControlRequest[] = [];
  mode: "running" | "paused" = "running";
  version = 1;
  readonly snapshot: OrchestratorStatusSnapshot = { schemaVersion: 1, requestedMode: "running", observedState: "running", version: 1, heartbeatAt: now, heartbeatStale: false, activeTask: { id: "task-211", state: "in_progress", issueNumber: 211 }, nextQueuedTask: { id: "task-212", state: "ready", issueNumber: 212, queueOrder: 500 } };
  status() { return { outcome: "success" as const, value: { ...this.snapshot, requestedMode: this.mode, version: this.version } }; }
  request(input: OrchestratorControlRequest) { this.calls.push(input); this.mode = input.action === "pause" ? "paused" : "running"; this.version += 1; return { outcome: "applied" as const, operationId: input.operationId, record: { schemaVersion: 1 as const, requestedMode: this.mode, requestedAt: input.requestedAt, requestedBy: input.requestedBy, reason: input.reason, version: this.version, observedState: "running" as const, heartbeatAt: now }, message: "applied" }; }
}

test("MCP reads bounded status and requires exact authorization for pause/resume", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-orchestrator-mcp-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const control = new FakeControl();
  const secret = "orchestrator-test-secret";
  const server = createMcpServer({ environment: {}, obsidianVault: new ObsidianVault(root), orchestratorControlPort: control, githubAuthorizationSecret: secret });
  const client = new Client({ name: "pirx-orchestrator-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });

  const status = await client.callTool({ name: "pirx_orchestrator_status", arguments: { staleAfterMs: 120_000 } });
  assert.notEqual(status.isError, true);
  assert.equal((status.structuredContent as { snapshot: { activeTask: { issueNumber: number } } }).snapshot.activeTask.issueNumber, 211);
  assert.equal(JSON.stringify(status.structuredContent).includes("prompt"), false);

  const arguments_ = { action: "pause" as const, reason: "operator review", operationId: "pause-211" };
  const denied = await client.callTool({ name: "pirx_orchestrator_control", arguments: arguments_ });
  assert.equal(denied.isError, true);
  assert.equal(control.calls.length, 0);
  const allowed = await client.callTool({ name: "pirx_orchestrator_control", arguments: arguments_, _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(secret, "pirx_orchestrator_control", arguments_, arguments_.operationId) } });
  assert.notEqual(allowed.isError, true);
  assert.equal((allowed.structuredContent as { requestedMode: string }).requestedMode, "paused");
  assert.equal(control.calls.length, 1);
});

test("unconfigured orchestrator tools remain listed and return controlled results", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-orchestrator-unconfigured-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ environment: {}, obsidianVault: new ObsidianVault(root) });
  const client = new Client({ name: "pirx-orchestrator-unconfigured", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "pirx_orchestrator_status"), true);
  const status = await client.callTool({ name: "pirx_orchestrator_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(JSON.stringify(status.structuredContent), /unconfigured/u);
});
