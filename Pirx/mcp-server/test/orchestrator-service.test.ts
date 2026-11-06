import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SystemdOrchestratorServicePort } from "../src/tools/orchestrator-service.js";
import { createMcpServer } from "../src/server.js";
import { ObsidianVault } from "../src/obsidian/vaults.js";
import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";

const realExecute = promisify(execFile);

test("service startup is explicit, fixed, shell-free, bounded and repeatable", async () => {
  const calls: unknown[][] = [];
  const execute = (async (...args: unknown[]) => { calls.push(args); return { stdout: "", stderr: "" }; }) as unknown as typeof realExecute;
  const port = new SystemdOrchestratorServicePort({ platform: "linux", environment: { PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true", HOME: "/home/test", XDG_RUNTIME_DIR: "/run/user/1000", PRIVATE_TOKEN: "do-not-forward" }, execute });
  assert.equal((await port.start()).outcome, "start_requested");
  assert.equal((await port.start()).outcome, "start_requested");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["/usr/bin/systemctl", ["--user", "start", "--no-block", "pirx-orchestrator.service"], { shell: false, env: { HOME: "/home/test", XDG_RUNTIME_DIR: "/run/user/1000" }, timeout: 5_000, maxBuffer: 4_096, encoding: "utf8" }]);
  assert.equal((await new SystemdOrchestratorServicePort({ platform: "linux", environment: {}, execute }).start()).outcome, "unconfigured");
  assert.equal((await new SystemdOrchestratorServicePort({ platform: "darwin", environment: { PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true" }, execute }).start()).outcome, "unsupported_platform");
  assert.equal(calls.length, 2);
  const failing = new SystemdOrchestratorServicePort({ platform: "linux", environment: { PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true" }, execute: (async () => { throw new Error("raw secret diagnostics"); }) as unknown as typeof execute });
  const failed = await failing.start();
  assert.equal(failed.outcome, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("MCP requires exact host authorization before requesting service start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-service-mcp-"));
  let calls = 0;
  const secret = "test-service-secret";
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", XDG_CONFIG_HOME: root, HOME: root, PIRX_ORCHESTRATOR_DATABASE: join(root, "runtime.sqlite") }, obsidianVault: new ObsidianVault(root), githubAuthorizationSecret: secret, orchestratorServicePort: { async start() { calls++; return { outcome: "start_requested", message: "accepted; heartbeat not verified" }; } } });
  const client = new Client({ name: "service-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const denied = await client.callTool({ name: "pirx_orchestrator_start", arguments: {} });
  assert.equal(denied.isError, true); assert.equal(calls, 0);
  const allowed = await client.callTool({ name: "pirx_orchestrator_start", arguments: {}, _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(secret, "pirx_orchestrator_start", {}, "start-service") } });
  assert.notEqual(allowed.isError, true); assert.equal(calls, 1);
  assert.equal((allowed.structuredContent as { outcome: string }).outcome, "start_requested");
});


test("service startup rejects an unverified active runtime before systemctl start", async () => {
  let calls = 0;
  const port = new SystemdOrchestratorServicePort({ platform: "linux", environment: { PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true" },
    checkBinding: () => { throw new Error("mismatch"); },
    execute: (async () => { calls++; return { stdout: "", stderr: "" }; }) as unknown as typeof realExecute,
  });
  assert.equal((await port.start()).outcome, "unconfigured");
  assert.equal(calls, 0);
});

test("invalid runtime profile rejects even an authorized service start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-invalid-profile-"));
  let calls = 0;
  const secret = "test-service-secret";
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", PIRX_ORCHESTRATOR_CONFIG: join(root, "missing.json") }, obsidianVault: new ObsidianVault(root), githubAuthorizationSecret: secret,
    orchestratorServicePort: { async start() { calls++; return { outcome: "start_requested", message: "accepted" }; } },
  });
  const client = new Client({ name: "invalid-config", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([server.connect(b), client.connect(a)]);
  const result = await client.callTool({ name: "pirx_orchestrator_start", arguments: {}, _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(secret, "pirx_orchestrator_start", {}, "invalid-start") } });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { outcome: string }).outcome, "unconfigured");
  assert.equal(calls, 0);
});
