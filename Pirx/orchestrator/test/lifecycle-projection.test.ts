import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  GitHubLifecycleProjectionPublisher,
  RuntimeSqliteStore,
  createTask,
  failure,
  type GitHubLifecycleCommentRequest,
  type GitHubLifecycleCommentResult,
  type GitHubIssueMutator,
  type GitHubOperationResult,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const taskId = "task-linkage-1" as TaskId;
const t0 = "2026-09-14T13:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T13:01:00.000Z" as UtcTimestamp;
const identity = {
  owner: "PiotrGry",
  repository: "ai-assistant",
  issueNumber: 65,
  nodeId: "I_kwDO-linkage-65",
  url: "https://github.com/PiotrGry/ai-assistant/issues/65",
};

function task() {
  const result = createTask({ id: taskId, goal: "Link runtime Task", scope: "Project Issue correlation", acceptanceCriteria: ["publish sanitized events"], priority: 1, risk: "low", requiredCapabilities: ["github"], createdAt: t0 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-linkage-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

class FakeMutator implements Pick<GitHubIssueMutator, "publishLifecycleComment"> {
  calls: GitHubLifecycleCommentRequest[] = [];
  mode: "success" | "failure" = "success";

  async publishLifecycleComment(request: GitHubLifecycleCommentRequest): Promise<GitHubOperationResult<GitHubLifecycleCommentResult>> {
    this.calls.push(request);
    if (this.mode === "failure") return failure("rate_limited", "rate_limited", "GitHub rate limit was reached.", request.correlationId ?? "test", "not_accepted");
    return {
      outcome: "success",
      value: { issue: { owner: identity.owner, repository: identity.repository, nodeId: identity.nodeId, number: typeof request.issue === "number" ? request.issue : request.issue.number, url: identity.url }, comment: { id: this.calls.length, url: `${identity.url}#issuecomment-${this.calls.length}` }, eventId: request.envelope.eventId, changed: true, noOp: false, idempotencyKey: request.idempotencyKey ?? "" },
      correlationId: request.correlationId ?? "test",
      remoteOutcome: "accepted",
    };
  }
}

function event(sequence: number, eventId = `event-${sequence}`) {
  return { eventId, taskId, sequence, eventType: "attempt_started", timestamp: t1, summary: "Attempt started safely", attemptId: "attempt-1", branch: "pirx/task-65", commit: "abc123" } as const;
}

test("persists canonical Issue linkage with both lookup directions and uniqueness", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    assert.equal(store.tasks.create(task()).outcome, "success");
    const linked = store.tasks.linkIssue(taskId, identity, t1);
    assert.equal(linked.outcome, "success");
    if (linked.outcome === "success") {
      assert.deepEqual(linked.value.githubReference, identity);
    }
    assert.equal(store.tasks.getByIssue(identity).outcome, "success");
    assert.equal(store.tasks.getByNodeId(identity.nodeId).outcome, "success");
    const second = createTask({ ...task(), id: "task-linkage-2" as TaskId });
    if (!second.ok) throw new Error(second.error.message);
    assert.equal(store.tasks.create(second.value).outcome, "success");
    assert.equal(store.tasks.linkIssue(second.value.id, identity, t1).outcome, "conflict");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("publishes only allowlisted sanitized events, deduplicates replay, and ignores out-of-order delivery", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  const mutator = new FakeMutator();
  try {
    assert.equal(store.tasks.create(task()).outcome, "success");
    assert.equal(store.tasks.linkIssue(taskId, identity, t1).outcome, "success");
    const publisher = new GitHubLifecycleProjectionPublisher(store, mutator, { owner: identity.owner, repository: identity.repository, now: () => t1 });
    const published = await publisher.publish(event(2));
    assert.equal(published.outcome, "published");
    assert.equal(mutator.calls.length, 1);
    assert.equal(mutator.calls[0]?.envelope.summary, "Attempt started safely");
    assert.equal(mutator.calls[0]?.envelope.branch, "pirx/task-65");
    assert.equal(mutator.calls[0]?.envelope.commit, "abc123");
    assert.equal((await publisher.publish(event(2))).outcome, "already_published");
    assert.equal(mutator.calls.length, 1);
    assert.equal((await publisher.publish(event(1))).outcome, "ignored");
    assert.equal(mutator.calls.length, 1);
    for (const [index, eventType] of [
      "task_accepted",
      "attempt_started",
      "attempt_result",
      "branch_prepared",
      "code_pushed",
      "blocked_human_action_required",
      "retry_cooldown",
      "task_completed",
    ].entries()) {
      assert.equal((await publisher.publish({ ...event(index + 10, `allowlisted-${index}`), eventType })).outcome, "published");
    }
    assert.equal((await publisher.publish({ ...event(3), summary: "token=do-not-publish" })).outcome, "invalid_event");
    assert.equal((await publisher.publish({ ...event(4), eventType: "future_event" })).outcome, "invalid_event");
    assert.equal(store.projections.listPending().outcome, "success");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("keeps missing-link and provider failures pending for restart reconciliation", async () => {
  const value = await fixture();
  let store = RuntimeSqliteStore.open({ filename: value.filename });
  const mutator = new FakeMutator();
  try {
    assert.equal(store.tasks.create(task()).outcome, "success");
    let publisher = new GitHubLifecycleProjectionPublisher(store, mutator, { owner: identity.owner, repository: identity.repository, now: () => t1 });
    assert.equal((await publisher.publish(event(1))).outcome, "missing_link");
    store.close();
    store = RuntimeSqliteStore.open({ filename: value.filename });
    publisher = new GitHubLifecycleProjectionPublisher(store, mutator, { owner: identity.owner, repository: identity.repository, now: () => t1 });
    const pending = store.projections.listPending();
    assert.equal(pending.outcome, "success");
    assert.equal(store.tasks.linkIssue(taskId, identity, t1).outcome, "success");
    assert.equal((await publisher.publish(event(2))).outcome, "published");
    assert.equal((await publisher.reconcilePending())[0]?.outcome, "ignored");

    mutator.mode = "failure";
    assert.equal((await publisher.publish(event(3))).outcome, "provider_error");
    assert.equal(store.projections.listPending().outcome, "success");
    mutator.mode = "success";
    assert.equal((await publisher.reconcilePending())[0]?.outcome, "published");
    assert.equal(mutator.calls.length, 3);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("blocks publication when a canonical link targets another repository", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  const mutator = new FakeMutator();
  try {
    assert.equal(store.tasks.create(task()).outcome, "success");
    assert.equal(store.tasks.linkIssue(taskId, identity, t1).outcome, "success");
    const publisher = new GitHubLifecycleProjectionPublisher(store, mutator, { owner: "other", repository: "repo", now: () => t1 });
    const result = await publisher.publish(event(1));
    assert.equal(result.outcome, "conflict");
    assert.equal(mutator.calls.length, 0);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
