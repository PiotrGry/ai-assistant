import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerCoordinationTools } from "../src/coordination/register.js";
import type { CommandResult, Runner } from "../src/coordination/shell.js";
import { CoordinationStore } from "../src/coordination/store.js";
import { workerToolArguments } from "../src/coordination/worker.js";

const REPO = "PiotrGry/zdrovena-reconciliation";

interface Harness { readonly client: Client; readonly store: CoordinationStore; readonly calls: string[]; readonly root: string; close(): Promise<void> }

function ok(stdout = ""): CommandResult { return { ok: true, code: 0, stdout, stderr: "", command: "" }; }
function fail(stderr: string): CommandResult { return { ok: false, code: 1, stdout: "", stderr, command: "" }; }

async function harness(responses: (file: string, args: readonly string[]) => CommandResult | undefined = () => undefined, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pirx-coordination-"));
  const repositoryRoot = join(root, "repo");
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(join(root, "orchestrator.json"), JSON.stringify({ githubProjectOwner: "PiotrGry", githubProjectNumber: 3, repositories: [{ repository: REPO, repositoryRoot, baseBranch: "develop", remoteName: "origin", testCommands: ["uv run pytest"], delivery: { postMerge: { mustReach: ["main"] } } }] }));
  const calls: string[] = [];
  const run: Runner = async (file, args) => { calls.push([file, ...args].join(" ")); return responses(file, args) ?? ok(""); };
  const store = new CoordinationStore(join(root, "pirx.sqlite"));
  const environment = { HOME: root, PIRX_WORKER_SYSTEMD: "0", PIRX_CLAUDE_EXECUTABLE: "/bin/false", PIRX_ORCHESTRATOR_CONFIG: join(root, "orchestrator.json"), PIRX_STOP_FILE: join(root, "STOP"), PIRX_WORKER_LOG_DIR: join(root, "logs"), PIRX_WORKTREE_PARENT: join(root, "wt"), ...extraEnv };
  const server = new McpServer({ name: "test", version: "1" });
  registerCoordinationTools(server, environment, { run, store });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, store, calls, root, close: async () => { await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await h.client.callTool({ name, arguments: args });
  return result.structuredContent as Record<string, unknown>;
}

test("journal: every tool call is recorded, survives a restart, and pirx_explain shows it", async () => {
  const h = await harness();
  try {
    await call(h, "journal_note", { repository: REPO, issue: 7, text: "waits for the operator" });
    await call(h, "ask_operator", { repository: REPO, issue: 7, question: "Ship it?" });
    const reopened = new CoordinationStore(h.store.path);
    const entries = reopened.journal({ task: `${REPO}#7` });
    assert.deepEqual(entries.map((entry) => `${entry.kind}:${entry.name}`), ["note:note", "tool:journal_note", "question:ask_operator", "tool:ask_operator"]);
    reopened.close();
    const explained = await call(h, "pirx_explain", { repository: REPO, issue: 7 });
    assert.equal((explained.timeline as unknown[]).length, 4);
    const empty = await call(h, "pirx_explain", { repository: REPO, issue: 8 });
    assert.match(String(empty.note), /not worked on this Task/u);
  } finally { await h.close(); }
});

test("stop switch: every mutating tool refuses while the STOP file exists; read tools still work", async () => {
  const h = await harness();
  try {
    await writeFile(join(h.root, "STOP"), "");
    const refused = await call(h, "issue_comment", { repository: REPO, issue: 1, body: "x" });
    assert.equal(refused.refused, true);
    assert.match(String(refused.reason), /stop switch/u);
    assert.equal(h.calls.some((line) => line.startsWith("gh issue comment")), false);
    const read = await call(h, "journal_read", {});
    assert.equal(read.refused, undefined);
  } finally { await h.close(); }
});

test("dry-run: mutating tools report what they would do and run nothing", async () => {
  const h = await harness(undefined, { PIRX_COORDINATION_DRY_RUN: "1" });
  try {
    const result = await call(h, "ci_rerun", { repository: REPO, runId: 42 });
    assert.equal(result.dryRun, true);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("allowlist: a repository outside the configuration is refused", async () => {
  const h = await harness();
  try {
    const result = await call(h, "issue_create", { repository: "someone/else", title: "t", body: "b", kind: "improvement" });
    assert.equal(result.refused, true);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("worker: a second start is refused while a worker holds the lock", async () => {
  const h = await harness();
  try {
    assert.equal(h.store.acquire({ task: `${REPO}#1`, pid: process.pid, startedAt: h.store.now(), logPath: "/dev/null", reportPath: "/dev/null" }), true);
    const result = await call(h, "worker_start", { repository: REPO, issue: 2, instruction: "do it" });
    assert.equal(result.refused, true);
    assert.match(String(result.reason), /one worker/iu);
    const resumed = await call(h, "worker_resume", { repository: REPO, issue: 2, instruction: "do it" });
    assert.equal(resumed.refused, true);
  } finally { await h.close(); }
});

test("worker: a dead worker's lock is cleared, and the per-day start cap refuses", async () => {
  const h = await harness((file, args) => file === "git" && args[0] === "worktree" && args[1] === "list" ? ok("") : undefined, { PIRX_CAP_WORKER_STARTS: "2" });
  try {
    h.store.acquire({ task: `${REPO}#1`, pid: 2_147_483_000, startedAt: h.store.now(), logPath: "/dev/null", reportPath: "/dev/null" });
    const report = join(h.root, "done.report.json");
    await writeFile(report, "{}");
    for (let index = 0; index < 2; index += 1) h.store.append({ task: `${REPO}#3`, kind: "tool", name: "worker_start", input: {}, output: { started: true, reportPath: report }, ok: true });
    const result = await call(h, "worker_start", { repository: REPO, issue: 3, instruction: "again" });
    assert.equal(result.refused, true);
    assert.match(String(result.reason), /cap is 2/u);
    assert.equal(h.store.lock(), undefined);
  } finally { await h.close(); }
});

test("worker sandbox: the worker may commit but never push, reset or rewrite history", () => {
  const args = workerToolArguments("/wt", ["uv run pytest"]);
  const denied = args[args.indexOf("--disallowedTools") + 1]!;
  const allowed = args[args.indexOf("--allowedTools") + 1]!;
  for (const rule of ["Bash(git push *)", "Bash(git -C * push *)", "Bash(git reset *)", "Bash(git rebase *)", "Bash(git checkout *)", "mcp__*"]) assert.ok(denied.includes(rule), rule);
  for (const rule of ["Bash(git commit -m:*)", "Bash(uv run pytest)"]) assert.ok(allowed.includes(rule), rule);
  assert.ok(args.includes("--restricted"));
  assert.match(args[args.indexOf("--settings") + 1]!, /"failIfUnavailable":true/u);
});

test("ci_rerun: a run is rerun at most the capped number of times", async () => {
  const h = await harness(undefined, { PIRX_CAP_CI_RERUNS: "1" });
  try {
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 77 })).rerun, true);
    const second = await call(h, "ci_rerun", { repository: REPO, runId: 77 });
    assert.equal(second.refused, true);
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 78 })).rerun, true);
    assert.equal(h.calls.filter((line) => line.startsWith("gh run rerun 77")).length, 1);
  } finally { await h.close(); }
});

test("task_ship: only pirx/* branches, never forced; task_close only after the change reached the target branch", async () => {
  const h = await harness((file, args) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number: 9, state: "MERGED", mergeCommit: { oid: "abc1234" }, headRefName: "feature/x", body: "Fixes #5." }));
    if (file === "git" && args[0] === "merge-base") return fail("");
    if (file === "git" && args[0] === "worktree" && args[1] === "list") return ok("");
    return undefined;
  });
  try {
    const closed = await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 });
    assert.equal(closed.refused, true);
    assert.match(String(closed.reason), /not on main yet/u);
    assert.equal(h.calls.some((line) => line.startsWith("gh issue close")), false);
    const updated = await call(h, "pr_update_branch", { repository: REPO, pr: 9 });
    assert.equal(updated.refused, true);
    const shipped = await call(h, "task_ship", { repository: REPO, issue: 5, title: "t", body: "b" });
    assert.equal(shipped.refused, true);
    assert.equal(h.calls.some((line) => / push /u.test(` ${line} `) && line.includes("--force")), false);
  } finally { await h.close(); }
});

test("eval mode: facts come from the case file and mutating calls are only recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-eval-case-"));
  const fixture = join(root, "case.json");
  await writeFile(fixture, JSON.stringify({ tools: { worker_status: { running: false, exited: true } } }));
  const h = await harness(undefined, { PIRX_COORDINATION_EVAL: fixture });
  try {
    assert.equal((await call(h, "worker_status", {})).exited, true);
    assert.equal((await call(h, "task_park", { repository: REPO, issue: 3, reason: "x" })).done, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.journal({ kind: "tool" }).length, 2);
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});

test("eval judge: a forbidden call fails the run, and anyOf needs one matching call", async () => {
  const { judge } = await import("../src/coordination/eval-cli.js");
  const entry = (name: string, input: Record<string, unknown>) => ({ seq: 1, at: "", kind: "tool" as const, name, input, ok: true });
  const testCase = { description: "", trigger: "", pass: { anyOf: [{ tool: "ci_rerun", runId: 7 }], forbid: [{ tool: "worker_start" }] } };
  assert.equal(judge(testCase, [entry("ci_rerun", { runId: 7 })]).passed, true);
  assert.equal(judge(testCase, [entry("ci_rerun", { runId: 8 })]).passed, false);
  assert.equal(judge(testCase, [entry("ci_rerun", { runId: 7 }), entry("worker_start", {})]).passed, false);
  assert.equal(judge(testCase, [entry("ci_rerun", { runId: 7 }), { ...entry("worker_start", {}), ok: false }]).passed, true);
});

test("watcher: a pirx/* branch names its Issue, for both Pirx's and the old daemon's branches", async () => {
  const { issueOfBranch } = await import("../src/coordination/watch-cli.js");
  assert.equal(issueOfBranch("pirx/issue-543"), 543);
  assert.equal(issueOfBranch("pirx/task-gh-539-f505aaa16218d71e"), 539);
  assert.equal(issueOfBranch("pirx/archive/issue-5-x"), undefined);
});

test("worker: only Issues queued for Pirx on the Project may start; Worker=Human is the operator's", async () => {
  const items = { items: [{ content: { repository: REPO, number: 540, type: "Issue" }, worker: "Human", status: "Todo" }, { content: { repository: REPO, number: 541, type: "Issue" }, worker: "Pirx", status: "Done" }] };
  const h = await harness((file, args) => file === "gh" && args[0] === "project" && args[1] === "item-list" ? ok(JSON.stringify(items)) : file === "git" && args[1] === "list" ? ok("") : undefined);
  try {
    const human = await call(h, "worker_start", { repository: REPO, issue: 540, instruction: "x" });
    assert.equal(human.refused, true);
    assert.match(String(human.reason), /Worker=Human/u);
    assert.equal((await call(h, "worker_start", { repository: REPO, issue: 541, instruction: "x" })).refused, true);
    assert.match(String((await call(h, "worker_start", { repository: REPO, issue: 999, instruction: "x" })).reason), /not on the Project/u);
    assert.equal(h.calls.some((line) => line.startsWith("git worktree add")), false);
  } finally { await h.close(); }
});

test("queue_set: Pirx may not take back an item the operator set to Worker=Human", async () => {
  const url = `https://github.com/${REPO}/issues/540`;
  const h = await harness((file, args) => file === "gh" && args[1] === "item-list" ? ok(JSON.stringify({ items: [{ content: { url }, worker: "Human" }] })) : undefined);
  try {
    const result = await call(h, "queue_set", { repository: REPO, issue: 540, worker: "Pirx" });
    assert.equal(result.refused, true);
    assert.equal(h.calls.some((line) => line.includes("item-edit")), false);
  } finally { await h.close(); }
});

test("issue_create: one open Pirx proposal at a time, and every Issue Pirx creates is labelled pirx-round", async () => {
  let open = [{ number: 540, title: "x" }];
  const h = await harness((file, args) => file === "gh" && args[1] === "list" ? ok(JSON.stringify(open)) : file === "gh" && args[1] === "create" ? ok("https://github.com/x/y/issues/600") : undefined);
  try {
    assert.equal((await call(h, "issue_create", { repository: REPO, title: "t", body: "b", kind: "improvement" })).refused, true);
    open = [];
    assert.equal((await call(h, "issue_create", { repository: REPO, title: "t", body: "b", kind: "improvement" })).issue, 600);
    assert.ok(h.calls.some((line) => line.startsWith("gh issue create") && line.includes("--label pirx-round")));
  } finally { await h.close(); }
});

test("tick guard: a guard left by a dead process is taken over; a live holder keeps it", async () => {
  const { takeGuard, guardHeldByOther, releaseGuard } = await import("../src/coordination/proc.js");
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "pirx-guard-"));
  const holder = spawn("sleep", ["30"]);
  try {
    const guard = join(root, "pirx-tick.lock");
    await writeFile(guard, "");
    assert.equal(takeGuard(guard), true);
    releaseGuard(guard);
    await writeFile(guard, "2147483000");
    assert.equal(takeGuard(guard), true);
    releaseGuard(guard);
    await writeFile(guard, String(holder.pid));
    assert.equal(guardHeldByOther(guard), true);
    assert.equal(takeGuard(guard), false);
  } finally { holder.kill(); await rm(root, { recursive: true, force: true }); }
});

test("issue_create kind=bug: own label, no duplicate title, and the improvement limit does not block it", async () => {
  let bugs: { number: number; title: string }[] = [];
  const h = await harness((file, args) => {
    if (file === "gh" && args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(args.includes("pirx-bug") ? bugs : [{ number: 540, title: "open improvement" }]));
    if (file === "gh" && args[0] === "issue" && args[1] === "create") return ok("https://github.com/x/y/issues/700");
    return undefined;
  });
  try {
    assert.equal((await call(h, "issue_create", { repository: REPO, title: "KeyError in labels", body: "b", kind: "bug" })).issue, 700);
    assert.ok(h.calls.some((line) => line.startsWith("gh issue create") && line.includes("--label pirx-bug") && !line.includes("pirx-round")));
    bugs = [{ number: 700, title: "keyerror in labels" }];
    assert.match(String((await call(h, "issue_create", { repository: REPO, title: "KeyError in labels", body: "b", kind: "bug" })).reason), /already filed as #700/u);
    assert.equal((await call(h, "issue_create", { repository: REPO, title: "tests", body: "b", kind: "improvement" })).refused, true);
  } finally { await h.close(); }
});

test("queue_set in a tick: Pirx queues its own production bugs, not improvements; in the chat anything", async () => {
  const respond = (label: string) => (file: string, args: readonly string[]) => file === "gh" && args[1] === "item-list" ? ok(JSON.stringify({ items: [] })) : file === "gh" && args[0] === "issue" && args[1] === "view" ? ok(JSON.stringify({ labels: [{ name: label }] })) : file === "gh" && args[1] === "item-add" ? ok(JSON.stringify({ id: "item" })) : file === "gh" && args[1] === "view" ? ok(JSON.stringify({ id: "project" })) : file === "gh" && args[1] === "field-list" ? ok(JSON.stringify({ fields: [{ id: "f", name: "Worker", options: [{ id: "o", name: "Pirx" }] }] })) : undefined;
  const improvement = await harness(respond("pirx-round"), { PIRX_TICK_ID: "tick-1" });
  try { assert.equal((await call(improvement, "queue_set", { repository: REPO, issue: 9, worker: "Pirx" })).refused, true); } finally { await improvement.close(); }
  const bug = await harness(respond("pirx-bug"), { PIRX_TICK_ID: "tick-1" });
  try { assert.deepEqual((await call(bug, "queue_set", { repository: REPO, issue: 9, worker: "Pirx" })).set, { Worker: "Pirx" }); } finally { await bug.close(); }
  const chat = await harness(respond("pirx-round"));
  try { assert.deepEqual((await call(chat, "queue_set", { repository: REPO, issue: 9, worker: "Pirx" })).set, { Worker: "Pirx" }); } finally { await chat.close(); }
});

test("a read tool runs at most six times in one tick, then tells the model to decide", async () => {
  const h = await harness((file, args) => file === "gh" && args[0] === "pr" ? ok("[]") : undefined, { PIRX_TICK_ID: "tick-loop" });
  try {
    for (let index = 0; index < 6; index += 1) assert.equal((await call(h, "pr_list", { repository: REPO, search: `q${index}` })).refused, undefined);
    const seventh = await call(h, "pr_list", { repository: REPO, search: "again" });
    assert.equal(seventh.refused, true);
    assert.match(String(seventh.reason), /decide with what you have/u);
  } finally { await h.close(); }
});


test("process identity: pid 0 and a reused pid are not alive; the recorded process is", async () => {
  const { pidAlive, processStart } = await import("../src/coordination/proc.js");
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(2_147_483_000), false);
  const start = processStart(process.pid);
  assert.ok(start !== undefined && start.length > 0);
  assert.equal(pidAlive(process.pid, start), true);
  assert.equal(pidAlive(process.pid, "1"), false, "same pid, different start time: a reused pid");
});

test("worker lock: a lock left with pid 0 or a reused pid does not block a start", async () => {
  const h = await harness((file, args) => file === "gh" && args[1] === "item-list" ? ok(JSON.stringify({ items: [] })) : file === "git" && args[1] === "list" ? ok("") : undefined);
  try {
    h.store.acquire({ task: `${REPO}#1`, pid: 0, startedAt: h.store.now(), logPath: "/dev/null", reportPath: "/dev/null" });
    const result = await call(h, "worker_start", { repository: REPO, issue: 2, instruction: "x" });
    assert.doesNotMatch(String(result.reason), /one worker/iu);
    assert.equal(h.store.lock(), undefined);
    h.store.acquire({ task: `${REPO}#1`, pid: process.pid, pidStart: "1", startedAt: h.store.now(), logPath: "/dev/null", reportPath: "/dev/null" });
    assert.doesNotMatch(String((await call(h, "worker_start", { repository: REPO, issue: 2, instruction: "x" })).reason), /one worker/iu);
  } finally { await h.close(); }
});

test("worker cap: runs that vanished without a report do not count, but a ceiling of twice the cap holds", async () => {
  const h = await harness((file, args) => file === "git" && args[1] === "list" ? ok("") : file === "gh" && args[1] === "item-list" ? ok(JSON.stringify({ items: [] })) : undefined, { PIRX_CAP_WORKER_STARTS: "2" });
  try {
    for (let index = 0; index < 3; index += 1) h.store.append({ task: `${REPO}#4`, kind: "tool", name: "worker_start", input: {}, output: { started: true, reportPath: join(h.root, `lost-${index}.report.json`) }, ok: true });
    const allowed = await call(h, "worker_start", { repository: REPO, issue: 4, instruction: "x" });
    assert.doesNotMatch(String(allowed.reason ?? ""), /cap|ceiling/u, "three lost starts are below the ceiling of four and do not count");
    h.store.append({ task: `${REPO}#4`, kind: "tool", name: "worker_start", input: {}, output: { started: true, reportPath: join(h.root, "lost-3.report.json") }, ok: true });
    assert.match(String((await call(h, "worker_start", { repository: REPO, issue: 4, instruction: "x" })).reason), /ceiling is 4/u);
  } finally { await h.close(); }
});

test("worker runner: writes its pid, a report when it finishes, and a report when it is stopped", async () => {
  const { spawn } = await import("node:child_process");
  const { readFile, chmod } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "pirx-runner-"));
  const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "coordination", "worker-run.js");
  const fake = join(root, "fake-claude.sh");
  await writeFile(fake, `#!/bin/sh\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'\nsleep "$1"\necho '{"type":"result","result":"done: committed abc","is_error":false,"num_turns":2}'\n`);
  await chmod(fake, 0o755);
  const job = (name: string, seconds: string) => ({ task: `${REPO}#9`, cwd: root, setupCommands: [], executable: fake, args: [seconds], prompt: "x", env: { PATH: process.env.PATH ?? "" }, logPath: join(root, `${name}.jsonl`), reportPath: join(root, `${name}.report.json`), timeoutMs: 60_000, storagePath: join(root, "x.sqlite"), sessionId: "s" });
  const run = async (name: string, seconds: string, stopAfterMs?: number): Promise<Record<string, unknown>> => {
    const jobPath = join(root, `${name}.job.json`);
    await writeFile(jobPath, JSON.stringify(job(name, seconds)));
    const child = spawn(process.execPath, [runner, jobPath], { stdio: "ignore" });
    if (stopAfterMs !== undefined) { await new Promise((resolve) => setTimeout(resolve, stopAfterMs)); child.kill("SIGTERM"); }
    await new Promise((resolve) => child.on("close", resolve));
    assert.ok(existsSync(`${jobPath}.pid`), "pid file");
    return JSON.parse(await readFile(join(root, `${name}.report.json`), "utf8")) as Record<string, unknown>;
  };
  try {
    const finished = await run("ok", "0");
    assert.equal(finished.outcome, "finished");
    assert.equal(finished.workerReport, "done: committed abc");
    const stopped = await run("stopped", "30", 1500);
    assert.equal(stopped.outcome, "killed");
    assert.equal(stopped.workerReport, "working");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("watcher: one CI run is one state change, not one per check", async () => {
  const { prState } = await import("../src/coordination/watch-cli.js");
  assert.equal(prState({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ status: "IN_PROGRESS" }, { conclusion: "SUCCESS" }] }), "pending/blocked");
  assert.equal(prState({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ status: "QUEUED" }, { status: "IN_PROGRESS" }] }), "pending/blocked");
  assert.equal(prState({ mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }] }), "green/clean");
  assert.equal(prState({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ conclusion: "FAILURE" }, { status: "IN_PROGRESS" }] }), "red/blocked");
});

test("watcher: a failed tick leaves its events for the next run; the idle queue wakes a tick; the timer ignores failed ticks", async () => {
  const { collectEvents, settleEvents, MAX_FAILED_TICKS_PER_EVENT } = await import("../src/coordination/watch-cli.js");
  const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
  let queue = [{ content: { repository: REPO, number: 1, type: "Issue" }, worker: "Pirx", status: "Todo", "queue Order": 1 }];
  const h = await harness();
  const run: Runner = async (file, args) => ({ ok: true, code: 0, stdout: file === "gh" && args[0] === "pr" ? "[]" : JSON.stringify({ items: queue }), stderr: "", command: "" });
  const settings = loadCoordinationSettings({ HOME: h.root, PIRX_ORCHESTRATOR_CONFIG: join(h.root, "orchestrator.json") });
  try {
    (await collectEvents(h.store, settings, run, 60)).commit();
    queue = [...queue, { content: { repository: REPO, number: 2, type: "Issue" }, worker: "Pirx", status: "Todo", "queue Order": 2 }];
    const first = await collectEvents(h.store, settings, run, 60);
    assert.ok(first.events.some((event) => event.includes("kolejka")));
    settleEvents(h.store, first, false);
    const again = await collectEvents(h.store, settings, run, 60);
    assert.ok(again.events.some((event) => event.includes("kolejka")), "the queue change is still reported after a failed tick");
    assert.equal(again.events.filter((event) => event.includes("worker nie pracuje")).length, 0, "the idle nudge is rate-limited");
    for (let index = 1; index < MAX_FAILED_TICKS_PER_EVENT; index += 1) settleEvents(h.store, await collectEvents(h.store, settings, run, 60), false);
    assert.equal((await collectEvents(h.store, settings, run, 60)).events.some((event) => event.includes("kolejka")), false, "after three failures the cursor moves on");
    h.store.append({ kind: "tick", name: "tick", ok: false });
    assert.ok((await collectEvents(h.store, settings, run, 60)).events.some((event) => event.includes("Obchód okresowy")), "a failed tick does not reset the timer");
    h.store.append({ kind: "tick", name: "tick", ok: true });
    assert.equal((await collectEvents(h.store, settings, run, 60)).events.some((event) => event.includes("Obchód okresowy")), false);
  } finally { await h.close(); }
});

test("tick guard: while a tick runs, a second tick does nothing and the chat cannot run mutating tools", async () => {
  const { spawn } = await import("node:child_process");
  const { runTick } = await import("../src/coordination/tick-cli.js");
  const h = await harness();
  const holder = spawn("sleep", ["30"]);
  try {
    await writeFile(join(h.root, "pirx-tick.lock"), String(holder.pid));
    const skipped = await runTick({ trigger: "x", storage: h.store.path, environment: { ...process.env } });
    assert.equal(skipped.skipped, true);
    const refused = await call(h, "issue_comment", { repository: REPO, issue: 1, body: "x" });
    assert.match(String(refused.reason), /A tick is running/u);
    assert.equal((await call(h, "journal_read", {})).refused, undefined, "read tools still work");
  } finally { holder.kill(); await h.close(); }
});

test("tick result: a limit notice or a failure notice is not a decision", async () => {
  const { tickSucceeded } = await import("../src/coordination/tick-cli.js");
  assert.equal(tickSucceeded(0, "Decyzja: nic"), true);
  assert.equal(tickSucceeded(0, "Osiągnięto limit 30 rund wywołań narzędzi."), false);
  assert.equal(tickSucceeded(0, "Nie udało się zakończyć odpowiedzi po wykonaniu części operacji."), false);
  assert.equal(tickSucceeded(1, "Decyzja: nic"), false);
  assert.equal(tickSucceeded(0, "  "), false);
});

test("result budget: long text and lists are shortened, the JSON stays whole, and small results are untouched", async () => {
  const { fitBudget, RESULT_BUDGET } = await import("../src/coordination/toolkit.js");
  const small = { a: 1, b: "x" };
  assert.equal(fitBudget(small), small);
  const big = { issue: { body: "x".repeat(20_000) }, entries: Array.from({ length: 200 }, (_, index) => ({ seq: index, output: "y".repeat(500) })) };
  const fitted = fitBudget(big);
  const text = JSON.stringify(fitted);
  assert.ok(text.length <= RESULT_BUDGET, `${text.length}`);
  assert.equal(fitted.shortened, true);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.match(text, /characters, shortened/u);
});

test("task_close: a merged PR that does not belong to the Issue is refused", async () => {
  const pr = (fields: Record<string, unknown>) => ok(JSON.stringify({ number: 9, state: "MERGED", mergeCommit: { oid: "abc1234" }, title: "unrelated", body: "", headRefName: "fix/other", closingIssuesReferences: [], ...fields }));
  let current = pr({});
  const h = await harness((file, args) => file === "gh" && args[1] === "view" ? current : file === "git" && args[0] === "worktree" ? ok("") : file === "git" && args[0] === "merge-base" ? ok("") : undefined);
  try {
    const refused = await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 });
    assert.match(String(refused.reason), /does not close or mention #5/u);
    current = pr({ body: "Fixes #5." });
    assert.equal((await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 })).closed, true);
    current = pr({ body: "See #55 and #500." });
    assert.equal((await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 })).refused, true, "#55 is not #5");
    current = pr({ headRefName: "pirx/issue-5" });
    assert.equal((await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 })).closed, true);
  } finally { await h.close(); }
});

test("ci_rerun cap: run 445 does not count against run 44", async () => {
  const h = await harness(undefined, { PIRX_CAP_CI_RERUNS: "1" });
  try {
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 445 })).rerun, true);
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 44 })).rerun, true);
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 44 })).refused, true);
  } finally { await h.close(); }
});

test("workspace: only pirx/issue-<N> and pirx/task-gh-<N>-... belong to Issue N", async () => {
  const { locateWorkspace, issueOfBranch } = await import("../src/coordination/facts.js");
  assert.equal(issueOfBranch("pirx/issue-1-54"), 1);
  assert.equal(issueOfBranch("pirx/archive/issue-54-x"), undefined);
  assert.equal(issueOfBranch("pirx/feature-54"), undefined);
  const h = await harness();
  try {
    const listing = `worktree ${h.root}\nHEAD aaa\nbranch refs/heads/pirx/issue-1-54\n\nworktree ${h.root}\nHEAD bbb\nbranch refs/heads/pirx/task-gh-54-abc\n`;
    const run: Runner = async () => ok(listing);
    const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
    const repo = loadCoordinationSettings({ HOME: h.root, PIRX_ORCHESTRATOR_CONFIG: join(h.root, "orchestrator.json") }).repositories[0]!;
    assert.equal((await locateWorkspace(run, h.store, repo, 54))?.branch, "pirx/task-gh-54-abc");
  } finally { await h.close(); }
});

test("daily caps start at the operator's midnight, not UTC midnight", async () => {
  const { startOfDay } = await import("../src/coordination/settings.js");
  assert.equal(startOfDay("2026-11-20T00:30:00.000Z", "Europe/Warsaw"), "2026-11-19T23:00:00.000Z");
  assert.equal(startOfDay("2026-11-19T22:30:00.000Z", "Europe/Warsaw"), "2026-11-18T23:00:00.000Z");
  assert.equal(startOfDay("2026-07-01T10:00:00.000Z", "Europe/Warsaw"), "2026-06-30T22:00:00.000Z");
  assert.equal(startOfDay("2026-11-20T10:00:00.000Z", "UTC"), "2026-11-20T00:00:00.000Z");
});

test("bug Issues: the same error reworded or with other numbers is one bug", async () => {
  const { bugFingerprint } = await import("../src/coordination/actions.js");
  assert.equal(bugFingerprint("exception|POST /api/shipping/labels/batch|KeyError: 'courier_shipments' at line 120"), bugFingerprint("exception|POST /api/shipping/labels/batch|KeyError: \"courier_shipments\" at line 98"));
  assert.notEqual(bugFingerprint("exception|POST /a|KeyError"), bugFingerprint("exception|POST /b|KeyError"));
  let bugs: { number: number; title: string; body?: string }[] = [];
  const h = await harness((file, args) => file === "gh" && args[1] === "list" ? ok(JSON.stringify(bugs)) : file === "gh" && args[1] === "create" ? ok("https://github.com/x/y/issues/801") : undefined);
  try {
    const key = "exception|POST /api/x|KeyError: 'a'";
    assert.equal((await call(h, "issue_create", { repository: REPO, title: "KeyError in batch labels", body: "b", kind: "bug", errorKey: key })).issue, 801);
    const created = h.calls.find((line) => line.startsWith("gh issue create"))!;
    const fingerprint = /pirx-bug-fingerprint: ([0-9a-f]{16})/u.exec(created)![1];
    bugs = [{ number: 801, title: "KeyError in batch labels", body: `b\n<!-- pirx-bug-fingerprint: ${fingerprint} -->` }];
    const again = await call(h, "issue_create", { repository: REPO, title: "Batch label endpoint crashes", body: "b", kind: "bug", errorKey: key });
    assert.match(String(again.reason), /already filed as #801/u);
  } finally { await h.close(); }
});
