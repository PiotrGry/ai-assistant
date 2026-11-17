import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  GitHubQueueReconciler,
  GitHubQueueSynchronizer,
  HeadlessOrchestratorService,
  ProductionClaudeWorker,
  ProductionRuntime,
  RuntimeSqliteStore,
  SqliteHeadlessControlPort,
  WorkIntakeCoordinator,
  WorkIntakeQueueReconciler,
  loadGitHubConfig,
  success,
  type AttemptSnapshot,
  type GitHubIssueSummary,
  type GitHubQueueIssue,
  type TaskSnapshot,
} from "@pirx/orchestrator";

import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";
import { createMcpServer } from "../src/server.js";

// Shared setup for the end-to-end tests. Everything is real except two things:
//   - GitHub's network: an in-memory Issue list and Project board stand in for it;
//   - the Claude binary: a script on PATH that speaks the same CLI contract and follows a plan.
// Real: the chat MCP tools, runtime.sqlite, the daemon, intake, Queue, Lease, Attempt, the git
// worktree, the Claude CLI runner, the push, and the status the chat reads back.

const run = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

export const E2E_OWNER = "PiotrGry";
export const E2E_REPOSITORY_NAME = "e2e-fixture";
export const E2E_REPOSITORY = `${E2E_OWNER}/${E2E_REPOSITORY_NAME}`;
const CAPABILITIES = ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"];
const SECRET = "e2e-host-secret";

/** What the fake Claude does on one invocation, in order. The last step repeats. */
export type ClaudeStep =
  | { readonly do: "commit"; readonly content?: string }
  | { readonly do: "quota"; readonly resetInMs: number }
  /** A limit reported only as text, with no machine-readable reset time. */
  | { readonly do: "quota_text"; readonly message: string }
  | { readonly do: "ask_operator"; readonly question: string }
  | { readonly do: "crash"; readonly stderr: string };

/** One recorded invocation of the fake Claude. */
export interface ClaudeCall { readonly at: string; readonly mode: string; readonly attemptId: string; readonly prompt: string }

// Speaks the part of the Claude Code CLI contract the worker adapter relies on: the version
// probe, the input envelope as an argument, stream-json events and a final result line.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.325 (Claude Code)\\n"); process.exit(0); }
const prompt = args.find((value) => value.includes('"kind":"claude_code_input"'));
if (prompt === undefined) { process.stderr.write("fake claude: no input envelope in arguments"); process.exit(2); }
const input = JSON.parse(prompt.split("\\n\\n").find((part) => part.startsWith("{") && part.includes('"kind":"claude_code_input"')));
const calls = path.join(__dirname, "calls.jsonl");
const count = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(calls, JSON.stringify({ at: new Date().toISOString(), mode: input.mode, attemptId: input.attemptId, prompt }) + "\\n");
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "plan.json"), "utf8"));
const step = plan[Math.min(count, plan.length - 1)];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const common = { kind: "worker_result", schemaVersion: 1, taskId: input.taskId, attemptId: input.attemptId, correlationId: input.correlationId };
emit({ type: "system", subtype: "init" });
if (step.do === "crash") { process.stderr.write(step.stderr); process.exit(1); }
if (step.do === "quota") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, error_code: "quota_exhausted", reset_at: new Date(Date.now() + step.resetInMs).toISOString(), result: "You've hit your session limit" });
  process.exit(1);
}
if (step.do === "quota_text") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: step.message });
  process.exit(1);
}
if (step.do === "ask_operator") {
  emit({ type: "result", subtype: "success", is_error: false, structured_output: { ...common, outcome: "BLOCKED", reason: step.question, diagnostic: { schemaVersion: 1, code: "operator_input_required", message: "Worker requires an authorized operator decision before it can continue." } } });
  process.exit(0);
}
const git = (...a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8" }).trim();
fs.writeFileSync("tracked.txt", (step.content || "fixed") + "\\n");
git("add", "tracked.txt");
git("-c", "user.name=Pirx E2E", "-c", "user.email=pirx-e2e@example.invalid", "commit", "-q", "-m", "fix: tracked fixture");
emit({ type: "result", subtype: "success", is_error: false, structured_output: { ...common, outcome: "CODE_COMMITTED", branch: input.workspace.branch, finalCommit: git("rev-parse", "HEAD"), pullRequestTitle: "fix: tracked fixture", pullRequestBody: "## What\\nFixed the tracked fixture file." } });
`;

export interface E2eIssue {
  readonly number: number;
  readonly goal: string;
  readonly criteria: readonly string[];
  /** Overrides the body built from goal and criteria, e.g. to break the planning contract. */
  readonly body?: string;
}

export function issueBody(issue: E2eIssue): string {
  return issue.body ?? `## Goal\n\n${issue.goal}\n\n## Implementation scope\n\n- tracked.txt only\n\n## Acceptance criteria\n\n${issue.criteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}`;
}

interface ProjectFields { status: string; priority: string; worker: string; risk: string; workType: string; queueOrder: number }

export interface ChatSession {
  /** Calls a tool the way the chat host does: mutating tools carry an exact host authorization. */
  call(name: string, args: Record<string, unknown>, options?: { readonly authorize?: boolean; readonly operationId?: string }): Promise<{ readonly isError: boolean; readonly value: Record<string, unknown> }>;
  close(): Promise<void>;
}

export interface Daemon {
  readonly events: readonly Record<string, unknown>[];
  /** Asks the daemon to stop like systemd does and returns its exit code. */
  stop(): Promise<number>;
}

export class E2eFixture {
  readonly issues = new Map<number, E2eIssue>();
  readonly #project = new Map<number, ProjectFields>();
  #savedPath: string | undefined;
  #stores: RuntimeSqliteStore[] = [];
  #daemons: Daemon[] = [];
  #observer: RuntimeSqliteStore | undefined;

  private constructor(readonly root: string, readonly base: string) {}
  get repositoryRoot(): string { return join(this.root, "repository"); }
  get remote(): string { return join(this.root, "origin.git"); }
  get databasePath(): string { return join(this.root, "runtime.sqlite"); }
  get configPath(): string { return join(this.root, "orchestrator.json"); }
  get #bin(): string { return join(this.root, "bin"); }

  static async create(): Promise<E2eFixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pirx-e2e-")));
    const repositoryRoot = join(root, "repository");
    await mkdir(repositoryRoot); await mkdir(join(root, "worktrees")); await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "claude"), FAKE_CLAUDE, { mode: 0o700 });
    await chmod(join(root, "bin", "claude"), 0o700);
    await git(root, "init", "-q", "--bare", join(root, "origin.git"));
    await git(root, "init", "-q", "-b", "develop", repositoryRoot);
    await git(repositoryRoot, "config", "user.name", "Pirx E2E");
    await git(repositoryRoot, "config", "user.email", "pirx-e2e@example.invalid");
    await writeFile(join(repositoryRoot, "tracked.txt"), "broken\n");
    await git(repositoryRoot, "add", "tracked.txt"); await git(repositoryRoot, "commit", "-q", "-m", "base");
    const base = await git(repositoryRoot, "rev-parse", "HEAD");
    await git(repositoryRoot, "remote", "add", "origin", join(root, "origin.git"));
    await git(repositoryRoot, "push", "-q", "origin", "develop");
    const fixture = new E2eFixture(root, base);
    // The same profile file binds the daemon and the chat tools, as in a real installation.
    await writeFile(fixture.configPath, JSON.stringify({
      schemaVersion: 1, databasePath: fixture.databasePath, workerId: "pirx-worker", provider: "claude-code", workerCapabilities: CAPABILITIES,
      repositories: [{
        repository: E2E_REPOSITORY, repositoryRoot, baseBranch: "develop", baseRevision: base, remoteName: "origin", testCommands: ["node --version"],
        delivery: { releaseBranch: "main", featureWorkflowName: "CI", releaseRequiredChecks: ["CI"], featureRequiredApprovals: 0, releaseRequiredApprovals: 0, featureMergeMethod: "merge", releaseMergeMethod: "merge", requireMergeable: true },
      }],
      worktreeParent: join(root, "worktrees"), leaseDurationMs: 60_000, shutdownTimeoutMs: 5_000, workerTimeoutMs: 60_000,
      workerOutputBytes: 16_384, workerErrorBytes: 16_384, maximumConsecutiveResumeFailures: 3,
      cycleIntervalMs: 30_000, errorIntervalMs: 30_000,
      githubProjectOwner: E2E_OWNER, githubProjectNumber: 3, githubApiUrl: "https://api.github.com", githubTimeoutMs: 10_000,
    }), { mode: 0o600 });
    RuntimeSqliteStore.open({ filename: fixture.databasePath }).close();
    // The Claude runner resolves the executable through the daemon process environment.
    fixture.#savedPath = process.env.PATH;
    process.env.PATH = `${join(root, "bin")}${delimiter}${fixture.#savedPath ?? ""}`;
    await fixture.planClaude([{ do: "commit" }]);
    return fixture;
  }

  async planClaude(steps: readonly ClaudeStep[]): Promise<void> { await writeFile(join(this.#bin, "plan.json"), JSON.stringify(steps)); }

  async claudeCalls(): Promise<ClaudeCall[]> {
    try { return (await readFile(join(this.#bin, "calls.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ClaudeCall); }
    catch { return []; }
  }

  addIssue(issue: E2eIssue): void { this.issues.set(issue.number, issue); }

  /** Puts an Issue on the Project board as the operator would in GitHub, without the chat. */
  queueOnProject(issueNumber: number, queueOrder: number): void {
    this.#project.set(issueNumber, { status: "Todo", priority: "P1", worker: "Pirx", risk: "Low", workType: "Task", queueOrder });
  }

  #issueSummary(issue: E2eIssue): GitHubIssueSummary {
    return { owner: E2E_OWNER, repository: E2E_REPOSITORY_NAME, nodeId: `issue-node-${issue.number}`, number: issue.number, url: `https://github.com/${E2E_REPOSITORY}/issues/${issue.number}`, title: issue.goal, body: issueBody(issue), state: "open", labels: [], assignees: [], createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z" };
  }

  #open(): RuntimeSqliteStore {
    const store = RuntimeSqliteStore.open({ filename: this.databasePath, mode: "existing" });
    this.#stores.push(store);
    return store;
  }

  /** Work intake and Queue reconciliation as the daemon wires them, reading the stand-in GitHub. */
  #queue(store: RuntimeSqliteStore): WorkIntakeQueueReconciler {
    const intake = new WorkIntakeCoordinator(store, new Map([[E2E_REPOSITORY, {
      reader: { getIssue: async (issueNumber: number) => success(this.#issueSummary(this.issues.get(issueNumber)!), `e2e-issue-${issueNumber}`) },
      project: { synchronize: async (issue, metadata) => {
        this.#project.set(issue.number, { status: metadata.status ?? "Todo", priority: metadata.priority ?? "P1", worker: metadata.worker ?? "Pirx", risk: metadata.risk ?? "Low", workType: metadata.workType ?? "Task", queueOrder: metadata.queueOrder ?? issue.number });
        return { outcome: "synchronized" as const, correlationId: "e2e-project", message: "synchronized", value: { id: `project-item-${issue.number}`, issueNodeId: `issue-node-${issue.number}`, values: {} } };
      } },
    }]]));
    const reader = { read: async () => {
      const items: GitHubQueueIssue[] = [...this.#project].map(([issueNumber, fields]) => {
        const summary = this.#issueSummary(this.issues.get(issueNumber)!);
        return { itemId: `project-item-${issueNumber}`, nodeId: summary.nodeId, owner: E2E_OWNER, repository: E2E_REPOSITORY_NAME, issueNumber, url: summary.url, title: summary.title, body: summary.body ?? "", state: "OPEN" as const, createdAt: summary.createdAt, updatedAt: summary.updatedAt, ...fields, blockers: [] };
      });
      return { outcome: "success" as const, correlationId: "e2e-queue", snapshot: { schemaVersion: 1 as const, projectId: "project-3", synchronizedAt: new Date().toISOString(), items } };
    } };
    return new WorkIntakeQueueReconciler(intake, new GitHubQueueReconciler(reader as never, new GitHubQueueSynchronizer(store, { workerCapabilities: CAPABILITIES, repositories: [E2E_REPOSITORY] })));
  }

  /** The daemon exactly as `headless-cli.js` builds it. Its profile allows no cycle shorter than 30 s. */
  async startDaemonCli(): Promise<Daemon> {
    const packages = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { runHeadlessCli } = await import(pathToFileURL(resolve(packages, "orchestrator", "dist", "headless-cli.js")).href) as { runHeadlessCli: (host: unknown, options: unknown) => Promise<number> };
    const events: Record<string, unknown>[] = [];
    const record = { write: (value: string) => { events.push(JSON.parse(value) as Record<string, unknown>); } };
    const host = Object.assign(new EventEmitter(), { env: { PIRX_ORCHESTRATOR_CONFIG: this.configPath, HOME: this.root, PATH: process.env.PATH }, argv: ["node", "headless-cli.js"], stdout: record, stderr: record, exitCode: undefined as number | undefined });
    const finished = runHeadlessCli(host, {
      queue: this.#queue(this.#open()),
      delivery: { reconcile: async () => ({ outcome: "idle", allowWorkerCycle: true }) },
      githubConfigLoader: (environment: NodeJS.ProcessEnv) => loadGitHubConfig(environment, { tokenProvider: () => "test-only" }),
    });
    const daemon: Daemon = { events, stop: async () => { host.emit("SIGTERM", "SIGTERM"); return finished; } };
    this.#daemons.push(daemon);
    return daemon;
  }

  /** The same service, runtime and Claude worker with a 100 ms cycle, for scenarios that need several cycles. */
  startDaemon(): Daemon {
    const store = this.#open();
    const repositories = [{ repository: E2E_REPOSITORY, repositoryRoot: this.repositoryRoot, baseBranch: "develop", baseRevision: this.base }];
    const worker = new ProductionClaudeWorker({ store, repositories: [{ repository: E2E_REPOSITORY, repositoryRoot: this.repositoryRoot, remoteName: "origin", testCommands: ["node --version"] }], transcriptDirectory: join(this.root, "worker-logs") });
    const runtime = new ProductionRuntime(store, {
      workerId: "pirx-worker", provider: "claude-code", workerCapabilities: CAPABILITIES, repositories,
      worktreeParent: join(this.root, "worktrees"), leaseDurationMs: 60_000, shutdownTimeoutMs: 5_000, workerTimeoutMs: 60_000,
      workerOutputBytes: 16_384, workerErrorBytes: 16_384, maximumConsecutiveResumeFailures: 3,
      workerAdapters: { get: (provider) => provider === "claude-code" ? worker : undefined },
    });
    const events: Record<string, unknown>[] = [];
    const service = new HeadlessOrchestratorService(runtime, {
      cycleIntervalMs: 100, errorIntervalMs: 100,
      queue: this.#queue(this.#open()),
      delivery: { reconcile: async () => ({ outcome: "idle", allowWorkerCycle: true }) },
      control: new SqliteHeadlessControlPort(store),
      emit: (event) => { events.push(event as unknown as Record<string, unknown>); },
    });
    const finished = service.run();
    let stopped: Promise<number> | undefined;
    const daemon: Daemon = { events, stop: () => stopped ??= (async () => { void service.stop("SIGTERM"); return (await finished).exitCode; })() };
    this.#daemons.push(daemon);
    return daemon;
  }

  async chat(): Promise<ChatSession> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", PIRX_ORCHESTRATOR_CONFIG: this.configPath, XDG_CONFIG_HOME: this.root, HOME: this.root }, authorizationSecret: SECRET });
    const client = new Client({ name: "pirx-e2e", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      call: async (name, args, options = {}) => {
        const meta = options.authorize === true ? { _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(SECRET, name, args, options.operationId ?? String(args.operationId)) } } : {};
        const result = await client.callTool({ name, arguments: args, ...meta });
        return { isError: result.isError === true, value: (result.structuredContent ?? {}) as Record<string, unknown> };
      },
      close: async () => { await client.close(); await server.close(); },
    };
  }

  /** Submits an Issue through the chat tool; returns the intake receipt id. */
  async submitFromChat(issueNumber: number, queueOrder: number): Promise<string> {
    const issue = this.issues.get(issueNumber)!;
    const chat = await this.chat();
    try {
      const submission = { operationId: `e2e-submit-${issueNumber}`, repository: E2E_REPOSITORY, issueNumber, goal: issue.goal, acceptanceCriteria: [...issue.criteria], priority: "P1", risk: "Low", area: "Orchestrator", workType: "Task", queueOrder };
      const accepted = await chat.call("pirx_work_submit", submission, { authorize: true });
      if (accepted.isError) throw new Error(`pirx_work_submit was refused: ${JSON.stringify(accepted.value)}`);
      return (accepted.value.intake as { id: string }).id;
    } finally { await chat.close(); }
  }

  /** The runtime Task for an Issue and its Attempts, read straight from runtime.sqlite. */
  state(issueNumber: number): { readonly task?: TaskSnapshot; readonly attempts: readonly AttemptSnapshot[] } {
    const store = this.#observer ??= this.#open();
    const task = store.tasks.getByIssue({ owner: E2E_OWNER, repository: E2E_REPOSITORY_NAME, issueNumber });
    if (task.outcome !== "success") return { attempts: [] };
    const attempts = store.attempts.listByTask(task.value.id);
    return { task: task.value, attempts: attempts.outcome === "success" ? attempts.value : [] };
  }

  /** Until when the daemon holds back the Claude worker, if a cooldown is in force now. */
  workerCooldownUntil(): string | undefined {
    const store = this.#observer ??= this.#open();
    const evaluation = store.workerAvailability.evaluate("pirx-worker", "claude-code", new Date().toISOString() as never);
    return evaluation.outcome === "success" && evaluation.value.availability === "unavailable" ? evaluation.value.cooldownUntil : undefined;
  }

  results(issueNumber: number): string[] {
    return this.state(issueNumber).attempts.map((attempt) => attempt.state === "terminal" ? String(attempt.result) : "running");
  }

  /** Waits until `ready` holds; on timeout the error carries what the daemon and the Attempts recorded. */
  async waitFor(what: string, ready: () => boolean | Promise<boolean>, daemon: Daemon, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ready()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out waiting for: ${what}\n${this.describe(daemon)}`);
  }

  describe(daemon: Daemon): string {
    const attempts = [...this.issues.keys()].flatMap((issueNumber) => this.state(issueNumber).attempts);
    return JSON.stringify({ attempts, daemonEvents: daemon.events.filter((event) => event.event !== "observability").slice(-15) }, null, 1);
  }

  async cleanup(): Promise<void> {
    for (const daemon of this.#daemons) { try { await daemon.stop(); } catch { /* the test failure matters more */ } }
    if (this.#savedPath === undefined) delete process.env.PATH; else process.env.PATH = this.#savedPath;
    for (const store of this.#stores) { try { store.close(); } catch { /* already closed by its daemon */ } }
    await rm(this.root, { recursive: true, force: true });
  }
}
