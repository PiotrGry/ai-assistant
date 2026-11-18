import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runHeadlessCli, type HeadlessCliProcess } from "../src/headless-cli.js";
import { loadGitHubConfig } from "../src/github/config.js";
import { HeadlessConfigurationError, parseHeadlessOrchestratorConfig } from "../src/runtime/headless-config.js";
import { withJournalContext, type JournalContextSource } from "../src/runtime/journal-context.js";
import { runPreflight, type PreflightCommandResult, type PreflightCommandRunner } from "../src/runtime/preflight.js";
import { RuntimeSqliteStore } from "../src/runtime/sqlite.js";

// An operator reads these messages instead of the source: each one has to say what is wrong.

// Assembled at run time so the file holds no token-shaped literal for the secret scan to find.
const tokenShaped = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

function profile(directory = "/tmp/pirx-startup"): Record<string, unknown> {
  return {
    schemaVersion: 1, databasePath: `${directory}/runtime.sqlite`, workerId: "pirx-worker", provider: "claude-code",
    workerCapabilities: ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"],
    repositories: [{
      repository: "PiotrGry/zdrovena-reconciliation", repositoryRoot: `${directory}/repository`, baseBranch: "develop", baseRevision: "abc1234", remoteName: "origin", testCommands: ["pnpm test"],
      delivery: { releaseBranch: "main", featureWorkflowName: "CI", releaseRequiredChecks: ["CI"], featureRequiredApprovals: 0, releaseRequiredApprovals: 0, featureMergeMethod: "merge", releaseMergeMethod: "merge", requireMergeable: true },
    }],
    worktreeParent: `${directory}/worktrees`, leaseDurationMs: 60_000, shutdownTimeoutMs: 5_000, workerTimeoutMs: 60_000,
    workerOutputBytes: 16_384, workerErrorBytes: 16_384, maximumConsecutiveResumeFailures: 3, cycleIntervalMs: 30_000, errorIntervalMs: 30_000,
    githubProjectOwner: "PiotrGry", githubProjectNumber: 3, githubApiUrl: "https://api.github.com", githubTimeoutMs: 10_000,
  };
}

function repository(change: (item: Record<string, unknown>) => void): Record<string, unknown> {
  const value = profile();
  change((value.repositories as Record<string, unknown>[])[0]!);
  return value;
}

function messageOf(value: unknown): string {
  try { parseHeadlessOrchestratorConfig(value); } catch (error: unknown) {
    assert.ok(error instanceof HeadlessConfigurationError, String(error));
    return error.message;
  }
  return assert.fail("The profile was accepted.");
}

test("a rejected profile names the field that is wrong and the rule it breaks", () => {
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ["interval below the minimum", { ...profile(), cycleIntervalMs: 5_000 }, /cycleIntervalMs must be a whole number from 30000 to \d+/u],
    ["unknown top-level key", { ...profile(), logLevel: "debug" }, /the profile has the unknown key "logLevel"/u],
    ["wrong provider", { ...profile(), provider: "codex" }, /provider must be "claude-code"/u],
    ["relative database path", { ...profile(), databasePath: "runtime.sqlite" }, /databasePath must be an absolute path/u],
    ["unknown capability", { ...profile(), workerCapabilities: ["repository.read", "shell.anything"] }, /workerCapabilities must be a non-empty list drawn from: /u],
    ["no repositories", { ...profile(), repositories: [] }, /repositories must list 1 to 32 repositories/u],
    ["repository without owner", repository((item) => { item.repository = "zdrovena-reconciliation"; }), /repositories\[0\]\.repository must look like "owner\/name"/u],
    ["unknown repository key", repository((item) => { item.branch = "develop"; }), /repositories\[0\] has the unknown key "branch"/u],
    ["base revision is a branch name", repository((item) => { item.baseRevision = "develop"; }), /repositories\[0\]\.baseRevision must be a commit hash/u],
    ["test command with a shell operator", repository((item) => { item.testCommands = ["pnpm test", "pnpm lint && pnpm build"]; }), /repositories\[0\]\.testCommands\[1\] must start with pnpm, npm/u],
    ["no test command while tests.run is granted", repository((item) => { item.testCommands = []; }), /repositories\[0\]\.testCommands must name at least one command/u],
    ["release branch equals base branch", repository((item) => { (item.delivery as Record<string, unknown>).releaseBranch = "develop"; }), /repositories\[0\]\.delivery\.releaseBranch must differ from baseBranch/u],
    ["GitHub URL with a query", { ...profile(), githubApiUrl: "https://api.github.com/?x=1" }, /githubApiUrl must be an http\(s\) URL without credentials, query or fragment/u],
    ["power-off with a shell method", { ...profile(), hostPowerOff: { enabled: true, method: "shell", acceptanceTimeoutMs: 5_000 } }, /hostPowerOff\.method must be "linux-systemctl"/u],
    ["not an object", ["profile"], /the profile must be a JSON object/u],
  ];
  for (const [name, value, expected] of cases) {
    const message = messageOf(value);
    assert.match(message, expected, name);
    assert.match(message, /^Headless orchestrator configuration is invalid: /u, name);
  }
});

test("a rejected profile never repeats a value from the file", () => {
  // A secret-shaped value is rejected by name; an ordinary wrong value is not echoed either.
  const secret = messageOf({ ...profile(), repositories: [{ ...(profile().repositories as Record<string, unknown>[])[0]!, repositoryRoot: `/srv/${tokenShaped}` }] });
  assert.match(secret, /must not contain credentials or secret-shaped values: remove repositories\[0\]\.repositoryRoot/u);
  assert.doesNotMatch(secret, /ghp_/u);
  assert.match(messageOf({ ...profile(), apiKey: "x" }), /remove apiKey/u);
  assert.doesNotMatch(messageOf({ ...profile(), workerId: "worker\u0000with-control-character" }), /with-control-character/u);
  assert.doesNotMatch(messageOf({ ...profile(), "key with spaces and 'quotes'": 1 }), /quotes/u);
});

class Host extends EventEmitter implements HeadlessCliProcess {
  readonly output: Record<string, unknown>[] = [];
  readonly errors: Record<string, unknown>[] = [];
  exitCode: string | number | null | undefined;
  readonly stdout = { write: (value: string) => { this.output.push(JSON.parse(value) as Record<string, unknown>); } };
  readonly stderr = { write: (value: string) => { this.errors.push(JSON.parse(value) as Record<string, unknown>); } };
  public constructor(readonly env: NodeJS.ProcessEnv, readonly argv: readonly string[] = ["node", "headless-cli.js"]) { super(); }
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-startup-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function writeProfile(directory: string, value: unknown): Promise<string> {
  const filename = join(directory, "orchestrator.json");
  await writeFile(filename, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
  return filename;
}

test("a daemon that cannot start always says why", async () => {
  await withDirectory(async (directory) => {
    const start = async (env: NodeJS.ProcessEnv, options = {}): Promise<Record<string, unknown>> => {
      const host = new Host(env);
      assert.equal(await runHeadlessCli(host, options), 1);
      assert.equal(host.errors.length, 1, JSON.stringify(host.errors));
      assert.equal(host.errors[0]!.event, "startup_failed");
      return host.errors[0]!;
    };

    const missing = await start({ PIRX_ORCHESTRATOR_CONFIG: join(directory, "absent.json") });
    assert.equal(missing.outcome, "read_failure");
    assert.equal(missing.reason, `Headless orchestrator configuration could not be read (ENOENT): ${join(directory, "absent.json")}`);

    const noProfile = await start({ HOME: directory, XDG_CONFIG_HOME: join(directory, "xdg") });
    assert.equal(noProfile.outcome, "missing_configuration");
    assert.match(String(noProfile.reason), new RegExp(`No orchestrator profile at ${join(directory, "xdg", "pirx", "orchestrator.json")}`, "u"));

    const notJson = await start({ PIRX_ORCHESTRATOR_CONFIG: await writeProfile(directory, "{ not json") });
    assert.equal(notJson.outcome, "invalid_configuration");
    assert.match(String(notJson.reason), /is not valid JSON: .*orchestrator\.json$/u);

    const wrongField = await start({ PIRX_ORCHESTRATOR_CONFIG: await writeProfile(directory, { ...profile(directory), errorIntervalMs: 1_000 }) });
    assert.equal(wrongField.outcome, "invalid_configuration");
    assert.match(String(wrongField.reason), /errorIntervalMs must be a whole number from 30000/u);

    const valid = await writeProfile(directory, profile(directory));
    const noDatabase = await start({ PIRX_ORCHESTRATOR_CONFIG: valid });
    assert.equal(noDatabase.outcome, "storage_error");
    assert.match(String(noDatabase.reason), /database does not exist/u);

    // Anything else that stops the start, such as missing GitHub credentials, keeps its own message.
    RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") }).close();
    const noLogin = await start({ PIRX_ORCHESTRATOR_CONFIG: valid }, { githubConfigLoader: () => { throw new Error("GitHub CLI authentication is unavailable for github.com. Run gh auth login first."); } });
    assert.equal(noLogin.outcome, "startup_failure");
    assert.equal(noLogin.reason, "Error: GitHub CLI authentication is unavailable for github.com. Run gh auth login first.");

    const leaked = await start({ PIRX_ORCHESTRATOR_CONFIG: valid }, { githubConfigLoader: () => { throw new TypeError(`request failed with token=${tokenShaped}`); } });
    assert.equal(leaked.reason, "TypeError: request failed with token=[REDACTED]");
  });
});

const fine: PreflightCommandResult = { ok: true, stdout: "", stderr: "" };
function commands(overrides: Record<string, PreflightCommandResult> = {}): PreflightCommandRunner {
  const defaults: Record<string, PreflightCommandResult> = {
    "git --version": { ...fine, stdout: "git version 2.43.0\n" },
    "git rev-parse --is-inside-work-tree": { ...fine, stdout: "true\n" },
    "claude --version": { ...fine, stdout: "2.1.325 (Claude Code)\n" },
  };
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const match = Object.entries({ ...defaults, ...overrides }).find(([prefix]) => key.startsWith(prefix));
    return match?.[1] ?? fine;
  };
}

test("--check reports every missing piece at once and exits 1", async () => {
  await withDirectory(async (directory) => {
    // Nothing exists yet: no database, no worktree directory, no advisor build.
    const host = new Host({ PIRX_ORCHESTRATOR_CONFIG: await writeProfile(directory, profile(directory)) }, ["node", "headless-cli.js", "--check"]);
    const exit = await runHeadlessCli(host, {
      githubConfigLoader: () => { throw new Error("GitHub CLI authentication is unavailable for github.com. Run gh auth login first."); },
      preflight: {
        platform: "linux",
        advisorEntry: join(directory, "mcp-server", "dist", "advisor-cli.js"),
        run: commands({
          "git rev-parse --is-inside-work-tree": { ok: false, stdout: "", stderr: "fatal: not a git repository" },
          "claude --version": { ...fine, stdout: "2.1.300 (Claude Code)\n" },
          "bwrap": { ok: false, stdout: "", stderr: "", code: "ENOENT" },
          "socat": { ok: false, stdout: "", stderr: "", code: "ENOENT" },
        }),
      },
    });
    assert.equal(exit, 1);
    const problems = new Map(host.errors.filter((event) => event.event === "preflight").map((event) => [String(event.check), String(event.reason)]));
    assert.deepEqual([...problems.keys()], ["database", "worktreeParent", "repository:PiotrGry/zdrovena-reconciliation:repositoryRoot", "claude", "sandbox:bwrap", "sandbox:socat", "advisor", "github:credentials"]);
    assert.match(problems.get("database")!, /database does not exist.* Run headless-cli\.js --migrate once\./u);
    assert.match(problems.get("worktreeParent")!, /worktrees does not exist\. Create the directory\./u);
    assert.match(problems.get("repository:PiotrGry/zdrovena-reconciliation:repositoryRoot")!, /is not a git checkout/u);
    assert.match(problems.get("claude")!, /Claude Code 2\.1\.300 is installed; 2\.1\.314 or newer is required/u);
    assert.match(problems.get("sandbox:bwrap")!, /apt install bubblewrap/u);
    assert.match(problems.get("advisor")!, /Build the mcp-server package/u);
    assert.match(problems.get("github:credentials")!, /Run gh auth login first/u);
    assert.deepEqual(host.errors.at(-1), { schemaVersion: 1, event: "preflight_finished", outcome: "problems", problems: 8, checks: 9 });
  });
});

test("--check passes on a complete setup, reads the Project once and changes nothing", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "worktrees"));
    await writeFile(join(directory, "advisor-cli.js"), "");
    RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") }).close();
    const host = new Host({ PIRX_ORCHESTRATOR_CONFIG: await writeProfile(directory, profile(directory)) }, ["node", "headless-cli.js", "--check"]);
    let queueReads = 0;
    const exit = await runHeadlessCli(host, {
      githubConfigLoader: (environment) => loadGitHubConfig(environment, { tokenProvider: () => "test-only" }),
      preflight: { platform: "linux", advisorEntry: join(directory, "advisor-cli.js"), run: commands(), readQueue: async () => { queueReads += 1; return { ok: true, detail: "Project PiotrGry/3 was read: 2 item(s)" }; } },
    });
    assert.equal(exit, 0, JSON.stringify(host.errors));
    assert.deepEqual(host.errors, []);
    assert.equal(queueReads, 1);
    assert.deepEqual(host.output.map((event) => event.check ?? event.event), [
      "database", "worktreeParent", "git",
      "repository:PiotrGry/zdrovena-reconciliation:repositoryRoot", "repository:PiotrGry/zdrovena-reconciliation:baseRevision", "repository:PiotrGry/zdrovena-reconciliation:remoteName",
      "claude", "sandbox:bwrap", "sandbox:socat", "advisor", "github:credentials", "github:project", "preflight_finished",
    ]);
    assert.deepEqual(host.output.at(-1), { schemaVersion: 1, event: "preflight_finished", outcome: "ok", problems: 0, checks: 12 });
  });
});

test("preflight names a base revision and a remote the checkout does not have, and survives a failing check", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "worktrees"));
    const config = parseHeadlessOrchestratorConfig(profile(directory));
    const findings = await runPreflight(config, {
      platform: "darwin",
      advisorEntry: join(directory, "absent.js"),
      openDatabase: () => undefined,
      githubCredentials: () => undefined,
      readQueue: async () => { throw new Error("socket hang up"); },
      run: commands({
        "git cat-file": { ok: false, stdout: "", stderr: "fatal: Not a valid object name" },
        "git remote get-url": { ok: false, stdout: "", stderr: "error: No such remote 'origin'" },
        "claude --version": { ok: false, stdout: "", stderr: "", code: "ENOENT" },
      }),
    });
    const problems = new Map(findings.filter((finding) => finding.outcome === "problem").map((finding) => [finding.check, finding.detail]));
    assert.match(problems.get("repository:PiotrGry/zdrovena-reconciliation:baseRevision")!, /Commit abc1234 is not in .*Fetch it, set baseRevision to a commit of develop, or leave it out/u);
    assert.match(problems.get("repository:PiotrGry/zdrovena-reconciliation:remoteName")!, /no git remote named origin/u);
    assert.match(problems.get("claude")!, /not on the daemon's PATH/u);
    assert.match(problems.get("github:project")!, /The check itself failed: socket hang up/u);
    // The sandbox tools are a Linux requirement only.
    assert.equal(findings.some((finding) => finding.check.startsWith("sandbox:")), false);
  });
});

test("a cycle line in the journal carries the Issue, what the worker reported and how long a cooldown lasts", () => {
  const source = (attempt: Record<string, unknown>, availability: Record<string, unknown> = { availability: "available", recordedState: "available" }): JournalContextSource => ({
    tasks: { get: () => ({ outcome: "success", value: { githubReference: { owner: "PiotrGry", repository: "zdrovena-reconciliation", issueNumber: 462 } } }) },
    attempts: { get: () => ({ outcome: "success", value: attempt }) },
    workerAvailability: { evaluate: () => ({ outcome: "success", value: availability }) },
  }) as unknown as JournalContextSource;
  const options = { workerId: "pirx-worker", provider: "claude-code", now: () => "2026-11-17T08:00:00.000Z" };
  const failed = { schemaVersion: 1, event: "cycle", outcome: "failed", reason: "execution:Worker process ended unsuccessfully.", details: { taskId: "gh-462-x", attemptId: "attempt:gh-462-x:1:1" } } as const;

  const crash = withJournalContext(source({ state: "terminal", result: "FAILED", diagnostic: { code: "process_failure", providerMessage: "Error: Sandbox required but unavailable:\n  bubblewrap (bwrap) not installed", exitCode: 1, stage: "process" } }), failed, options);
  assert.deepEqual((crash as { context?: unknown }).context, { issue: "PiotrGry/zdrovena-reconciliation#462", result: "FAILED", code: "process_failure", providerMessage: "Error: Sandbox required but unavailable: bubblewrap (bwrap) not installed", exitCode: 1, stage: "process" });
  assert.equal(crash.reason, failed.reason);

  const limit = withJournalContext(
    source({ state: "terminal", result: "QUOTA_EXHAUSTED", diagnostic: { code: "quota_exhausted" } }, { availability: "unavailable", recordedState: "quota_exhausted", cooldownUntil: "2026-11-17T13:00:00.000Z", reason: "Claude usage limit; token=abc123" }),
    failed, options,
  );
  assert.deepEqual((limit as { context?: unknown }).context, { issue: "PiotrGry/zdrovena-reconciliation#462", result: "QUOTA_EXHAUSTED", code: "quota_exhausted", workerState: "quota_exhausted", cooldownUntil: "2026-11-17T13:00:00.000Z", cooldownReason: "Claude usage limit; token=[REDACTED]" });

  const waiting = withJournalContext(source({}, { availability: "unavailable", recordedState: "quota_exhausted", cooldownUntil: "2026-11-17T13:00:00.000Z" }), { schemaVersion: 1, event: "cycle", outcome: "deferred", reason: "worker_unavailable", details: { outcome: "deferred" } }, options);
  assert.deepEqual((waiting as { context?: unknown }).context, { workerState: "quota_exhausted", cooldownUntil: "2026-11-17T13:00:00.000Z" });

  // Nothing to add, another event kind, or a store that fails: the event passes through untouched.
  const idle = { schemaVersion: 1, event: "cycle", outcome: "idle", reason: "no_runnable_task" } as const;
  assert.equal(withJournalContext(source({}), idle, options), idle);
  const queue = { schemaVersion: 1, event: "queue", outcome: "synchronized" } as const;
  assert.equal(withJournalContext(source({}), queue, options), queue);
  const broken = { tasks: { get: () => { throw new Error("database is locked"); } } } as unknown as JournalContextSource;
  assert.equal(withJournalContext(broken, failed, options), failed);
});
