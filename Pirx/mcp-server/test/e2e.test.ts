import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { E2eFixture, git, type ChatSession } from "./e2e-fixture.js";

// End-to-end scenarios across chat, runtime.sqlite, the daemon and a Claude worker.
// See e2e-fixture.ts for what is real and what is replaced.

const issue = { number: 462, goal: "Fix the tracked fixture file", criteria: ["tracked.txt says fixed", "the change is committed on the assigned branch"] };

async function withChat<T>(fixture: E2eFixture, use: (chat: ChatSession) => Promise<T>): Promise<T> {
  const chat = await fixture.chat();
  try { return await use(chat); } finally { await chat.close(); }
}

test("e2e: one Task travels from the chat tool through the daemon CLI and a Claude worker to a pushed commit", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    const intakeId = await fixture.submitFromChat(issue.number, 10);

    const daemon = await fixture.startDaemonCli();
    await fixture.waitFor("the first Attempt to finish", () => fixture.results(issue.number).some((result) => result !== "running"), daemon);
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));

    assert.deepEqual(fixture.results(issue.number), ["CODE_PUSHED"], fixture.describe(daemon));
    const { task, attempts } = fixture.state(issue.number);
    const pushed = await git(fixture.remote, "rev-parse", `refs/heads/${attempts[0]!.branch}`);
    assert.equal(await git(fixture.remote, "show", `${pushed}:tracked.txt`), "fixed");
    // The operator's own checkout and base branch are untouched; the work lives on the assigned branch.
    assert.equal(await git(fixture.repositoryRoot, "rev-parse", "develop"), fixture.base);
    assert.equal(await readFile(join(fixture.repositoryRoot, "tracked.txt"), "utf8"), "broken\n");

    await withChat(fixture, async (chat) => {
      // The receipt turns "linked" one daemon cycle after the Task exists (30 s at the minimum
      // interval), so right after the first cycle it is still "linking".
      const receipt = (await chat.call("pirx_work_status", { intakeId })).value.intake as { state: string; issueNodeId?: string };
      assert.ok(receipt.state === "linking" || receipt.state === "linked", JSON.stringify(receipt));
      assert.equal(receipt.issueNodeId, `issue-node-${issue.number}`);
      const status = await chat.call("pirx_orchestrator_status", {});
      assert.equal(status.isError, false, JSON.stringify(status.value));
      const snapshot = status.value.snapshot as { worker: { state: string }; observedState: string };
      assert.equal(snapshot.worker.state, "idle");
      assert.equal(snapshot.observedState, "stopped");
      assert.ok(task !== undefined);
    });
  } finally { await fixture.cleanup(); }
});

test("e2e: a Claude usage limit pauses the Task and the daemon resumes it by itself after the reset", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.queueOnProject(issue.number, 10);
    const resetInMs = 1_500;
    await fixture.planClaude([{ do: "quota", resetInMs }, { do: "commit" }]);

    const daemon = fixture.startDaemon();
    await fixture.waitFor("the limit to be recorded", () => fixture.results(issue.number)[0] === "QUOTA_EXHAUSTED", daemon);

    // During the cooldown the chat can see why nothing runs and when the limit resets.
    await withChat(fixture, async (chat) => {
      const status = await chat.call("pirx_orchestrator_status", {});
      assert.equal((status.value.snapshot as { worker: { state: string } }).worker.state, "idle");
      assert.match(JSON.stringify(status.value), /"code":"quota_exhausted"/u);
      assert.match(JSON.stringify(status.value), /"source":"provider_reset","resetAt":"/u);
    });

    await fixture.waitFor("the resumed Attempt to push", () => fixture.results(issue.number)[1] === "CODE_PUSHED", daemon);
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));

    assert.deepEqual(fixture.results(issue.number), ["QUOTA_EXHAUSTED", "CODE_PUSHED"], fixture.describe(daemon));
    const calls = await fixture.claudeCalls();
    assert.deepEqual(calls.map((call) => call.mode), ["new", "resume"]);
    // No operator action happened in between, and Claude was not started again before the reset.
    assert.ok(Date.parse(calls[1]!.at) - Date.parse(calls[0]!.at) >= resetInMs - 100, JSON.stringify(calls.map((call) => call.at)));
    const { attempts } = fixture.state(issue.number);
    // The resume continues on the same branch and worktree instead of starting over.
    assert.equal(attempts[1]!.branch, attempts[0]!.branch);
    assert.equal(await git(fixture.remote, "show", `refs/heads/${attempts[1]!.branch}:tracked.txt`), "fixed");
  } finally { await fixture.cleanup(); }
});

test("e2e: a worker question reaches the chat, and the operator's answer resumes the same Task", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.queueOnProject(issue.number, 10);
    const question = "Should the file say fixed or repaired?";
    const answer = "Write repaired-by-operator-choice.";
    await fixture.planClaude([{ do: "ask_operator", question }, { do: "commit", content: "repaired" }]);

    const daemon = fixture.startDaemon();
    await fixture.waitFor("the worker to block on its question", () => fixture.results(issue.number)[0] === "BLOCKED", daemon);

    await withChat(fixture, async (chat) => {
      const listed = (await chat.call("pirx_operator_questions", {})).value.questions as Array<{ id: string; prompt: string; version: number; state: string }>;
      assert.equal(listed.length, 1, JSON.stringify(listed));
      assert.equal(listed[0]!.prompt, question);
      const decision = { questionId: listed[0]!.id, expectedVersion: listed[0]!.version, operationId: "e2e-answer-462", answer };
      // Without the host authorization the chat cannot answer on the operator's behalf.
      assert.equal((await chat.call("pirx_operator_decision", decision)).value.outcome, "authorization_required");
      const accepted = await chat.call("pirx_operator_decision", decision, { authorize: true });
      assert.equal(accepted.value.outcome, "accepted", JSON.stringify(accepted.value));
    });

    await fixture.waitFor("the resumed Attempt to push", () => fixture.results(issue.number)[1] === "CODE_PUSHED", daemon);
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));

    assert.deepEqual(fixture.results(issue.number), ["BLOCKED", "CODE_PUSHED"], fixture.describe(daemon));
    const calls = await fixture.claudeCalls();
    assert.deepEqual(calls.map((call) => call.mode), ["new", "resume"]);
    // The second Claude run received the operator's answer in its input.
    assert.ok(calls[1]!.prompt.includes(answer), "The resumed worker input does not contain the operator's answer.");
    const { attempts } = fixture.state(issue.number);
    assert.equal(await git(fixture.remote, "show", `refs/heads/${attempts[1]!.branch}:tracked.txt`), "repaired");
    await withChat(fixture, async (chat) => {
      assert.deepEqual((await chat.call("pirx_operator_questions", {})).value.questions, []);
    });
  } finally { await fixture.cleanup(); }
});

test("e2e: one queued Issue without the planning contract is skipped, the rest of the Queue runs, and the chat is told which Issue", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.addIssue({ number: 463, goal: "No template", criteria: [], body: "## Problem\n\nThis Issue has no Goal, Implementation scope or Acceptance criteria section." });
    fixture.queueOnProject(issue.number, 10);
    fixture.queueOnProject(463, 20);
    await fixture.planClaude([{ do: "commit" }]);

    const daemon = fixture.startDaemon();
    await fixture.waitFor("the valid Issue to push", () => fixture.results(issue.number)[0] === "CODE_PUSHED", daemon);
    const skippedEvent = daemon.events.find((event) => event.event === "queue" && event.outcome === "synchronized" && /e2e-fixture#463/u.test(JSON.stringify(event)));
    assert.ok(skippedEvent, "The queue event does not name the skipped Issue.");
    assert.match(JSON.stringify(skippedEvent), /Missing or empty section/u);

    await withChat(fixture, async (chat) => {
      const status = await chat.call("pirx_orchestrator_status", {});
      assert.equal(status.isError, false, JSON.stringify(status.value));
      assert.equal((status.value.snapshot as { lastQueueOutcome?: string }).lastQueueOutcome, "synchronized");
    });
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));
    assert.deepEqual(fixture.results(463), [], "A Task started for the Issue without the planning contract.");
  } finally { await fixture.cleanup(); }
});

test("e2e: a daemon restarted during the cooldown still resumes the Task after the reset", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.queueOnProject(issue.number, 10);
    await fixture.planClaude([{ do: "quota", resetInMs: 1_500 }, { do: "commit" }]);

    const first = fixture.startDaemon();
    await fixture.waitFor("the limit to be recorded", () => fixture.results(issue.number)[0] === "QUOTA_EXHAUSTED", first);
    assert.equal(await first.stop(), 0, fixture.describe(first));

    // Nothing but runtime.sqlite and the git worktree carries over to the new process.
    const second = fixture.startDaemon();
    await fixture.waitFor("the resumed Attempt to push", () => fixture.results(issue.number)[1] === "CODE_PUSHED", second);
    assert.equal(await second.stop(), 0, fixture.describe(second));
    assert.deepEqual(fixture.results(issue.number), ["QUOTA_EXHAUSTED", "CODE_PUSHED"], fixture.describe(second));
    assert.deepEqual((await fixture.claudeCalls()).map((call) => call.mode), ["new", "resume"]);
  } finally { await fixture.cleanup(); }
});

test("e2e: a limit reported only as text is still a cooldown, not a failed Task that restarts at once", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.queueOnProject(issue.number, 10);
    await fixture.planClaude([{ do: "quota_text", message: "You've hit your session limit \u00b7 resets 3pm (Europe/Warsaw)" }, { do: "commit" }]);

    const daemon = fixture.startDaemon();
    await fixture.waitFor("the limit to be recorded", () => fixture.results(issue.number)[0] === "QUOTA_EXHAUSTED", daemon);
    const recordedAt = Date.now();
    // Several more cycles pass: Claude must not be started again while the limit holds.
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));

    assert.deepEqual(fixture.results(issue.number), ["QUOTA_EXHAUSTED"], fixture.describe(daemon));
    assert.equal((await fixture.claudeCalls()).length, 1);
    const cooldownUntil = fixture.workerCooldownUntil();
    assert.ok(cooldownUntil !== undefined && Date.parse(cooldownUntil) > recordedAt, `No future cooldown was recorded: ${String(cooldownUntil)}`);
  } finally { await fixture.cleanup(); }
});

test("e2e: repeated worker failures stop automatic retries until the operator unblocks the Task from the chat", async () => {
  const fixture = await E2eFixture.create();
  try {
    fixture.addIssue(issue);
    fixture.queueOnProject(issue.number, 10);
    // The profile allows three failed resumes in a row: the first Attempt plus three resumes.
    const crash = { do: "crash", stderr: "fixture: tool crashed" } as const;
    await fixture.planClaude([crash, crash, crash, crash, { do: "commit" }]);

    const daemon = fixture.startDaemon();
    await fixture.waitFor("the Task to be blocked after repeated failures", () => fixture.state(issue.number).task?.state === "blocked", daemon);
    const failures = fixture.results(issue.number);
    assert.deepEqual(failures, ["FAILED", "FAILED", "FAILED", "FAILED"]);
    // Blocked means stopped: no further Claude run starts on its own.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal((await fixture.claudeCalls()).length, failures.length);

    await withChat(fixture, async (chat) => {
      const status = await chat.call("pirx_orchestrator_status", {});
      const attention = (status.value.snapshot as { attentionRequired?: { task: { issueNumber?: number }; nextAction: string } }).attentionRequired;
      assert.equal(attention?.task.issueNumber, issue.number, JSON.stringify(status.value));
      // The provider's own error text reaches the chat, not only a category.
      assert.match(JSON.stringify(status.value), /fixture: tool crashed/u);
      const unblock = { taskId: fixture.state(issue.number).task!.id, operationId: "e2e-unblock-462", reason: "The tool is fixed; try once more." };
      assert.equal((await chat.call("pirx_task_unblock", unblock)).value.outcome, "authorization_required");
      const accepted = await chat.call("pirx_task_unblock", unblock, { authorize: true });
      assert.equal(accepted.value.outcome, "unblocked", JSON.stringify(accepted.value));
    });

    await fixture.waitFor("the unblocked Attempt to push", () => fixture.results(issue.number).at(-1) === "CODE_PUSHED", daemon);
    assert.equal(await daemon.stop(), 0, fixture.describe(daemon));
    assert.equal(fixture.results(issue.number).length, failures.length + 1);
  } finally { await fixture.cleanup(); }
});
