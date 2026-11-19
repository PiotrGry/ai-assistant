import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const environment = { HOME: root, PIRX_ORCHESTRATOR_CONFIG: join(root, "orchestrator.json"), PIRX_STOP_FILE: join(root, "STOP"), PIRX_WORKER_LOG_DIR: join(root, "logs"), PIRX_WORKTREE_PARENT: join(root, "wt"), ...extraEnv };
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
    const result = await call(h, "issue_create", { repository: "someone/else", title: "t", body: "b" });
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
    for (let index = 0; index < 2; index += 1) h.store.append({ task: `${REPO}#3`, kind: "tool", name: "worker_start", input: {}, ok: true });
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
    if (file === "gh" && args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number: 9, state: "MERGED", mergeCommit: { oid: "abc1234" }, headRefName: "feature/x" }));
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
});
