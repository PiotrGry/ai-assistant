import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadMcpServerConfig, loadGoogleCalendarConfig } from "../src/config.js";

test("MCP configuration uses the existing environment-based approach", () => {
  const config = loadMcpServerConfig({
    XDG_CONFIG_HOME: "/tmp/pirx-legacy-config-fixture",
    PIRX_OBSIDIAN_VAULT: "/tmp/pirx-vault",
    PIRX_GOOGLE_CREDENTIALS_FILE: "/tmp/pirx-creds.json",
    PIRX_GOOGLE_TOKEN_FILE: "/tmp/pirx-token.json",
    PIRX_GOOGLE_CALENDAR_ID: "work@example.com",
    PIRX_GOOGLE_CALENDAR_TIMEZONE: "Europe/Warsaw",
    PIRX_GOOGLE_TIMEOUT_MS: "4321",
    PIRX_GOOGLE_AUTH_TIMEOUT_MS: "9876",
    PIRX_GITHUB_POC_ISSUE: "179",
    PIRX_ORCHESTRATOR_DATABASE: "/tmp/pirx-runtime.sqlite",
    PIRX_GPU_DB: "/tmp/pirx-resources.sqlite",
  });

  assert.equal(config.obsidianVaultPath, resolve("/tmp/pirx-vault"));
  assert.ok(config.googleCalendar);
  assert.equal(config.googleCalendar.credentialsFile, resolve("/tmp/pirx-creds.json"));
  assert.equal(config.googleCalendar.tokenFile, resolve("/tmp/pirx-token.json"));
  assert.equal(config.googleCalendar.defaultCalendarId, "work@example.com");
  assert.equal(config.googleCalendar.defaultTimeZone, "Europe/Warsaw");
  assert.equal(config.googleCalendar.requestTimeoutMs, 4_321);
  assert.equal(config.googleCalendar.authorizationTimeoutMs, 9_876);
  assert.equal(config.githubPocIssue, 179);
  assert.equal(config.orchestratorDatabasePath, resolve("/tmp/pirx-runtime.sqlite"));
  assert.equal(config.resourceDatabasePath, resolve("/tmp/pirx-resources.sqlite"));
  assert.equal(config.githubPocConfigurationError, undefined);
});

test("MCP configuration uses the project vault by default", () => {
  const config = loadMcpServerConfig({});
  assert.equal(config.obsidianVaultPath?.endsWith("/Pirx/vault"), true);
  assert.equal(config.resourceDatabasePath.endsWith("/.local/share/pirx/gpu.sqlite"), true);
});

test("MCP configuration rejects invalid timeouts and timezones", () => {
  assert.throws(
    () => loadGoogleCalendarConfig({ PIRX_GOOGLE_TIMEOUT_MS: "0" }),
    /positive integer/u,
  );
  assert.throws(
    () =>
      loadGoogleCalendarConfig({
        PIRX_GOOGLE_CALENDAR_TIMEZONE: "Not/A_Real_Timezone",
      }),
    /valid IANA timezone/u,
  );
});

test("MCP keeps invalid optional GitHub POC configuration controlled", () => {
  const config = loadMcpServerConfig({ PIRX_GITHUB_POC_ISSUE: "0" });
  assert.equal(config.githubPocIssue, undefined);
  assert.match(config.githubPocConfigurationError ?? "", /positive integer/u);
});

function validConfig(directory = "/tmp/pirx-headless"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    databasePath: `${directory}/runtime.sqlite`,
    workerId: "pirx-worker",
    provider: "claude-code",
    workerCapabilities: ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"],
    repositories: [{
      repository: "PiotrGry/ai-assistant", repositoryRoot: "/tmp/pirx-repository", baseBranch: "develop", baseRevision: "a".repeat(40), remoteName: "origin", testCommands: ["npm run check"],
      delivery: { releaseBranch: "main", featureWorkflowName: "CI", releaseRequiredChecks: ["CI"], featureRequiredApprovals: 0, releaseRequiredApprovals: 0, featureMergeMethod: "merge", releaseMergeMethod: "merge", requireMergeable: true },
    }],
    worktreeParent: `${directory}/worktrees`,
    leaseDurationMs: 60_000,
    shutdownTimeoutMs: 5_000,
    workerTimeoutMs: 120_000,
    workerOutputBytes: 16_384,
    workerErrorBytes: 16_384,
    maximumConsecutiveResumeFailures: 3,
    cycleIntervalMs: 30_000,
    errorIntervalMs: 60_000,
    githubProjectOwner: "PiotrGry",
    githubProjectNumber: 3,
    githubApiUrl: "https://api.github.com",
    githubTimeoutMs: 10_000,
  };
}

test("MCP and the daemon use the same runtime profile and reject a conflicting legacy path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-shared-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pirx"));
  const path = join(root, "pirx", "orchestrator.json");
  await writeFile(path, JSON.stringify(validConfig(root)));
  const environment = { XDG_CONFIG_HOME: root, PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true" };
  const config = loadMcpServerConfig(environment);
  assert.equal(config.orchestratorDatabasePath, join(root, "runtime.sqlite"));
  const conflict = loadMcpServerConfig({ ...environment, PIRX_ORCHESTRATOR_DATABASE: join(root, "wrong.sqlite") });
  assert.equal(conflict.orchestratorDatabasePath, undefined);
  assert.match(conflict.orchestratorConfigurationError ?? "", /conflicts/u);
  const { loadHeadlessOrchestratorConfig } = await import("@pirx/orchestrator");
  assert.equal((await loadHeadlessOrchestratorConfig(environment)).databasePath, config.orchestratorDatabasePath);
  const missing = loadMcpServerConfig({ ...environment, PIRX_ORCHESTRATOR_CONFIG: join(root, "missing.json"), PIRX_ORCHESTRATOR_DATABASE: join(root, "runtime.sqlite") });
  assert.equal(missing.orchestratorDatabasePath, undefined);
  assert.match(missing.orchestratorConfigurationError ?? "", /could not be read/u);
});


test("invalid Calendar configuration does not prevent other MCP tools from starting", async () => {
  const environment = { PIRX_GOOGLE_TIMEOUT_MS: "0" };
  const config = loadMcpServerConfig(environment);
  assert.equal(config.googleCalendar, undefined);
  assert.match(config.googleCalendarConfigurationError ?? "", /PIRX_GOOGLE_TIMEOUT_MS/);
  const { createMcpServer } = await import("../src/server.js");
  const server = createMcpServer({ environment });
  const client = new Client({ name: "calendar-isolation", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const healthy = await client.callTool({ name: "hello", arguments: { name: "Pirx" } });
    assert.notEqual(healthy.isError, true);
    const calendar = await client.callTool({ name: "calendar_list_calendars", arguments: {} });
    assert.equal(calendar.isError, true);
    assert.match(JSON.stringify(calendar), /PIRX_GOOGLE_TIMEOUT_MS/);
  } finally { await client.close(); await server.close(); }
});
